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

/** Per-layer result cap. */
const LAYER_CAP = 50;
/** Default convoy corridor width. */
const DEFAULT_CORRIDOR_KM = 5;
/**
 * searchAlongRoute takes maxDetourTime (seconds), not a corridor width — there is
 * no distance parameter. Converted at a nominal 45 km/h and doubled for the
 * there-and-back deviation. Approximate by nature, so it is documented rather than
 * presented as an exact corridor.
 */
const corridorKmToDetourSeconds = (km) => Math.round((km / 45) * 3600 * 2);

const MAX_RADIUS_M = 50_000;
const CONCURRENCY = 3;
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
      .filter(([, n]) => n >= LAYER_CAP)
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
  const radius = Math.min(MAX_RADIUS_M, Math.max(1000, Math.round(Math.hypot(halfW, halfH))));

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
        if (perLayer[id] >= LAYER_CAP) break;
        const { lat: pLat, lon: pLon } = r.position;
        if (pLon < minLon || pLon > maxLon || pLat < minLat || pLat > maxLat) continue;
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
  const maxDetourTime = corridorKmToDetourSeconds(km);

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
  const body = JSON.stringify({ route: { points } });

  try {
    const settled = await pooled(
      queryable.map((id) => async () => {
        const layer = sourcedLayer(id);
        const url = tomtomUrl('/search/2/searchAlongRoute/.json', {
          maxDetourTime,
          categorySet: layer.categorySet.join(','),
          limit: 100,
        });
        const json = await withRateLimitRetry(async () => {
          const r = await tomtomFetch(url, {
            timeoutMs: 15_000,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
          if (!r.ok) {
            const text = (await r.text()).replace(/\s+/g, ' ').slice(0, 160);
            throw new VendorError(`searchAlongRoute HTTP ${r.status}: ${text}`, {
              status: 502,
              vendorStatus: r.status,
            });
          }
          return r.json();
        });
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
        console.warn(`[pois] along-route ${id} failed:`, settled[i].reason?.message);
        continue;
      }
      const layer = sourcedLayer(id);
      for (const r of settled[i].value.results) {
        if (!r.position) continue;
        if (perLayer[id] >= LAYER_CAP) break;
        const code = assertInLayer(r, layer, id, violations);
        if (!code) continue;
        const dedupe = r.id || `${r.position.lon.toFixed(5)},${r.position.lat.toFixed(5)}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        features.push(toFeature(r, id, code));
        perLayer[id]++;
      }
    }

    return res.json(
      summarise({
        features,
        perLayer,
        violations,
        noSource,
        extra: { mode: 'along-route', corridorKm: km, maxDetourTime },
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
