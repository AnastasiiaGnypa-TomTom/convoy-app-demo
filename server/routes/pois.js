/**
 * POI layers — /api/pois
 *
 * Hard guarantees, in increasing order of strength:
 *
 *  1. NO FREE TEXT. Layers are populated by category id with NO query parameter at
 *     all. Free-text search exists only for the user typing a place name, and lives
 *     in routes/geocode.js. It is never used to populate a layer — that was the
 *     cause of the original false positives.
 *
 *  2. BUILD-TIME ALLOWLIST. The only category ids ever sent are those proven by
 *     `npm run verify:pois` into server/data/poi-categories.verified.json. Nothing
 *     is derived from layer display names at runtime.
 *
 *  3. RUNTIME ASSERTION. Every result's own classification code must be inside the
 *     layer's verified allowlist, or it is dropped and counted. This is the
 *     guarantee that actually holds, because it validates what came BACK rather
 *     than what was asked for — which matters here specifically: TomTom silently
 *     ignores unknown query parameters instead of erroring, so a request-side
 *     filter alone cannot be trusted.
 *
 *  4. NO APPROXIMATION. A layer with no verified source is never populated from a
 *     loosely-related category. It reports "no data source connected".
 */

import { Router } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCache } from '../lib/cache.js';
import { VendorError, tomtomFetch, tomtomJson, tomtomUrl } from '../lib/tomtom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFIED_FILE = join(HERE, '..', 'data', 'poi-categories.verified.json');

export const poisRouter = Router();

/* -------------------------------------------------------------------- config */

/**
 * Per-layer result cap.
 *
 * VIEWPORT is higher than ALONG_ROUTE and costs nothing extra: each nearbySearch already
 * asks for limit=100, so the results were fetched and then thrown away. Discarding half
 * of them made cities look sparse for no saving. The route corridor stays at 50 because
 * there the cap is spread across many samples, and 50 well-distributed POIs read better
 * on a long route than 100 crowding the map.
 */
const LAYER_CAP_VIEWPORT = 100;
const LAYER_CAP_ALONG_ROUTE = 50;
const LAYER_CAP = LAYER_CAP_ALONG_ROUTE;
/**
 * Default convoy corridor: 5 miles either side of the route.
 *
 * Not "along the route" in the narrow sense — a convoy planner cares about what is
 * reachable near the path (fuel, hospitals, rest areas), not only what is on the
 * verge of it.
 */
const DEFAULT_CORRIDOR_KM = 8.05; // 5 miles

/**
 * searchAlongRoute takes maxDetourTime (seconds) and has no distance parameter, so a
 * corridor WIDTH cannot be requested directly. Converted at a nominal 45 km/h and
 * doubled for the there-and-back deviation.
 *
 * The multiplier is deliberately generous: detour time is a poor proxy for distance
 * (a POI 8 km away on a motorway is a short detour; the same distance on lanes is a
 * long one), so asking for a wider time budget than needed and then filtering by REAL
 * distance to the route beats trusting the time alone. Without the filter, "within 5
 * miles" would be a guess.
 */
/**
 * Kept only for reporting. searchAlongRoute is NOT used for the corridor any more —
 * measured, it returns 11-15 results no matter what `limit` asks for, and its
 * maxDetourTime caps at 3600 s (a 16 km corridor 400s outright). It is an "on my way"
 * service, not a corridor sweep, so it can never answer "everything within 5 miles".
 */
const corridorKmToDetourSeconds = (km) => Math.min(3600, Math.round((km / 45) * 3600 * 2));

/** Sample points along the route, roughly `everyM` apart, capped at `max`. */
function sampleRoute(points, { everyM, max }) {
  const mPerLon = (lat) => Math.cos((lat * Math.PI) / 180) * 111320;
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = (points[i].lon - points[i - 1].lon) * mPerLon(points[i].lat);
    const dy = (points[i].lat - points[i - 1].lat) * 110540;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  const total = cum[cum.length - 1];
  if (!(total > 0)) return [points[0]];

  const n = Math.min(max, Math.max(1, Math.ceil(total / everyM)));
  const out = [];
  for (let k = 0; k < n; k++) {
    // Offset by half a step so samples sit in the middle of their stretch.
    const d = total * ((k + 0.5) / n);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    out.push({
      lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * t,
      lon: points[i - 1].lon + (points[i].lon - points[i - 1].lon) * t,
    });
  }
  return { samples: out, totalM: total, spacingM: total / n };
}

/** Metres from a point to a polyline, in a local planar approximation. */
function metresToPolyline([lon, lat], points) {
  const mPerLon = Math.cos((lat * Math.PI) / 180) * 111320;
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const ax = (points[i - 1].lon - lon) * mPerLon;
    const ay = (points[i - 1].lat - lat) * 110540;
    const bx = (points[i].lon - lon) * mPerLon;
    const by = (points[i].lat - lat) * 110540;
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2)) : 0;
    const px = ax + vx * t;
    const py = ay + vy * t;
    const d2 = px * px + py * py;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

const MAX_RADIUS_M = 50_000;
/*
 * Raised from 3. With every layer switched on that was 13 queries in five sequential
 * rounds, which is most of the delay after a pan; the retry-on-429 path already handles
 * the rate limit if this proves too eager.
 */
const CONCURRENCY = 6;
const RETRY_DELAYS_MS = [400, 1100, 2400];

const poiCache = createCache({ ttlMs: 5 * 60_000 });

/* ------------------------------------------------------- verified allowlist */

let VERIFIED = null;

function loadVerified() {
  if (VERIFIED) return VERIFIED;
  if (!existsSync(VERIFIED_FILE)) {
    console.error(
      '[pois] server/data/poi-categories.verified.json is missing — run `npm run verify:pois`. ' +
        'Every layer will report "no data source connected" until then (never a text-search fallback).',
    );
    VERIFIED = { layers: {}, noSourceLayers: {}, missing: true };
    return VERIFIED;
  }
  VERIFIED = JSON.parse(readFileSync(VERIFIED_FILE, 'utf8'));
  const sourced = Object.values(VERIFIED.layers || {}).filter((l) => l.hasSource).length;
  console.log(
    `[pois] verified allowlist: ${sourced} sourced layer(s), ` +
      `${Object.keys(VERIFIED.noSourceLayers || {}).length} no-source, ` +
      `${(VERIFIED.dropped || []).length} dropped code(s)`,
  );
  return VERIFIED;
}
loadVerified();

const sourcedLayer = (id) => {
  const l = loadVerified().layers?.[id];
  return l && l.hasSource ? l : null;
};

/* ---------------------------------------------------------------- metadata */

poisRouter.get('/layers', (_req, res) => {
  const v = loadVerified();
  res.set('cache-control', 'public, max-age=300');

  const layers = Object.entries(v.layers || {}).map(([id, l]) => ({
    id,
    label: l.label,
    color: l.color,
    glyph: l.glyph,
    defaultOn: Boolean(l.defaultOn),
    hasSource: Boolean(l.hasSource),
    lowerConfidence: Boolean(l.lowerConfidence),
    caveat: l.caveat || null,
    // The real category codes, exposed so the UI shows what a layer truly contains.
    allowedCodes: l.allowedCodes || [],
    assertBy: l.assertBy || 'code',
    allowedCategoryIds: l.allowedCategoryIds || [],
    reason: l.hasSource ? null : 'No TomTom category passed build-time verification.',
  }));

  /*
   * Layers with no data source are NOT sent in `layers`, so the UI never renders a
   * row for something that can never populate. They are still reported under
   * `unavailable` — the declarations and reasons stay in lib/poiAllowlist.js as the
   * seam for HIFLD / OSM / curated GeoJSON, so nobody has to rediscover why each one
   * is absent, and nobody re-adds it by borrowing a loosely-related category.
   */
  const unavailable = [
    ...Object.entries(v.noSourceLayers || {}).map(([id, l]) => ({
      id,
      label: l.label,
      reason: l.reason,
    })),
    ...layers.filter((l) => !l.hasSource).map((l) => ({ id: l.id, label: l.label, reason: l.reason })),
  ];

  res.json({
    layers: layers.filter((l) => l.hasSource),
    unavailable,
    verifiedAt: v.generatedAt || null,
    droppedCodes: v.dropped || [],
    corridorKmDefault: DEFAULT_CORRIDOR_KM,
    layerCap: LAYER_CAP,
    needsVerification: Boolean(v.missing),
  });
});

/* ----------------------------------------------------------------- helpers */

async function withRateLimitRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const limited = err instanceof VendorError && err.vendorStatus === 429;
      if (!limited || attempt >= RETRY_DELAYS_MS.length) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] + Math.random() * 250));
    }
  }
}

async function pooled(tasks, limit = CONCURRENCY) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        try {
          out[i] = { status: 'fulfilled', value: await tasks[i]() };
        } catch (err) {
          out[i] = { status: 'rejected', reason: err };
        }
      }
    }),
  );
  return out;
}

const codesOf = (r) => (r.poi?.classifications || []).map((c) => c.code).filter(Boolean);
const categoryIdsOf = (r) => (r.poi?.categorySet || []).map((c) => c.id).filter((n) => n != null);

/**
 * THE ASSERTION.
 *
 * A result enters a layer only if one of its own classification codes is in that
 * layer's verified allowlist. Everything else is dropped and recorded, so a
 * violation is visible in the response and the log rather than silently on the map.
 */
function assertInLayer(result, layer, layerId, violations) {
  /*
   * Two assertion modes.
   *
   * Default: the result's classification code must be in the layer's allowlist.
   *
   * `categoryId`: the result must carry one of the layer's verified category ids.
   * Used only where TomTom's classification is demonstrably wrong — the military
   * layer, whose entries are all mis-classified SCHOOL. Asserting on the id is not a
   * weakening: the id is what performed the filtering, and the build step proved
   * every result carries it. Allowlisting SCHOOL instead would admit real schools.
   */
  if (layer.assertBy === 'categoryId') {
    const ids = categoryIdsOf(result);
    const allowed = layer.allowedCategoryIds || [];
    if (ids.some((id) => allowed.includes(id))) return codesOf(result)[0] || 'UNCLASSIFIED';
    violations.push({
      layer: layerId,
      name: result.poi?.name || '(unnamed)',
      codes: [`ids:${ids.join('/') || 'none'}`],
    });
    return null;
  }

  const codes = codesOf(result);
  const hit = codes.find((c) => layer.allowedCodes.includes(c));
  if (hit) return hit;
  violations.push({ layer: layerId, name: result.poi?.name || '(unnamed)', codes });
  return null;
}

function toFeature(r, layerId, code) {
  const a = r.address || {};
  return {
    type: 'Feature',
    id: r.id,
    geometry: { type: 'Point', coordinates: [r.position.lon, r.position.lat] },
    properties: {
      layer: layerId,
      name: r.poi?.name || a.freeformAddress || 'Unnamed',
      // The REAL TomTom classification — never a mapped or friendly relabel.
      tomtomCategory: code,
      tomtomCategories: codesOf(r),
      tomtomCategoryIds: categoryIdsOf(r),
      address: a.freeformAddress || null,
      detourSeconds: r.detourTime ?? null,
    },
  };
}

/** Split requested layers into those with a verified source and those without. */
function partitionLayers(raw) {
  const v = loadVerified();
  const requested = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const queryable = [];
  const noSource = [];
  for (const id of requested) {
    if (sourcedLayer(id)) queryable.push(id);
    else if (v.layers?.[id] || v.noSourceLayers?.[id]) noSource.push(id);
  }
  return { queryable, noSource };
}

function summarise({ features, perLayer, violations, noSource, extra = {} }) {
  if (violations.length) {
    const byLayer = {};
    for (const x of violations) byLayer[x.layer] = (byLayer[x.layer] || 0) + 1;
    console.warn(
      '[pois] ASSERTION dropped out-of-category results:',
      Object.entries(byLayer)
        .map(([l, n]) => `${l}=${n}`)
        .join(' '),
      '| sample:',
      violations
        .slice(0, 3)
        .map((x) => `${x.name}[${x.codes.join('/')}]`)
        .join(', '),
    );
  }
  return {
    type: 'FeatureCollection',
    features,
    perLayer,
    capped: Object.entries(perLayer)
      .filter(([, n]) => n >= (extra?.mode === 'along-route' ? LAYER_CAP_ALONG_ROUTE : LAYER_CAP_VIEWPORT))
      .map(([id]) => id),
    droppedOutOfCategory: violations.length,
    noSourceRequested: noSource,
    ...extra,
  };
}

/* -------------------------------------------------- viewport category browse */

poisRouter.get('/', async (req, res, next) => {
  const parts = String(req.query.bbox || '')
    .split(',')
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'bbox must be minLon,minLat,maxLon,maxLat' });
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (maxLon <= minLon || maxLat <= minLat) {
    return res.status(400).json({ error: 'bbox is inverted or empty' });
  }

  const { queryable, noSource } = partitionLayers(req.query.layers);
  if (!queryable.length) {
    return res.json(summarise({ features: [], perLayer: {}, violations: [], noSource }));
  }

  const key = `browse|${parts.map((n) => n.toFixed(3)).join(',')}|${queryable.slice().sort().join(',')}`;
  const cached = poiCache.get(key);
  if (cached) {
    res.set('x-cache', 'hit');
    return res.json(cached);
  }

  const lat = (minLat + maxLat) / 2;
  const lon = (minLon + maxLon) / 2;
  const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const halfW = ((maxLon - minLon) * mPerDegLon) / 2;
  const halfH = ((maxLat - minLat) * 111_320) / 2;
/*
 * The LONGER half-axis, not the circumradius.
 *
 * hypot(halfW, halfH) is the circumradius, so the search circle covers about 1.8x the
 * area of the box and TomTom spends its 100-result budget mostly on ground that is off
 * screen — measured, only 19 of 71 loaded POIs were visible in a city view. Using the
 * longer half-axis concentrates the same budget on roughly 1.3x the box instead, so
 * more of what is fetched is actually in front of the user. The box the client sends is
 * already padded 25% beyond the visible window, which is what covers the corners this
 * gives up.
 */
  const radius = Math.min(MAX_RADIUS_M, Math.max(1000, Math.round(Math.max(halfW, halfH))));

  try {
    const settled = await pooled(
      queryable.map((id) => async () => {
        const layer = sourcedLayer(id);
        const json = await withRateLimitRetry(() =>
          tomtomJson(
            // Category browse: categorySet only. No `query` parameter is sent.
            tomtomUrl('/search/2/nearbySearch/.json', {
              lat,
              lon,
              radius,
              categorySet: layer.categorySet.join(','),
              limit: 100,
            }),
            { timeoutMs: 12_000 },
          ),
        );
        return { id, results: json.results || [] };
      }),
    );

    const features = [];
    const perLayer = {};
    const violations = [];
    const seen = new Set();
    for (const id of queryable) perLayer[id] = 0;

    for (let i = 0; i < settled.length; i++) {
      const id = queryable[i];
      if (settled[i].status !== 'fulfilled') {
        console.warn(`[pois] browse ${id} failed:`, settled[i].reason?.message);
        continue;
      }
      const layer = sourcedLayer(id);
      for (const r of settled[i].value.results) {
        if (!r.position) continue;
        if (perLayer[id] >= LAYER_CAP_VIEWPORT) break;
        /*
         * Deliberately NOT clamped to the bbox.
         *
         * `radius` is the bbox's circumradius, so the search circle extends past the
         * rectangle's edges. Discarding everything outside the rectangle threw away
         * roughly 40% of the 100-result budget TomTom had already returned and charged
         * for, which is a large part of why cities looked sparse. Those extra POIs sit
         * just off screen, which is exactly what the client's padding ring is for — they
         * are on screen the moment you pan, with no new request.
         */
        const code = assertInLayer(r, layer, id, violations);
        if (!code) continue;
        const dedupe = r.id || `${pLon.toFixed(5)},${pLat.toFixed(5)}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        features.push(toFeature(r, id, code));
        perLayer[id]++;
      }
    }

    const payload = summarise({
      features,
      perLayer,
      violations,
      noSource,
      extra: { mode: 'viewport' },
    });
    poiCache.set(key, payload);
    res.set('x-cache', 'miss');
    return res.json(payload);
  } catch (err) {
    if (err instanceof VendorError) {
      console.warn('[pois] browse unavailable:', err.message);
      return res.json(
        summarise({
          features: [],
          perLayer: {},
          violations: [],
          noSource,
          extra: { note: 'TomTom unavailable' },
        }),
      );
    }
    return next(err);
  }
});

/* ------------------------------------------------------- search along route */

poisRouter.post('/along-route', async (req, res, next) => {
  const { route, layers, corridorKm } = req.body || {};
  if (!Array.isArray(route) || route.length < 2) {
    return res.status(400).json({ error: 'route must be an array of at least 2 {lat, lon} points' });
  }

  const { queryable, noSource } = partitionLayers(
    Array.isArray(layers) ? layers.join(',') : layers,
  );
  if (!queryable.length) {
    return res.json(summarise({ features: [], perLayer: {}, violations: [], noSource }));
  }

  const km = Math.min(50, Math.max(0.5, Number(corridorKm) || DEFAULT_CORRIDOR_KM));

  /*
   * Thin the route to at most 120 supporting points: a full geometry is rejected as
   * "Malformed route". Points must be {lat, lon} — {latitude, longitude} is also
   * rejected as malformed, verified 2026-07-30.
   */
  const MAX_POINTS = 120;
  const step = Math.max(1, Math.ceil(route.length / MAX_POINTS));
  const points = route
    .filter((_, i) => i % step === 0)
    .map((p) => ({ lat: Number(p.lat), lon: Number(p.lon) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  if (points.length < 2) {
    return res.status(400).json({ error: 'route contained no usable coordinates' });
  }
  /*
   * A radius sweep along the route, not searchAlongRoute.
   *
   * The corridor is a DISTANCE band ("within 5 miles of the route"), and nearbySearch
   * is the only TomTom search that takes a radius. So the route is sampled and a radius
   * query is run at each sample; results are deduped and then filtered by true distance
   * to the polyline, which is what makes the stated band exact rather than approximate.
   *
   * Sample spacing is 1.5x the radius so consecutive circles overlap and leave no gap
   * in the band. MAX_SAMPLES bounds the vendor traffic on a long route; because the
   * per-layer cap is LAYER_CAP anyway, more samples would mostly find POIs we then
   * discard. Where sampling had to be coarser than ideal it is reported, not hidden.
   */
  const radius = Math.min(MAX_RADIUS_M, Math.round(km * 1000));
  const MAX_SAMPLES = 18;
  const sampled = sampleRoute(points, { everyM: radius * 1.5, max: MAX_SAMPLES });
  const samples = sampled.samples || [points[0]];
  const gapped = sampled.spacingM > radius * 1.6;

  try {
    const settled = await pooled(
      // One query per (layer, sample). Flattened so the pool bounds all of them.
      queryable.flatMap((id) =>
        samples.map((pt, sampleIndex) => async () => {
          const layer = sourcedLayer(id);
          const json = await withRateLimitRetry(() =>
            tomtomJson(
              tomtomUrl('/search/2/nearbySearch/.json', {
                lat: pt.lat,
                lon: pt.lon,
                radius,
                categorySet: layer.categorySet.join(','),
                limit: 100,
              }),
              { timeoutMs: 12_000 },
            ),
          );
          return { id, sampleIndex, results: json.results || [] };
        }),
      ),
      CONCURRENCY,
    );

    const features = [];
    const perLayer = {};
    const violations = [];
    const seen = new Set();
    for (const id of queryable) perLayer[id] = 0;

    /*
     * Interleave the samples; do not drain them in order.
     *
     * This is what stopped the POIs bunching at one end of the route. Each sample
     * returns up to 100 results, so processing them sequentially let the FIRST sample
     * fill the entire per-layer cap and then `break` — on Amsterdam to Utrecht all 50
     * fuel stations came from the Amsterdam end and the rest of the route looked empty.
     *
     * Taking one result from each sample in turn spends the cap evenly along the route,
     * which is what a corridor is supposed to mean. Within a sample TomTom already
     * orders by distance, so the nearest to each stretch win.
     */
    const bySample = new Map(); // layerId -> results indexed by sampleIndex
    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') {
        console.warn('[pois] along-route sample failed:', outcome.reason?.message);
        continue;
      }
      const { id, sampleIndex, results } = outcome.value;
      if (!bySample.has(id)) bySample.set(id, []);
      bySample.get(id)[sampleIndex] = results;
    }

    for (const [id, perSample] of bySample) {
      const layer = sourcedLayer(id);
      const cursors = perSample.map(() => 0);
      let progressed = true;

      while (perLayer[id] < LAYER_CAP && progressed) {
        progressed = false;
        for (let si = 0; si < perSample.length && perLayer[id] < LAYER_CAP; si++) {
          const list = perSample[si];
          if (!list) continue;

          // Advance this sample's cursor to its next usable result, then move on.
          while (cursors[si] < list.length) {
            const r = list[cursors[si]++];
            if (!r?.position) continue;
            // The corridor is enforced by REAL distance to the route, which is what
            // makes the stated band exact rather than a by-product of the circles.
            if (metresToPolyline([r.position.lon, r.position.lat], points) > km * 1000) continue;
            const code = assertInLayer(r, layer, id, violations);
            if (!code) continue;
            const dedupe = r.id || `${r.position.lon.toFixed(5)},${r.position.lat.toFixed(5)}`;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            features.push(toFeature(r, id, code));
            perLayer[id]++;
            progressed = true;
            break;
          }
        }
      }
    }

    return res.json(
      summarise({
        features,
        perLayer,
        violations,
        noSource,
        extra: {
          mode: 'along-route',
          corridorKm: km,
          corridorMiles: Math.round((km / 1.609) * 10) / 10,
          samples: samples.length,
          // True when the route was long enough that circles could not fully overlap.
          sampledWithGaps: gapped,
        },
      }),
    );
  } catch (err) {
    if (err instanceof VendorError) {
      console.warn('[pois] along-route unavailable:', err.message);
      return res.json(
        summarise({
          features: [],
          perLayer: {},
          violations: [],
          noSource,
          extra: { note: 'TomTom unavailable' },
        }),
      );
    }
    return next(err);
  }
});
