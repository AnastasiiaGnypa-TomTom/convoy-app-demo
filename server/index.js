/**
 * Convoy App — Express server.
 *
 * One process serves both halves of the deployment: the built React app as
 * static files, and the /api/* proxy endpoints that hold the vendor keys. That
 * is what makes this deployable as a single Azure App Service with one URL.
 *
 *   npm run build   → builds the React app into server/public
 *   npm start       → serves that build plus the API on PORT
 */

import express from 'express';
import compression from 'compression';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, config, logConfigSummary } from './lib/env.js';
import { LIMITS, rateLimit } from './lib/rateLimit.js';
import { DEFAULT_EXAGGERATION, DEM_SOURCE, demSourceForClient } from './lib/terrain.js';
import { checkTomTomKey } from './lib/tomtom.js';
import { IMAGERY_MAX_ZOOM, checkVantorKey } from './lib/vantor.js';
import { basemapRouter } from './routes/basemap.js';
import { capabilitiesRouter } from './routes/capabilities.js';
import { geocodeRouter } from './routes/geocode.js';
import { imageryRouter } from './routes/imagery.js';
import { poisRouter } from './routes/pois.js';
import { routeRouter } from './routes/route.js';
import { temporalRouter } from './routes/temporal.js';
import { terrainRouter } from './routes/terrain.js';
import { trafficRouter } from './routes/traffic.js';

const app = express();
const PUBLIC_DIR = join(ROOT, 'server', 'public');

app.disable('x-powered-by');
/*
 * Trust App Service's front end so req.ip and the rate limiter see the real client
 * address rather than the load balancer. Exactly one hop is trusted; trusting all
 * proxies would let a client forge its own address by sending x-forwarded-for.
 */
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '256kb' }));

/*
 * Security headers. Modest on purpose — this is a map app, not a form: there is no
 * login, no cookie and no user input that is echoed back, so the XSS surface is
 * small. These close the cheap gaps rather than pretending to be a full CSP, which
 * MapLibre's worker and blob usage would fight.
 */
app.use((_req, res, next) => {
  res.set('x-content-type-options', 'nosniff');
  res.set('referrer-policy', 'strict-origin-when-cross-origin');
  res.set('x-frame-options', 'SAMEORIGIN');
  next();
});

/* ----------------------------------------------------------------- api ---- */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'convoy-app', uptimeSeconds: Math.round(process.uptime()) });
});

/**
 * Are the vendor keys actually still accepted?
 *
 * /api/health only reports whether a key is *present*, which cannot catch a
 * revoked or rotated key — the failure that turns a live demo into a blank map.
 * This makes one cheap HEAD request per vendor and reports the verdict. Results
 * are cached briefly so it can be polled or hit repeatedly before a meeting
 * without becoming a vendor load of its own.
 *
 * Never returns key material — only configured/valid/detail.
 */
const KEY_CHECK_TTL_MS = 30_000;
let keyCheckCache = { at: 0, payload: null };

app.get('/api/health/keys', async (_req, res) => {
  const now = Date.now();
  if (keyCheckCache.payload && now - keyCheckCache.at < KEY_CHECK_TTL_MS) {
    res.set('x-cache', 'hit');
    return res.json(keyCheckCache.payload);
  }

  const [tomtom, vantor] = await Promise.all([checkTomTomKey(), checkVantorKey()]);
  const payload = {
    ok: tomtom.valid && vantor.valid,
    checkedAt: new Date(now).toISOString(),
    tomtom,
    vantor,
  };
  keyCheckCache = { at: now, payload };
  res.set('cache-control', 'no-store');
  res.set('x-cache', 'miss');
  return res.json(payload);
});

/**
 * Non-secret client configuration. Deliberately the ONLY channel through which
 * the frontend learns vendor details — and it carries no credentials, so there is
 * nothing here that would be unsafe in the browser.
 */
app.get('/api/config', (_req, res) => {
  res.json({
    map: {
      styleUrl: '/api/basemap/style.json',
      // Utrecht, NL — matches the Step 0 probe AOI, so imagery coverage is known good.
      center: [5.1214, 52.0907],
      zoom: 11,
      maxPitch: 75,
    },
    /*
     * No start/end is prefilled: the user sets both, starting from their own
     * location when geolocation is permitted. The map centre above is only the
     * fallback view for when it is denied or unavailable.
     *
     * Reference for anyone demoing manually — constraint differences are most
     * visible on short city-centre corridors, because that is where weight and
     * height limits bite. Utrecht centre → Nieuwegein
     * (52.0894,5.121 → 52.029,5.08) puts a light vehicle and an oversized convoy
     * on routes sharing only 2.8% of their points. Long motorway runs look
     * near-identical between profiles and undersell the point.
     */
    terrain: {
      // Proxied source; /api/terrain/meta carries availability and the exaggeration
      // default. Swapping in a Vantor DEM is a one-line edit in lib/terrain.js.
      source: demSourceForClient(),
      vendor: DEM_SOURCE.vendor,
      label: DEM_SOURCE.label,
      defaultExaggeration: DEFAULT_EXAGGERATION,
    },
  });
});

/*
 * Rate limits. The keys are server-side, but the quota behind them is not: on a
 * public URL every endpoint below is an open relay billed to our vendor accounts.
 * Limits are per-IP and generous enough that a real demo never notices — see
 * lib/rateLimit.js for how each number was chosen.
 */
app.use('/api/imagery', rateLimit(LIMITS.imagery));
app.use('/api/basemap', rateLimit(LIMITS.imagery));
app.use('/api/terrain', rateLimit(LIMITS.imagery));
app.use('/api/route', rateLimit(LIMITS.routing));
app.use('/api/geocode', rateLimit(LIMITS.search));
app.use('/api/pois', rateLimit(LIMITS.search));
app.use('/api/traffic', rateLimit(LIMITS.general));
app.use('/api/temporal', rateLimit(LIMITS.general));
app.use('/api/capabilities', rateLimit(LIMITS.general));

app.use('/api/capabilities', capabilitiesRouter);
app.use('/api/basemap', basemapRouter);
app.use('/api/geocode', geocodeRouter);
app.use('/api/route', routeRouter);
app.use('/api/traffic', trafficRouter);
app.use('/api/imagery', imageryRouter);
app.use('/api/pois', poisRouter);
app.use('/api/terrain', terrainRouter);
app.use('/api/temporal', temporalRouter);

/* ==========================================================================
 * SEAMS — explicitly out of scope. Documentation only; nothing is implemented.
 * ==========================================================================
 *
 * ── POST /api/change-detection ────────────────────────────────────────────
 * Vantor multi-date compare over the route corridor, then reroute around
 * whatever changed. The Monitoring API supports this and IS entitled on the
 * current key (verified 2026-07-30):
 *   GET  /monitoring/v1/monitors            → 200, data.monitors: []
 *   POST /monitoring/v1/monitors (empty body) → 400 invalid_… (NOT 403)
 * A 400 rather than 403 means writes are permitted, i.e. this key can create
 * monitors. Nothing here calls Monitoring today, so there is no exposure yet.
 *
 * Three-call flow (from Maxar's mgp-monitoring-events sample):
 *   1. GET  /monitoring/v1/monitors/{id}/events        → new acquisitions
 *   2. GET  /discovery/v1/search?ids={eventId}         → resolve to a STAC item
 *   3. WMS GetMap &cql_filter=legacyIdentifier='{id}'  → render THAT image
 * Step 3 is how you pin the overlay to a specific before/after capture instead
 * of the default mosaic.
 *
 * Monitor creation body:
 *   { source, description,
 *     aoi_geojson: { type: 'Polygon', coordinates },
 *     match_criteria: { platform: { in: [...] },
 *                       'eo:cloud_cover':   { lte: n },
 *                       'view:off_nadir':   { lte: n },
 *                       'aoi:coverage_pct': { gte: n } },
 *     metadata: { ...free-form... } }
 *
 * !! CAUTION before wiring this up !!
 * The Maxar sample scopes monitors per user with
 * metadata.creator_key = SHA256(apiKey). That does NOT work here: this app holds
 * one shared server-side key and has no authentication, so every visitor would
 * share a single creator_key and see each other's monitors. Worse, since writes
 * are permitted, exposing monitor creation on a public URL would let anyone
 * create monitors on the customer's Vantor account. Add real per-user identity,
 * or keep change detection server-initiated only.
 *
 * ── PROPERTY VOCABULARIES — the same fields are named differently per API ──
 * Getting these wrong on the WMS/CQL path fails SILENTLY: a bad property name
 * returns HTTP 200 with a blank tile, not an error. (Maxar's own CQL sample
 * ships this bug — it documents `sunAngle`, which does not exist; the real field
 * is `sunElevation`.) Validate against:
 *   GET /streaming/v1/ogc/ows?service=WFS&request=DescribeFeatureType&version=2.0.0
 * which returns the authoritative schema (385 field entries across
 * EnhancedImageryFeature / FinishedFeature / RasterFeature / VectorFeatures).
 *
 *   concept      | Discovery + Monitoring (STAC) | Streaming WFS / CQL
 *   -------------|------------------------------|--------------------------
 *   cloud cover  | eo:cloud_cover               | cloudCover  (a PERCENT)
 *                | area:cloud_cover_percentage  |
 *   off-nadir    | view:off_nadir               | offNadirAngle
 *   satellite    | platform                     | source
 *   resolution   | (n/a)                        | groundSampleDistance (m)
 *   date         | datetime                     | acquisitionDate
 *   sun angle    | (n/a)                        | sunElevation  (NOT sunAngle)
 *
 * Sensor ids differ in case too: Discovery uses `wv03-vnir`, streaming `WV03_VNIR`.
 * CQL sort uses Maxar's own suffixes — `acquisitionDate D` / `A`; standard WFS
 * `DESC` returns HTTP 400. Newest-first is already the service default.
 *
 * ── GET /api/export/atak ──────────────────────────────────────────────────
 * Selected route as CoT / ATAK data package. The route GeoJSON returned by
 * /api/route is the input; nothing else is needed from a vendor.
 */

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'unknown api endpoint' });
});

/* -------------------------------------------------------------- frontend --- */

if (existsSync(PUBLIC_DIR)) {
  app.use(
    express.static(PUBLIC_DIR, {
      // Vite emits content-hashed asset filenames, so those are safe to cache hard.
      setHeaders(res, path) {
        if (path.includes(`${'/'}assets${'/'}`)) {
          res.set('cache-control', 'public, max-age=31536000, immutable');
        } else {
          res.set('cache-control', 'no-cache');
        }
      },
    }),
  );
  // Single-page app: any non-API path returns index.html.
  app.get('*', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));
} else {
  app.get('*', (_req, res) => {
    res
      .status(503)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Convoy App</title>
         <body style="font:16px/1.6 system-ui;max-width:44rem;margin:4rem auto;padding:0 1.5rem;background:#0d1117;color:#e6edf3">
         <h1>Convoy App</h1>
         <p>The frontend has not been built yet.</p>
         <p>Run <code style="background:#161b22;padding:.15rem .4rem;border-radius:4px">npm run build</code>,
            then restart with <code style="background:#161b22;padding:.15rem .4rem;border-radius:4px">npm start</code>.</p>
         <p style="color:#7d8590">The API is already live — try
            <a href="/api/health" style="color:#58a6ff">/api/health</a> or
            <a href="/api/capabilities" style="color:#58a6ff">/api/capabilities</a>.</p>
         </body>`,
      );
  });
}

/* ---------------------------------------------------------------- errors --- */

app.use((err, _req, res, _next) => {
  // Never leak a vendor URL (which would carry a key) into a client-visible error.
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: 'internal server error' });
});

app.listen(config.port, () => {
  console.log(`\nConvoy App listening on http://localhost:${config.port}`);
  logConfigSummary();
  console.log(
    `[config] frontend             = ${existsSync(PUBLIC_DIR) ? 'built (serving server/public)' : 'NOT BUILT — run npm run build'}`,
  );
  console.log(`[config] terrain DEM         = ${DEM_SOURCE.vendor} (${DEM_SOURCE.encoding})`);
  console.log(`[config] imagery max zoom     = ${IMAGERY_MAX_ZOOM} (cost guard)`);

  /*
   * Validate the keys for real, not just for presence — a revoked or rotated key
   * otherwise only shows up as a blank map mid-demo. Runs after listen so it
   * never delays startup, and a failure here is reported, not fatal.
   */
  Promise.all([checkTomTomKey(), checkVantorKey()])
    .then(([tomtom, vantor]) => {
      for (const [name, r] of [
        ['TomTom', tomtom],
        ['Vantor', vantor],
      ]) {
        const mark = r.valid ? 'OK' : r.configured ? 'FAILED' : 'not set';
        console.log(`[keys]   ${name.padEnd(7)} ${mark.padEnd(8)} ${r.detail}`);
      }
      if (!tomtom.valid || !vantor.valid) {
        console.log('[keys]   re-check any time with: curl localhost:' + config.port + '/api/health/keys');
      }
      console.log('');
    })
    .catch((err) => console.warn('[keys]   key validation could not run:', err.message, '\n'));
});
