/**
 * Vantor imagery — /api/imagery
 *
 * Proxies Vantor WMTS tiles so the browser can use them as a plain MapLibre
 * raster source while the API key stays server-side.
 */

import { Router } from 'express';
import { createCache } from '../lib/cache.js';
import {
  DEFAULT_IMAGERY_MODE,
  IMAGERY,
  IMAGERY_MAX_ZOOM,
  IMAGERY_MODES,
  VantorError,
  fetchImageryProvenance,
  fetchImageryTile,
  hasVantorKey,
  resolveImageryMode,
} from '../lib/vantor.js';

export const imageryRouter = Router();

/** Only known mode ids reach the vendor adapter. */
const isMode = (id) => Object.prototype.hasOwnProperty.call(IMAGERY_MODES, id);

/** The mode with no CQL filter — the always-available fallback target. */
const UNFILTERED_MODE =
  Object.values(IMAGERY_MODES).find((m) => !m.cqlFilter)?.id || DEFAULT_IMAGERY_MODE;

/**
 * Is this the vendor's "matched nothing" tile?
 *
 * OGC services answer a no-match with HTTP 200 and a near-empty PNG rather than an
 * error. Measured signatures on this Hub: ~1,670 B for a 256 px tile, ~5,622 B at
 * 512 px. Real satellite tiles here run 100–200 KB, so the gap is wide and a byte
 * threshold is a reliable discriminator.
 */
const BLANK_TILE_MAX_BYTES = 8000;
const isBlankTile = (buffer) => !buffer || buffer.length < BLANK_TILE_MAX_BYTES;

/* -------------------------------------------------------------------------- */
/*  Per-IP tile rate limit                                                    */
/*                                                                            */
/*  Not a cost control on the operator — the ceiling is deliberately far above  */
/*  what any human panning a map can reach. It exists so a crawler or a runaway */
/*  script hitting the public URL cannot stream imagery unbounded.             */
/*                                                                            */
/*  A full screen of 256 px tiles at one zoom is roughly 30–40 requests, so a    */
/*  fast demo session might burst a few hundred a minute. 1,200/min leaves        */
/*  ample headroom while still stopping automated abuse.                        */
/* -------------------------------------------------------------------------- */
const RATE_LIMIT_PER_MIN = Number(process.env.IMAGERY_RATE_LIMIT_PER_MIN || 1200);
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();

function rateLimited(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    // Opportunistic cleanup so the map cannot grow without bound.
    if (rateBuckets.size > 5000) {
      for (const [k, v] of rateBuckets) {
        if (now - v.start >= RATE_WINDOW_MS) rateBuckets.delete(k);
      }
    }
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_LIMIT_PER_MIN;
}

/** Source definitions for MapLibre, so the client hard-codes no vendor detail. */
imageryRouter.get('/meta', (_req, res) => {
  res.set('cache-control', 'public, max-age=3600');

  // One raster source per mode. The client keeps both and toggles visibility, so
  // switching mode mid-demo is instant and hidden layers cost no tile requests.
  const sourceFor = (modeId) => ({
    type: 'raster',
    tiles: [`/api/imagery/${modeId}/{z}/{x}/{y}.png`],
    /*
     * The grid's LOGICAL tile size (256), not the 512px image size. EPSG:3857x2 is
     * @2x on the same grid — declaring 512 made MapLibre stretch every tile 2x.
     */
    tileSize: IMAGERY.tileSize,
    minzoom: IMAGERY.minzoom,
    // The cost guard, advertised to MapLibre so it stops requesting deeper tiles
    // and upsamples instead. Also enforced below for crafted requests.
    maxzoom: IMAGERY.maxzoom,
    attribution: IMAGERY.attribution,
  });

  res.json({
    available: hasVantorKey(),
    vendor: 'vantor-maxar',
    layer: IMAGERY.layer,
    defaultMode: DEFAULT_IMAGERY_MODE,
    /*
     * BACKWARD COMPATIBILITY — do not remove.
     *
     * `modes` replaced a single `source` field when the seamless/latest toggle was
     * added. A browser holding a cached copy of the older bundle reads `source`,
     * gets undefined, and silently never creates the imagery layer — which looks
     * exactly like "the imagery toggle does nothing". Keeping this alias means a
     * stale client still renders imagery.
     */
    source: {
      type: 'raster',
      tiles: [`/api/imagery/${DEFAULT_IMAGERY_MODE}/{z}/{x}/{y}.png`],
      tileSize: 256,
      minzoom: IMAGERY.minzoom,
      maxzoom: IMAGERY.maxzoom,
      attribution: IMAGERY.attribution,
    },
    modes: Object.values(IMAGERY_MODES).map((m) => ({
      id: m.id,
      label: m.label,
      kind: m.kind,
      detail: m.detail,
      productName: m.productName,
      source: sourceFor(m.id),
    })),
    resolution: {
      clientTileSize: IMAGERY.tileSize,
      vendorTilePixels: IMAGERY.tilePixelSize,
      tileMatrixSet: IMAGERY.tileMatrixSet,
      nativeMaxZoom: IMAGERY.nativeMaxZoom,
      note:
        `${IMAGERY.tilePixelSize}px @2x images on the ${IMAGERY.tileSize}px logical grid ` +
        `via ${IMAGERY.tileMatrixSet}. Genuine detail ` +
        `ends at z${IMAGERY.nativeMaxZoom}; beyond that MapLibre overzooms real tiles ` +
        'rather than fetching upscaled ones.',
    },
    costGuard: {
      maxZoom: IMAGERY_MAX_ZOOM,
      serviceMaxZoom: IMAGERY.serviceMaxZoom,
      note:
        `Imagery streams to zoom ${IMAGERY_MAX_ZOOM}. Vantor bills streaming above ` +
        'zoom 14, so set IMAGERY_MAX_ZOOM=14 in the environment to restrict it. ' +
        `Beyond the cap the z${IMAGERY_MAX_ZOOM} tile is upsampled rather than fetched.`,
    },
  });
});

/* ------------------------------------------------------------- provenance */

// Provenance changes only when the view moves to different imagery; a short TTL
// keeps panning from costing a WFS call each time.
const provenanceCache = createCache({ ttlMs: 5 * 60_000 });

/**
 * What imagery is actually on screen — newest streamed capture over a bbox.
 * Answers "how current is this imagery?" honestly, from the streaming layer's
 * own metadata rather than the orderable archive.
 */
imageryRouter.get('/provenance', async (req, res) => {
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
  if (!hasVantorKey()) {
    return res.status(503).json({ error: 'imagery not configured' });
  }

  const requestedMode = isMode(req.query.mode) ? String(req.query.mode) : DEFAULT_IMAGERY_MODE;

  // Mode is part of the cache identity — the two modes describe different imagery.
  const key = `${requestedMode}|${parts.map((n) => n.toFixed(3)).join(',')}`;
  const cached = provenanceCache.get(key);
  if (cached) {
    res.set('x-cache', 'hit');
    return res.json(cached);
  }

  try {
    const payload = await fetchImageryProvenance(
      [minLon, minLat, maxLon, maxLat],
      requestedMode,
    );
    provenanceCache.set(key, payload);
    res.set('x-cache', 'miss');
    res.set('cache-control', 'public, max-age=300');
    return res.json(payload);
  } catch (err) {
    // Provenance is a readout, not core function: degrade rather than surfacing
    // an error over a working imagery layer.
    console.warn('[imagery] provenance unavailable:', err.message);
    return res.json({
      requestedMode,
      effectiveMode: requestedMode,
      fellBack: false,
      provenance: null,
      note: 'provenance unavailable',
    });
  }
});

/*
 * Legacy tile path, kept for backward compatibility.
 *
 * Tile URLs gained a /:mode segment when the seamless/latest modes were added. A
 * browser holding a cached copy of the older bundle would otherwise request this
 * shape and get a 404 for every tile — which looks exactly like "the imagery
 * toggle does nothing". Serving the default mode here means a stale client keeps
 * working instead of failing silently.
 *
 * Three path segments, so it cannot shadow the four-segment /:mode/:z/:x/:y route.
 */
imageryRouter.get('/:z/:x/:y.png', (req, res, next) => {
  req.params.mode = DEFAULT_IMAGERY_MODE;
  return serveTile(req, res, next);
});

imageryRouter.get('/:mode/:z/:x/:y.png', (req, res, next) => serveTile(req, res, next));

async function serveTile(req, res) {
  const mode = req.params.mode;
  if (!isMode(mode)) {
    return res.status(400).json({ error: `unknown imagery mode "${mode}"` });
  }
  if (rateLimited(req)) {
    res.set('retry-after', '60');
    return res.status(429).json({ error: 'tile rate limit exceeded' });
  }

  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);

  // Reject nonsense before spending a vendor call on it.
  const max = 2 ** z;
  if (!Number.isInteger(z) || z < 0) {
    return res.status(400).json({ error: 'invalid zoom' });
  }
  /*
   * Zoom ceiling, enforced server-side as well as client-side.
   *
   * MapLibre already stops at the source maxzoom, so in normal use this never
   * fires. It exists because the endpoint is public and unauthenticated: without
   * it, a crafted request could stream deeper than the configured ceiling.
   * Configure with IMAGERY_MAX_ZOOM — see lib/vantor.js for the cost note.
   */
  // Past the vendor's deepest level there is nothing to fetch. Not a cost limit.
  if (z > IMAGERY_MAX_ZOOM) {
    return res.status(404).end();
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= max || y >= max) {
    return res.status(400).json({ error: 'tile out of range for zoom' });
  }

  try {
    /*
     * `date` selects one temporal capture. Passed through from the time control, so
     * moving the slider genuinely re-renders the imagery rather than relabelling it.
     */
    const captureDate = typeof req.query.date === 'string' ? req.query.date : null;
    let { buffer, contentType } = await fetchImageryTile({ z, x, y }, mode, { captureDate });
    let servedMode = mode;

    /*
     * NEVER RENDER BLANK — a hard guarantee, not best-effort.
     *
     * A filtered request that matches no imagery returns HTTP 200 with a tiny
     * "empty" PNG (~1.7 KB at 256 px) rather than an error, so a pinned-product
     * mode can leave holes in the overlay. In a live demo that reads as a broken
     * app. If a filtered tile comes back blank, retry unfiltered and serve that.
     *
     * Only filtered modes can fall back: an unfiltered blank tile is genuinely
     * outside all coverage, and there is nothing further to try.
     */
    /*
     * The never-blank fallback applies to MODE filters only, never to a pinned
     * capture date.
     *
     * A date-pinned tile that comes back blank means "this capture does not cover
     * this tile" — substituting imagery from another date would silently break the
     * contract the time control makes with the user, which is the one thing a
     * change-detection workflow cannot tolerate. The tile stays blank and the header
     * below tells the client, which surfaces it as "no coverage for this capture".
     */
    if (isBlankTile(buffer) && !captureDate && resolveImageryMode(mode).cqlFilter) {
      const retry = await fetchImageryTile({ z, x, y }, UNFILTERED_MODE);
      if (!isBlankTile(retry.buffer)) {
        buffer = retry.buffer;
        contentType = retry.contentType;
        servedMode = UNFILTERED_MODE;
        console.warn(`[imagery] ${mode} blank at z${z}/${x}/${y} → served ${UNFILTERED_MODE}`);
      }
    }

    res.set('content-type', contentType);
    // Lets a client show an honest readout when the tile is not the mode requested.
    res.set('x-imagery-mode', servedMode);
    if (servedMode !== mode) res.set('x-imagery-fallback', 'true');
    // Lets the UI distinguish "no imagery for the selected capture here" from an error.
    if (captureDate) {
      res.set('x-imagery-capture', captureDate);
      if (isBlankTile(buffer)) res.set('x-imagery-capture-empty', 'true');
    }
    // Archive imagery is effectively static; cache hard to keep panning smooth.
    res.set('cache-control', 'public, max-age=86400');
    return res.send(buffer);
  } catch (err) {
    if (err instanceof VantorError) {
      // 404 here means "no imagery at this tile", which is normal at the edges of
      // coverage — answer quietly so MapLibre just leaves the tile blank.
      if (err.status === 404) return res.status(404).end();
      if (err.status === 503) return res.status(503).json({ error: err.message });
      console.warn(`[imagery] z${z}/${x}/${y} → ${err.message}`);
      return res.status(502).end();
    }
    console.error('[imagery]', err.message);
    return res.status(500).end();
  }
}
