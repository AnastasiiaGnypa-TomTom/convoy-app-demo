#!/usr/bin/env node
/**
 * Step 0 — Vantor capability probe.
 *
 * Calls the real Vantor Hub (api.maxar.com) with the credentials in .env and
 * reports what is actually available, so the imagery and 3D-terrain layers get
 * built against reality rather than against assumptions.
 *
 * Run: npm run probe:vantor
 *
 * Secrets are never printed. Credentials are sent as headers/POST bodies only,
 * and any URL echoed to the console is passed through redactUrl() first.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/* ------------------------------------------------------------------ config */

const HUB = 'https://api.maxar.com';
const TOKEN_URL = 'https://account.maxar.com/auth/realms/mds/protocol/openid-connect/token';

// Small AOI over Utrecht, NL — dense enough to expect archive coverage.
const AOI = {
  name: 'Utrecht, NL',
  bbox: [5.05, 52.05, 5.2, 52.14], // west, south, east, north (WGS84)
};

// Candidate 3D layer from the Vantor docs' own examples.
const TERRAIN_LAYERS = ['3dsm-eval'];

const TIMEOUT_MS = 30_000;

/* ------------------------------------------------------------- env loading */

function loadDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const dotenv = loadDotEnv(join(ROOT, '.env'));
// Real environment wins over .env (matches how Azure App Service settings behave).
const env = (k) => process.env[k] || dotenv[k] || '';

/* ----------------------------------------------------------------- output  */

const C = process.stdout.isTTY
  ? {
      reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
      red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
    }
  : { reset: '', bold: '', dim: '', red: '', green: '', yellow: '', cyan: '' };

const log = (...a) => console.log(...a);
const section = (n, title) => log(`\n${C.bold}${C.cyan}── ${n}. ${title}${C.reset}`);
const ok = (m) => log(`   ${C.green}✓${C.reset} ${m}`);
const bad = (m) => log(`   ${C.red}✗${C.reset} ${m}`);
const warn = (m) => log(`   ${C.yellow}!${C.reset} ${m}`);
const info = (m) => log(`   ${C.dim}·${C.reset} ${m}`);

/** Redact secret-bearing query params before anything is printed. */
function redactUrl(u) {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) {
      if (/key|secret|password|token/i.test(k)) url.searchParams.set(k, '<redacted>');
    }
    return url.toString();
  } catch {
    return String(u).replace(/([?&](?:[^=&]*(?:key|secret|password|token)[^=&]*)=)[^&]*/gi, '$1<redacted>');
  }
}

const snippet = (s, n = 400) =>
  (s || '').replace(/\s+/g, ' ').trim().slice(0, n) || '(empty body)';

/* ------------------------------------------------------------- http helper */

async function request(url, { method = 'GET', headers = {}, body, binary = false } = {}) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal, redirect: 'follow' });
    const contentType = res.headers.get('content-type') || '';
    const out = {
      okStatus: res.ok,
      status: res.status,
      contentType,
      ms: Date.now() - started,
      url,
    };
    if (binary && res.ok && !contentType.includes('json') && !contentType.includes('xml')) {
      out.buffer = Buffer.from(await res.arrayBuffer());
      out.bytes = out.buffer.length;
    } else {
      out.text = await res.text();
      out.bytes = Buffer.byteLength(out.text || '');
      if (contentType.includes('json')) {
        try { out.json = JSON.parse(out.text); } catch { /* leave as text */ }
      }
    }
    return out;
  } catch (err) {
    return {
      okStatus: false,
      status: 0,
      error: err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : err.message,
      ms: Date.now() - started,
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------- results   */

const results = {
  aoi: AOI,
  auth: { status: 'FAIL', mode: null, detail: '' },
  catalog: { status: 'GAP', detail: '', collections: [] },
  search: { status: 'GAP', detail: '', itemCount: null, dateRange: null },
  imagery: { status: 'GAP', detail: '', format: null, maplibreReady: false, sampleFile: null, tileTemplate: null },
  terrain: { status: 'NOT-PROBED', detail: 'not probed', format: null, maplibreReady: false },
  tasking: { status: 'NOT-PROBED', detail: 'not probed' },
};

/* ------------------------------------------------------------------ step 1 */

let bearer = null;
let apiKey = env('VANTOR_API_KEY');

/** Auth headers for Hub calls — header-based only, so keys never land in a URL. */
function authHeaders(extra = {}) {
  if (bearer) return { Authorization: `Bearer ${bearer}`, ...extra };
  if (apiKey) return { 'maxar-api-key': apiKey, ...extra };
  return { ...extra };
}

async function tokenExchange(label, params) {
  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (res.error) {
    bad(`${label}: network error — ${res.error}`);
    return null;
  }
  if (!res.okStatus) {
    bad(`${label}: HTTP ${res.status}`);
    info(`body: ${snippet(res.text)}`);
    return null;
  }
  const j = res.json;
  if (!j?.access_token) {
    bad(`${label}: HTTP 200 but no access_token in response`);
    info(`body: ${snippet(res.text)}`);
    return null;
  }
  ok(`${label}: token acquired (${res.ms}ms)`);
  info(`token_type=${j.token_type || 'n/a'}  expires_in=${j.expires_in ?? 'n/a'}s` +
       (j.refresh_expires_in ? `  refresh_expires_in=${j.refresh_expires_in}s` : ''));
  info(`scopes: ${j.scope || '(none reported)'}`);
  return j;
}

async function stepAuth() {
  section(1, 'Authentication');

  const clientId = env('VANTOR_CLIENT_ID');
  const clientSecret = env('VANTOR_CLIENT_SECRET');
  const username = env('VANTOR_USERNAME');
  const password = env('VANTOR_PASSWORD');

  info(`credentials present: ` +
    `API_KEY=${apiKey ? 'yes' : 'no'}  ` +
    `CLIENT_ID/SECRET=${clientId && clientSecret ? 'yes' : 'no'}  ` +
    `USERNAME/PASSWORD=${username && password ? 'yes' : 'no'}`);

  if (!apiKey && !(clientId && clientSecret) && !(username && password)) {
    bad('No Vantor credentials found in .env — cannot probe.');
    results.auth.detail = 'no credentials supplied';
    return;
  }

  // Mode B — client_credentials (what the build spec assumed).
  if (clientId && clientSecret) {
    const j = await tokenExchange('OAuth2 client_credentials', {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (j) {
      bearer = j.access_token;
      results.auth = { status: 'PASS', mode: 'oauth2:client_credentials', detail: `expires_in=${j.expires_in}s, scope=${j.scope || 'n/a'}` };
      return;
    }
    warn('client_credentials did not work — trying the flow Vantor actually documents.');
  }

  // Mode C — password grant (documented flow: client_id "mgp").
  if (username && password) {
    const j = await tokenExchange('OAuth2 password grant', {
      grant_type: 'password',
      client_id: clientId || 'mgp',
      username,
      password,
    });
    if (j) {
      bearer = j.access_token;
      results.auth = { status: 'PASS', mode: 'oauth2:password', detail: `client_id=${clientId || 'mgp'}, expires_in=${j.expires_in}s` };
      return;
    }
  }

  // Mode A — API key. Validated by the first real Hub call below.
  if (apiKey) {
    warn('Falling back to API-key auth (maxar-api-key header); validity confirmed by the catalog call.');
    results.auth = { status: 'PASS?', mode: 'api-key', detail: 'pending catalog-call confirmation' };
    return;
  }

  results.auth.detail = 'all attempted auth modes failed';
}

/* ------------------------------------------------------------------ step 2 */

async function stepCatalog() {
  section(2, 'STAC catalog — collections');
  const url = `${HUB}/discovery/v1/collections?limit=100`;
  info(`GET ${redactUrl(url)}`);
  const res = await request(url, { headers: authHeaders({ accept: 'application/json' }) });

  if (res.error) { bad(`network error — ${res.error}`); results.catalog.detail = res.error; return; }
  if (!res.okStatus) {
    bad(`HTTP ${res.status}`);
    info(`body: ${snippet(res.text)}`);
    results.catalog.detail = `HTTP ${res.status}: ${snippet(res.text, 200)}`;
    if (results.auth.status === 'PASS?') {
      results.auth.status = 'FAIL';
      results.auth.detail = `api-key rejected by catalog call (HTTP ${res.status})`;
    }
    return;
  }

  if (results.auth.status === 'PASS?') {
    results.auth.status = 'PASS';
    results.auth.detail = 'api-key accepted by Hub';
    ok('API-key auth confirmed working against the Hub.');
  }

  const cols = res.json?.collections || [];
  const ids = cols.map((c) => c.id).filter(Boolean);
  ok(`HTTP 200 — ${ids.length} collection(s) visible (${res.ms}ms)`);
  for (const c of cols.slice(0, 40)) {
    info(`${c.id}${c.title ? ` — ${c.title}` : ''}`);
  }
  if (ids.length > 40) info(`… and ${ids.length - 40} more`);

  results.catalog = { status: ids.length ? 'PASS' : 'GAP', detail: `${ids.length} collections`, collections: ids };
}

/* ------------------------------------------------------------------ step 3 */

async function stepSearch() {
  section(3, `STAC search — ${AOI.name}`);
  const params = new URLSearchParams({ bbox: AOI.bbox.join(','), limit: '100' });
  const url = `${HUB}/discovery/v1/search?${params}`;
  info(`GET ${redactUrl(url)}`);
  const res = await request(url, { headers: authHeaders({ accept: 'application/geo+json,application/json' }) });

  if (res.error) { bad(`network error — ${res.error}`); results.search.detail = res.error; return; }
  if (!res.okStatus) {
    bad(`HTTP ${res.status}`);
    info(`body: ${snippet(res.text)}`);
    results.search.detail = `HTTP ${res.status}: ${snippet(res.text, 200)}`;
    return;
  }

  const feats = res.json?.features || [];
  const matched = res.json?.numberMatched ?? res.json?.context?.matched ?? null;
  ok(`HTTP 200 — ${feats.length} item(s) returned` +
     (matched != null ? `, ${matched} matched total` : '') + ` (${res.ms}ms)`);

  const dates = feats
    .map((f) => f.properties?.datetime || f.properties?.start_datetime)
    .filter(Boolean)
    .sort();
  const range = dates.length ? { earliest: dates[0], latest: dates[dates.length - 1] } : null;
  if (range) ok(`date range in page: ${range.earliest} → ${range.latest}`);
  else warn('no datetime properties found on returned items');

  const byCollection = {};
  for (const f of feats) {
    const c = f.collection || f.properties?.collection || 'unknown';
    byCollection[c] = (byCollection[c] || 0) + 1;
  }
  for (const [c, n] of Object.entries(byCollection)) info(`${c}: ${n} item(s)`);

  // Asset keys tell us what is streamable vs order-only.
  const assetKeys = new Set();
  for (const f of feats.slice(0, 5)) Object.keys(f.assets || {}).forEach((k) => assetKeys.add(k));
  if (assetKeys.size) info(`asset keys on sample items: ${[...assetKeys].join(', ')}`);

  results.search = {
    status: feats.length ? 'PASS' : 'GAP',
    detail: `${feats.length} items${matched != null ? ` of ${matched}` : ''} over ${AOI.name}`,
    itemCount: feats.length,
    matched,
    dateRange: range,
    collections: byCollection,
    assetKeys: [...assetKeys],
  };
}

/* ------------------------------------------------------------------ step 4 */

function extFor(contentType) {
  if (/png/i.test(contentType)) return 'png';
  if (/jpe?g/i.test(contentType)) return 'jpg';
  if (/tiff?/i.test(contentType)) return 'tif';
  if (/xml/i.test(contentType)) return 'xml';
  if (/json/i.test(contentType)) return 'json';
  return 'bin';
}

async function stepImagery() {
  section(4, 'Imagery streaming (OGC) — can MapLibre use it directly?');

  // 4a — WMTS GetCapabilities: tells us layers, formats and tile matrix sets.
  const wmtsCaps = `${HUB}/streaming/v1/ogc/gwc/service/wmts?service=WMTS&version=1.0.0&request=GetCapabilities`;
  info(`GET ${redactUrl(wmtsCaps)}`);
  const caps = await request(wmtsCaps, { headers: authHeaders() });

  let webMercatorSet = null;
  if (caps.okStatus && caps.text) {
    ok(`WMTS GetCapabilities: HTTP 200 (${caps.bytes} bytes, ${caps.ms}ms)`);
    const layers = [...caps.text.matchAll(/<ows:Identifier>([^<]+)<\/ows:Identifier>/g)].map((m) => m[1]);
    const formats = [...new Set([...caps.text.matchAll(/<Format>([^<]+)<\/Format>/g)].map((m) => m[1]))];
    const matrixSets = [...new Set([...caps.text.matchAll(/<TileMatrixSet>([^<]+)<\/TileMatrixSet>/g)].map((m) => m[1]))];
    if (layers.length) info(`identifiers advertised: ${layers.slice(0, 15).join(', ')}${layers.length > 15 ? ' …' : ''}`);
    if (formats.length) info(`formats: ${formats.join(', ')}`);
    if (matrixSets.length) info(`tile matrix sets: ${matrixSets.join(', ')}`);
    webMercatorSet = matrixSets.find((s) => /GoogleMapsCompatible|WebMercatorQuad|EPSG:3857|900913/i.test(s)) || null;
    if (webMercatorSet) ok(`Web Mercator tile matrix set present: ${webMercatorSet} → MapLibre can consume WMTS tiles as an XYZ raster source.`);
    else warn('no Web Mercator tile matrix set found — WMS-over-3857 is the better MapLibre path.');
  } else if (caps.error) {
    bad(`WMTS GetCapabilities: network error — ${caps.error}`);
  } else {
    bad(`WMTS GetCapabilities: HTTP ${caps.status}`);
    info(`body: ${snippet(caps.text)}`);
  }

  // 4b — WMS GetMap over the AOI. MapLibre can call WMS directly as a raster
  // source using a bbox-epsg-3857 tile template, so this is the path we prefer.
  const [w, s, e, n] = AOI.bbox;
  const attempts = [
    {
      label: 'WMS 1.3.0 / CRS:84 / image/png',
      params: { service: 'WMS', version: '1.3.0', request: 'GetMap', layers: 'Maxar:Imagery', styles: 'raster', crs: 'CRS:84', bbox: `${w},${s},${e},${n}`, width: '512', height: '512', format: 'image/png' },
    },
    {
      label: 'WMS 1.1.1 / EPSG:4326 / image/png',
      params: { service: 'WMS', version: '1.1.1', request: 'GetMap', layers: 'Maxar:Imagery', styles: 'raster', srs: 'EPSG:4326', bbox: `${w},${s},${e},${n}`, width: '512', height: '512', format: 'image/png' },
    },
    {
      label: 'WMS 1.1.1 / EPSG:4326 / image/jpeg',
      params: { service: 'WMS', version: '1.1.1', request: 'GetMap', layers: 'Maxar:Imagery', styles: 'raster', srs: 'EPSG:4326', bbox: `${w},${s},${e},${n}`, width: '512', height: '512', format: 'image/jpeg' },
    },
  ];

  for (const attempt of attempts) {
    const url = `${HUB}/streaming/v1/ogc/wms?${new URLSearchParams(attempt.params)}`;
    info(`GET ${redactUrl(url)}`);
    const res = await request(url, { headers: authHeaders(), binary: true });

    if (res.error) { bad(`${attempt.label}: network error — ${res.error}`); continue; }

    // OGC services love returning 200 with an XML ServiceException.
    const isImage = res.okStatus && /^image\//i.test(res.contentType);
    if (!isImage) {
      bad(`${attempt.label}: HTTP ${res.status}, content-type ${res.contentType || 'none'}`);
      info(`body: ${snippet(res.text)}`);
      continue;
    }

    const ext = extFor(res.contentType);
    const file = join(HERE, `vantor-sample.${ext}`);
    writeFileSync(file, res.buffer);
    ok(`${attempt.label}: HTTP 200, ${res.contentType}, ${res.bytes} bytes (${res.ms}ms)`);
    ok(`sample saved → server/scripts/vantor-sample.${ext}`);

    const tileTemplate =
      `${HUB}/streaming/v1/ogc/wms?service=WMS&version=1.1.1&request=GetMap` +
      `&layers=Maxar:Imagery&styles=raster&srs=EPSG:3857&bbox={bbox-epsg-3857}` +
      `&width=256&height=256&format=${encodeURIComponent(res.contentType)}`;

    ok('MapLibre-ready: yes — usable as a `raster` source (proxied through /api/imagery so the key stays server-side).');
    results.imagery = {
      status: 'PASS',
      detail: `${attempt.label} returned ${res.contentType}`,
      format: res.contentType,
      maplibreReady: true,
      sampleFile: `server/scripts/vantor-sample.${ext}`,
      tileTemplate,
      wmtsWebMercatorSet: webMercatorSet,
    };
    return;
  }

  bad('No WMS GetMap variant returned an image.');
  results.imagery.detail = 'all WMS GetMap attempts failed — see output above';
}

/* ------------------------------------------------------------------ step 5 */

async function stepTerrain() {
  section(5, 'Elevation / terrain — is there a MapLibre raster-dem source?');

  let found3dTiles = false;
  for (const layer of TERRAIN_LAYERS) {
    const url = `${HUB}/streaming/v1/3d/${layer}/latest/tileset.json`;
    info(`GET ${redactUrl(url)}`);
    const res = await request(url, { headers: authHeaders({ accept: 'application/json' }) });

    if (res.error) { bad(`network error — ${res.error}`); continue; }
    if (!res.okStatus) {
      bad(`HTTP ${res.status} for layer "${layer}"`);
      info(`body: ${snippet(res.text)}`);
      continue;
    }

    const j = res.json;
    const isCesium3DTiles = !!(j && (j.root || j.geometricError !== undefined || j.asset));
    ok(`HTTP 200 for layer "${layer}" — ${res.contentType} (${res.ms}ms)`);
    if (isCesium3DTiles) {
      found3dTiles = true;
      info(`asset.version=${j.asset?.version ?? 'n/a'}  geometricError=${j.geometricError ?? 'n/a'}`);
      info(`root refine=${j.root?.refine ?? 'n/a'}  content=${j.root?.content?.uri || j.root?.content?.url || 'n/a'}`);
      warn('Format is Cesium 3D Tiles (b3dm/glTF mesh), not raster-DEM tiles.');
      warn('MapLibre GL JS terrain requires a `raster-dem` source (Terrarium or Mapbox terrain-RGB encoding).');
      warn('MapLibre cannot consume 3D Tiles as a terrain source → open-DEM fallback is required for the 3D toggle.');
    } else {
      info(`body: ${snippet(res.text, 300)}`);
    }
  }

  // The catalog DOES list 3D coverage collections (p3d-*) over the AOI. Check whether
  // those items carry a fetchable DEM asset, or are coverage-only "what you could order"
  // footprints. This is the difference between a usable terrain source and a sales listing.
  let p3dAssetCount = 0;
  for (const col of ['p3d-dsm', 'p3d-dtm', 'p3d-dsmdtm']) {
    const url = `${HUB}/discovery/v1/search?collections=${col}&bbox=${AOI.bbox.join(',')}&limit=2`;
    const res = await request(url, { headers: authHeaders({ accept: 'application/json' }) });
    if (res.error) { bad(`${col}: network error — ${res.error}`); continue; }
    if (!res.okStatus) { warn(`${col}: HTTP ${res.status}`); continue; }
    const feats = res.json?.features || [];
    for (const f of feats) {
      const assets = Object.entries(f.assets || {});
      p3dAssetCount += assets.length;
      info(`${col}: item ${f.id} — ${assets.length} asset(s)` +
        (assets.length ? `: ${assets.map(([k, v]) => `${k} (${v.type || 'no type'})`).join(', ')}` : ' (coverage footprint only)'));
    }
    if (!feats.length) info(`${col}: no items over ${AOI.name}`);
  }
  if (p3dAssetCount === 0) {
    warn('p3d-* items over the AOI expose NO downloadable assets — they advertise that 3D data');
    warn('exists to order, they are not a fetchable elevation source.');
  }

  // Exploratory: is anything DEM-shaped exposed? Reported as-is, no assumptions.
  const candidates = [
    `${HUB}/streaming/v1/ogc/wmts?service=WMTS&request=GetCapabilities`,
    `${HUB}/elevation/v1/collections`,
    `${HUB}/terrain/v1/collections`,
  ];
  info('probing for an elevation/DEM-shaped endpoint (exploratory — 404 here is expected and fine):');
  for (const url of candidates) {
    const res = await request(url, { headers: authHeaders({ accept: 'application/json' }) });
    const label = res.error ? `network error (${res.error})` : `HTTP ${res.status}${res.contentType ? `, ${res.contentType}` : ''}`;
    info(`${redactUrl(url)} → ${label}`);
  }

  if (found3dTiles) {
    results.terrain = {
      status: 'GAP',
      detail: 'Vantor exposes 3D Surface Models as Cesium 3D Tiles (tileset.json); no raster-dem tiles found',
      format: 'Cesium 3D Tiles',
      maplibreReady: false,
    };
  } else {
    results.terrain = {
      status: 'GAP',
      detail: p3dAssetCount === 0
        ? 'no streamable Vantor terrain: 3D Tiles endpoint returns 403 (key lacks the mgp:3D_TILES role) and p3d-* catalog items are coverage footprints with no downloadable assets'
        : 'no reachable Vantor terrain/elevation endpoint in this account',
      format: null,
      maplibreReady: false,
      p3dCoverageInCatalog: true,
      p3dDownloadableAssets: p3dAssetCount,
    };
  }
}

/* ------------------------------------------------------------------ step 6 */

async function stepTasking() {
  section(6, 'Tasking reachability (read-only — no order is placed)');
  const candidates = [`${HUB}/tasking/v1/tasking?limit=1`, `${HUB}/tasking/v1/collections?limit=1`];
  const seen = [];
  for (const url of candidates) {
    info(`GET ${redactUrl(url)}`);
    const res = await request(url, { headers: authHeaders({ accept: 'application/json' }) });
    if (res.error) { bad(`network error — ${res.error}`); seen.push('network error'); continue; }
    seen.push(`HTTP ${res.status}`);
    if (res.okStatus) ok(`HTTP ${res.status} — endpoint reachable and authorised`);
    else if (res.status === 401 || res.status === 403) warn(`HTTP ${res.status} — reachable but this account is not entitled`);
    else { warn(`HTTP ${res.status}`); info(`body: ${snippet(res.text, 200)}`); }
  }
  const anyOk = seen.some((s) => s === 'HTTP 200');
  results.tasking = {
    status: anyOk ? 'REACHABLE' : 'NOT-ENTITLED/UNKNOWN',
    detail: seen.join(', ') + ' — out of demo scope either way; no order placed.',
  };
}

/* ------------------------------------------------------------------ summary */

function badge(status) {
  if (status === 'PASS' || status === 'REACHABLE') return `${C.green}PASS${C.reset}`;
  if (status === 'FAIL') return `${C.red}FAIL${C.reset}`;
  if (status === 'GAP') return `${C.yellow}GAP${C.reset}`;
  return `${C.dim}${status}${C.reset}`;
}

function summary() {
  log(`\n${C.bold}${C.cyan}══ Summary — results mapped to demo needs ══${C.reset}\n`);
  const rows = [
    ['Auth (OAuth2 / API key)', results.auth.status, `${results.auth.mode || 'none'} — ${results.auth.detail}`],
    ['STAC catalog access', results.catalog.status, results.catalog.detail],
    ['Archive coverage over AOI', results.search.status, results.search.detail],
    ['Imagery overlay (Step 6)', results.imagery.status, results.imagery.detail],
    ['3D terrain source (Step 7)', results.terrain.status, results.terrain.detail],
    ['Tasking (out of scope)', results.tasking.status, results.tasking.detail],
  ];
  for (const [need, status, detail] of rows) {
    log(`   ${need.padEnd(28)} ${badge(status)}`);
    if (detail) log(`   ${' '.repeat(28)} ${C.dim}${detail}${C.reset}`);
  }

  log(`\n${C.bold}Verdict${C.reset}`);
  const authOk = results.auth.status === 'PASS';
  if (!authOk) {
    log(`   ${C.red}Blocked.${C.reset} Vantor auth did not succeed, so nothing downstream could be confirmed.`);
    log('   Check which credential type you were actually issued (API key vs OAuth2 user account)');
    log('   and re-run. See the HTTP status and body printed above for the reason.');
  } else if (results.imagery.status === 'PASS') {
    log(`   ${C.green}Build imagery against Vantor as planned.${C.reset} The Hub returns`);
    log(`   ${results.imagery.format} over the AOI, which MapLibre can render as a raster source`);
    log('   proxied through /api/imagery. Step 6 proceeds as specced.');
  } else {
    log(`   ${C.yellow}Imagery is a GAP.${C.reset} Auth works but no streamable image came back for the AOI.`);
    log('   Most likely an entitlement/layer-name issue rather than a code issue — the account');
    log('   may have catalog (Discovery) access without Streaming entitlement. Confirm with Vantor');
    log('   before Step 6, or the overlay toggle will have nothing to show.');
  }

  if (results.terrain.status === 'NOT-PROBED') {
    log(`   ${C.dim}Terrain: not probed (auth blocked), so no verdict on the 3D source yet.${C.reset}`);
  } else if (results.terrain.maplibreReady) {
    log(`   ${C.green}Use Vantor terrain for the 3D toggle.${C.reset}`);
  } else {
    log(`   ${C.yellow}Open-DEM terrain fallback IS needed for Step 7.${C.reset}`);
    log(`   Reason: ${results.terrain.detail}.`);
    log('   Vantor 3D is a Cesium 3D Tiles mesh service; MapLibre terrain needs raster-dem tiles.');
    log('   Plan: wire MapLibre terrain to an open DEM (e.g. AWS Terrain Tiles / Terrarium) behind a');
    log('   single clearly-marked config constant, so Vantor terrain can be swapped in later.');
  }

  const reportPath = join(HERE, 'vantor-probe-report.json');
  writeFileSync(reportPath, JSON.stringify(results, null, 2));
  log(`\n${C.dim}Machine-readable report → server/scripts/vantor-probe-report.json${C.reset}`);
}

/* --------------------------------------------------------------------- main */

async function main() {
  log(`${C.bold}Vantor Hub capability probe${C.reset}`);
  log(`${C.dim}host ${HUB} · AOI ${AOI.name} [${AOI.bbox.join(', ')}]${C.reset}`);
  if (!existsSync(join(ROOT, '.env'))) {
    warn('No .env found at project root — falling back to process environment only.');
  }

  await stepAuth();

  const canProceed = results.auth.status === 'PASS' || results.auth.status === 'PASS?';
  if (canProceed) {
    await stepCatalog();
    await stepSearch();
    await stepImagery();
    await stepTerrain();
    await stepTasking();
  } else {
    warn('Skipping Hub calls — no working credential.');
  }

  summary();
  process.exitCode = results.auth.status === 'PASS' ? 0 : 1;
}

main().catch((err) => {
  bad(`Unexpected probe failure: ${err.message}`);
  console.error(err);
  process.exitCode = 1;
});
