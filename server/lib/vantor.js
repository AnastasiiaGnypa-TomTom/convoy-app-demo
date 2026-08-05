/**
 * Vantor (Maxar Hub) vendor adapter.
 *
 * The single place the Vantor API key is attached to a request. Nothing above this
 * module sees it, which keeps it out of the browser. Swapping Vantor for another
 * imagery provider means rewriting this file and nothing in the client.
 *
 * Auth mode confirmed by the Step 0 probe (2026-07-29): API key in a
 * `maxar-api-key` header. OAuth2 client_credentials and password grants were not
 * needed. See server/scripts/probe-vantor.js to re-verify.
 */

import { config, env } from './env.js';

const HUB = 'https://api.maxar.com';

/* -------------------------------------------------------------------------- */
/*  IMAGERY MAX ZOOM — detail vs vendor cost                                  */
/*                                                                            */
/*  Set to 18: full-detail satellite imagery, matching what Vantor Hub itself   */
/*  shows. This is a deliberate, account-owner-approved choice — see below.     */
/*                                                                            */
/*  ── The cost trade-off, so nobody has to rediscover it ──────────────────   */
/*  Maxar's own mgp-streaming-search sample ships a "Free" switch that is ON    */
/*  by default and caps zoom at 14; switching it off raises the cap to 18 and    */
/*  warns "Warning: You are now incurring costs." So z15+ streaming is          */
/*  billable, and the vendor enforces nothing — verified 2026-07-30, this Hub    */
/*  serves z10 through z20 with HTTP 200 and no watermark.                      */
/*                                                                            */
/*  At 14 the imagery is visibly soft once you zoom in, because MapLibre is      */
/*  upsampling a z14 tile. That is the wrong trade for a demo whose whole point  */
/*  is showing off Vantor imagery quality, so detail wins here.                 */
/*                                                                            */
/*  ── What this means operationally ───────────────────────────────────────   */
/*  The app is public and unauthenticated, so anyone with the link can stream    */
/*  billable imagery. Mitigations available if that becomes a concern:           */
/*    - set IMAGERY_MAX_ZOOM=14 in the environment (no redeploy of code needed)  */
/*    - restrict access to the App Service (IP allow-list / Easy Auth)           */
/*    - share the link only for the duration of a meeting                        */
/*                                                                            */
/*  Override per environment without touching code:                             */
/*    IMAGERY_MAX_ZOOM=14   (App Service application setting, or .env locally)   */
/*                                                                            */
/*  Enforced BOTH as the MapLibre source maxzoom AND server-side in             */
/*  routes/imagery.js, so a hand-crafted tile request cannot exceed it.          */
/* -------------------------------------------------------------------------- */
/* Cost is approved on a company account, so this is the vendor's real ceiling,
 * not a budget limit. Verified 2026-07-30: the Hub serves z20 with HTTP 200. */
const DEFAULT_IMAGERY_MAX_ZOOM = 20;

/** The deepest level the service was verified to serve. */
const ABSOLUTE_MAX_ZOOM = 20;

function resolveMaxZoom() {
  const raw = Number(env('IMAGERY_MAX_ZOOM', String(DEFAULT_IMAGERY_MAX_ZOOM)));
  if (!Number.isFinite(raw)) return DEFAULT_IMAGERY_MAX_ZOOM;
  return Math.min(ABSOLUTE_MAX_ZOOM, Math.max(1, Math.round(raw)));
}

export const IMAGERY_MAX_ZOOM = resolveMaxZoom();

/* -------------------------------------------------------------------------- */
/*  CONFIG POINT — imagery layer                                              */
/*                                                                            */
/*  WMTS GetTile against the Web Mercator tile matrix set, which the probe      */
/*  found advertised as EPSG:3857. This maps 1:1 onto MapLibre's {z}/{x}/{y}    */
/*  raster source, so no bbox arithmetic is needed and no reprojection occurs.  */
/*                                                                            */
/*  Alternative layers advertised by GetCapabilities, if a customer wants a     */
/*  different look: Maxar:VividAdvanced15, Maxar:VividBasic, Maxar:VividStandard,*/
/*  Maxar:EnhancedImagery, Maxar:FinishedFeature.                              */
/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/*  RESOLUTION — why 512px tiles and why the cap is 18                        */
/*                                                                            */
/*  Measured against the live Hub over Utrecht, 2026-08-03:                    */
/*                                                                            */
/*    matrix set     tile size    bytes @z16                                   */
/*    EPSG:3857      256x256      190 KB                                       */
/*    EPSG:3857x2    512x512      737 KB   ← 4x the pixels, same ground        */
/*    EPSG:3857x4    (400 error — not available on this account)               */
/*                                                                            */
/*  ── CRITICAL: x2 is @2x on the SAME grid, not a 512-tile scheme ──────────  */
/*  From GetCapabilities, level 10:                                            */
/*    EPSG:3857    TileWidth 256  MatrixWidth 1024  scaleDenom 545979          */
/*    EPSG:3857x2  TileWidth 512  MatrixWidth 1024  scaleDenom 272989          */
/*                                                                            */
/*  Identical MatrixWidth means identical tile extents — the same ground per    */
/*  (z,x,y), just twice the pixels. So MapLibre must be told the LOGICAL tile   */
/*  size (256), not the image size (512).                                      */
/*                                                                            */
/*  Declaring tileSize 512 was a real bug: MapLibre then treats it as a         */
/*  512-scheme grid, requests one zoom level shallower than needed and stretches */
/*  every tile 2x — soft imagery everywhere, worst at wide zooms. This is the    */
/*  standard @2x pattern: logical size 256, image 512.                          */
/*                                                                            */
/*  Native detail ends around z18. Byte sizes for the same viewport collapse    */
/*  past it — 185 KB at z17, 174 KB at z18, then 98 KB at z19, 37 KB at z20,    */
/*  14 KB at z21 — which is the signature of the service upscaling for us. So   */
/*  the source is advertised as maxzoom 18 and MapLibre overzooms from real     */
/*  data instead of fetching progressively emptier tiles.                      */
/* -------------------------------------------------------------------------- */
export const IMAGERY = {
  layer: 'Maxar:Imagery',
  style: 'raster',
  format: 'image/png',
  /** Retina matrix set: 512px images on the 256 grid. 'EPSG:3857' = plain 256px. */
  tileMatrixSet: 'EPSG:3857x2',
  /** What the vendor returns per tile, for documentation and diagnostics. */
  tilePixelSize: 512,
  /**
   * What MapLibre is told. MUST be the grid's logical tile size (256), never the
   * image size — see the note above. Serving 512px images into a 256px logical
   * footprint is exactly what makes the imagery retina-sharp.
   */
  tileSize: 256,
  /** Deepest level with genuine detail — beyond this the vendor upscales. */
  nativeMaxZoom: 18,
  minzoom: 0,
  /** Effective cap served to clients — the lower of the cost guard and native detail. */
  maxzoom: Math.min(IMAGERY_MAX_ZOOM, 18),
  /** What the service will actually serve (verified to z20). */
  serviceMaxZoom: ABSOLUTE_MAX_ZOOM,
  attribution: '© Vantor / Maxar',
};

/* -------------------------------------------------------------------------- */
/*  IMAGERY MODES — seamlessness vs freshness                                 */
/*                                                                            */
/*  These two goals genuinely conflict and cannot both be satisfied by one      */
/*  layer, so the mode is an explicit choice rather than a compromise:          */
/*                                                                            */
/*  SEAMLESS pins the render to the Vivid Standard 30 mosaic — a basemap-grade   */
/*    product, colour-balanced and edge-matched across tiles, refreshed roughly  */
/*    quarterly. It looks like a map. Newest-first sorting is deliberately       */
/*    DROPPED here: re-sorting by date would let a fresher single-pass strip     */
/*    win over the mosaic in places and reintroduce exactly the seams the mode   */
/*    exists to remove. Seam consistency wins over freshness.                   */
/*                                                                            */
/*  LATEST leaves the layer unfiltered and newest-acquisition-first, so the      */
/*    freshest available capture wins everywhere. That is genuinely more current  */
/*    — often by weeks — but composites many single passes with different sun     */
/*    angles, sensors and dates, so visible strip edges are NORMAL and expected.  */
/*    The UI labels it "single capture" for that reason.                          */
/*                                                                            */
/*  Discovered 2026-07-30, not assumed:                                        */
/*   - Only three productNames exist on this account: VIVID_STANDARD_30 (256),  */
/*     VIVID_ADVANCED_15 (458), DAILY_TAKE (233/234).                          */
/*   - cql_filter IS honoured on WMTS GetTile (a bogus product returns a         */
/*     1,670-byte blank tile), so pinning by productName works on the tile path. */
/*   - Maxar:Imagery + cql productName='VIVID_STANDARD_30' is BYTE-IDENTICAL to  */
/*     the dedicated Maxar:VividStandard layer, so either route works; the CQL    */
/*     form is used because it keeps one layer and one code path.                */
/*   - VIVID_STANDARD_30 rendered non-blank everywhere tested, including rural    */
/*     Friesland and the Tyrolean Alps. VIVID_ADVANCED_15 (15 cm) is city-only —  */
/*     blank in both rural areas — so it is NOT a safe default, though it is a    */
/*     good manual choice for an urban demo.                                     */
/*   - Maxar:VividBasic and Maxar:EnhancedImagery returned blank even over        */
/*     Amsterdam: not entitled on this key.                                      */
/* -------------------------------------------------------------------------- */
export const IMAGERY_MODES = {
  seamless: {
    id: 'seamless',
    label: 'Seamless',
    /** Pinned product. Swap for VIVID_ADVANCED_15 for 15 cm in cities only. */
    productName: 'VIVID_STANDARD_30',
    cqlFilter: "productName='VIVID_STANDARD_30'",
    /** Intentionally null — see the note above about re-sorting reintroducing seams. */
    sortBy: null,
    kind: 'seamless mosaic',
    detail: 'Vivid Standard 30 — colour-balanced basemap mosaic, refreshed ~quarterly',
  },
  latest: {
    id: 'latest',
    label: 'Latest',
    productName: null,
    cqlFilter: null,
    /** Maxar's own suffix convention; standard WFS "DESC" returns HTTP 400. */
    sortBy: 'acquisitionDate D',
    kind: 'single capture',
    detail: 'Newest acquisition first — freshest imagery, visible strip edges are normal',
  },
};

/* -------------------------------------------------------------------------- */
/*  DEFAULT IMAGERY MODE — change this one value to flip the app default.      */
/*  Independent of the UI toggle, which only overrides it per session.         */
/* -------------------------------------------------------------------------- */
export const DEFAULT_IMAGERY_MODE = 'seamless';

/** Resolve a mode id to its definition, falling back to the default. */
export function resolveImageryMode(id) {
  return IMAGERY_MODES[id] || IMAGERY_MODES[DEFAULT_IMAGERY_MODE];
}

export class VantorError extends Error {
  constructor(message, { status, vendorStatus } = {}) {
    super(message);
    this.name = 'VantorError';
    this.status = status ?? 502;
    this.vendorStatus = vendorStatus;
  }
}

export const hasVantorKey = () => Boolean(config.vantorApiKey);

/** Auth as a header, never a query param, so the key cannot leak via a URL or log. */
function authHeaders(extra = {}) {
  return { 'maxar-api-key': config.vantorApiKey, ...extra };
}

/**
 * CQL filter pinning the render to one capture date.
 *
 * A one-day window around the capture: acquisitionDate is an exact timestamp, and
 * an equality match would depend on sub-second formatting. Verified that
 * acquisitionDate comparisons are honoured — filtering to an uncovered window
 * returns the empty tile, a covered window returns imagery.
 */
export function dateFilterFor(dateIso) {
  const day = String(dateIso).slice(0, 10);
  return `acquisitionDate BETWEEN '${day}T00:00:00Z' AND '${day}T23:59:59Z'`;
}

/**
 * Build the WMTS GetTile URL for an XYZ tile coordinate.
 *
 * When `captureDate` is given it REPLACES the mode's own filter: the selected
 * capture already identifies the imagery, so also pinning the mode's product would
 * intersect the two and usually yield nothing.
 */
export function imageryTileUrl({ z, x, y }, modeId = DEFAULT_IMAGERY_MODE, captureDate = null) {
  const mode = resolveImageryMode(modeId);
  const params = new URLSearchParams({
    service: 'WMTS',
    version: '1.0.0',
    request: 'GetTile',
    layer: IMAGERY.layer,
    style: IMAGERY.style,
    format: IMAGERY.format,
    TileMatrixSet: IMAGERY.tileMatrixSet,
    // GeoServer/GWC qualifies the matrix identifier with the set name.
    TileMatrix: `${IMAGERY.tileMatrixSet}:${z}`,
    TileRow: String(y),
    TileCol: String(x),
  });
  if (captureDate) {
    params.set('cql_filter', dateFilterFor(captureDate));
  } else if (mode.cqlFilter) {
    // Pins the render to one mosaic product in SEAMLESS mode; absent in LATEST.
    params.set('cql_filter', mode.cqlFilter);
  }
  if (mode.sortBy && !captureDate) params.set('sortBy', mode.sortBy);
  return `${HUB}/streaming/v1/ogc/gwc/service/wmts?${params}`;
}

/* -------------------------------------------------------------------------- */
/*  Provenance — what imagery is actually on screen                           */
/*                                                                            */
/*  Uses WFS Maxar:FinishedFeature rather than the STAC catalog on purpose:     */
/*  FinishedFeature describes the STREAMING layer's own contents, whereas STAC   */
/*  describes the orderable archive. Only the former can honestly answer "what  */
/*  am I looking at". Verified 2026-07-30 over Utrecht:                         */
/*    VIVID_STANDARD_30 | 2026-05-05T11:08:56Z | cloudCover 0 | 0.3 Meter       */
/*                                                                            */
/*  sortBy uses the Maxar "A"/"D" suffix convention ("acquisitionDate D").      */
/*  Standard WFS "DESC" is rejected with HTTP 400.                             */
/* -------------------------------------------------------------------------- */

/**
 * Newest streamed imagery intersecting a bbox.
 *
 * @param {[number,number,number,number]} bbox [minLon, minLat, maxLon, maxLat]
 * @returns {Promise<object|null>} normalised provenance, or null if nothing covers it
 */
/**
 * Query WFS FinishedFeature for the single most relevant capture over a bbox.
 *
 * NOTE on the query form: passing `bbox` and `cql_filter` as separate parameters
 * returns HTTP 500 from this service. The working form puts BBOX() *inside*
 * cql_filter, and the coordinate order must be lat,lon to match srsName
 * EPSG:4326 — lon,lat silently returns zero features. Verified 2026-07-30.
 */
async function queryFinishedFeature({ bbox, productName, sortBy, timeoutMs }) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const bboxClause = `BBOX(featureGeometry,${minLat},${minLon},${maxLat},${maxLon})`;
  const cql = productName ? `productName='${productName}' AND ${bboxClause}` : bboxClause;

  const params = new URLSearchParams({
    service: 'WFS',
    request: 'GetFeature',
    version: '2.0.0',
    srsName: 'EPSG:4326',
    typeNames: 'Maxar:FinishedFeature',
    outputFormat: 'application/json',
    cql_filter: cql,
    count: '1',
  });
  if (sortBy) params.set('sortBy', sortBy);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${HUB}/streaming/v1/ogc/wfs?${params}`, {
      headers: authHeaders({ accept: 'application/json' }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      throw new VantorError(`Vantor WFS returned HTTP ${res.status}`, {
        status: 502,
        vendorStatus: res.status,
      });
    }
    const json = await res.json();
    return json.features?.[0]?.properties || null;
  } finally {
    clearTimeout(timer);
  }
}

function normalise(p) {
  if (!p) return null;
  return {
    productName: p.productName || p.legacyIdentifier || null,
    acquisitionDate: p.acquisitionDate || null,
    cloudCoverPercent: typeof p.cloudCover === 'number' ? p.cloudCover : null,
    // groundSampleDistanceUnit comes back as e.g. "Meter"; keep both parts.
    resolution: p.groundSampleDistance ?? null,
    resolutionUnit: p.groundSampleDistanceUnit || null,
    offNadirAngle: typeof p.offNadirAngle === 'number' ? p.offNadirAngle : null,
    // "Multiple" for mosaics built from more than one sensor, which is common.
    sensor: p.sensorName || p.source || null,
    legacyIdentifier: p.legacyIdentifier || null,
  };
}

/**
 * What imagery is on screen, for a given mode.
 *
 * Returns { requestedMode, effectiveMode, fellBack, provenance }. In SEAMLESS
 * mode, if no mosaic covers the viewport the caller is told to fall back to
 * LATEST rather than render nothing — an empty overlay in a live demo reads as a
 * broken app, whereas fresher strip imagery with an honest label does not.
 *
 * @param {[number,number,number,number]} bbox [minLon, minLat, maxLon, maxLat]
 */
export async function fetchImageryProvenance(bbox, modeId = DEFAULT_IMAGERY_MODE, { timeoutMs = 12_000 } = {}) {
  if (!hasVantorKey()) {
    throw new VantorError('VANTOR_API_KEY is not configured on the server', { status: 503 });
  }

  const mode = resolveImageryMode(modeId);

  try {
    const primary = await queryFinishedFeature({
      bbox,
      productName: mode.productName,
      sortBy: mode.sortBy,
      timeoutMs,
    });

    if (primary) {
      return {
        requestedMode: mode.id,
        effectiveMode: mode.id,
        fellBack: false,
        kind: mode.kind,
        provenance: normalise(primary),
      };
    }

    // SEAMLESS with no mosaic coverage → fall back to LATEST and say so.
    if (mode.productName) {
      const fallbackMode = IMAGERY_MODES.latest;
      const alt = await queryFinishedFeature({
        bbox,
        productName: null,
        sortBy: fallbackMode.sortBy,
        timeoutMs,
      });
      return {
        requestedMode: mode.id,
        effectiveMode: fallbackMode.id,
        fellBack: true,
        kind: fallbackMode.kind,
        provenance: normalise(alt),
      };
    }

    return {
      requestedMode: mode.id,
      effectiveMode: mode.id,
      fellBack: false,
      kind: mode.kind,
      provenance: null,
    };
  } catch (err) {
    if (err instanceof VantorError) throw err;
    const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
    throw new VantorError(`Vantor WFS request failed: ${reason}`, { status: 504 });
  }
}

/**
 * Is the Vantor key currently accepted?
 *
 * HEAD against WFS DescribeFeatureType — no body, no quota-heavy work. Borrowed
 * from Maxar's mgp-monitoring-events sample, which uses it as its login check.
 * Verified 2026-07-30: 200 with a valid key, 401 with an invalid one.
 */
export async function checkVantorKey({ timeoutMs = 8000 } = {}) {
  if (!hasVantorKey()) return { configured: false, valid: false, detail: 'VANTOR_API_KEY not set' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${HUB}/streaming/v1/ogc/ows?service=WFS&request=DescribeFeatureType&version=2.0.0`,
      { method: 'HEAD', headers: authHeaders(), signal: ctl.signal },
    );
    return {
      configured: true,
      valid: res.ok,
      status: res.status,
      detail: res.ok
        ? 'key accepted by Vantor Hub'
        : res.status === 401 || res.status === 403
          ? 'key rejected — revoked, rotated, or lacking entitlement'
          : `unexpected HTTP ${res.status}`,
    };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
    return { configured: true, valid: false, detail: `could not reach Vantor: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch an imagery tile. Returns { buffer, contentType } or throws VantorError.
 *
 * OGC services habitually answer with HTTP 200 and an XML ServiceException, so a
 * non-image content-type is treated as a failure rather than passed to the client.
 */
export async function fetchImageryTile(
  { z, x, y },
  modeId = DEFAULT_IMAGERY_MODE,
  { timeoutMs = 20_000, captureDate = null } = {},
) {
  if (!hasVantorKey()) {
    throw new VantorError('VANTOR_API_KEY is not configured on the server', { status: 503 });
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(imageryTileUrl({ z, x, y }, modeId, captureDate), {
      headers: authHeaders(),
      signal: ctl.signal,
    });
    const contentType = res.headers.get('content-type') || '';

    if (!res.ok) {
      throw new VantorError(`Vantor returned HTTP ${res.status}`, {
        status: res.status === 401 || res.status === 403 ? 502 : res.status,
        vendorStatus: res.status,
      });
    }
    if (!/^image\//i.test(contentType)) {
      // Almost always "outside coverage" or an invalid tile matrix level.
      throw new VantorError(`Vantor returned ${contentType || 'no content-type'}, not an image`, {
        status: 404,
        vendorStatus: res.status,
      });
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType };
  } catch (err) {
    if (err instanceof VantorError) throw err;
    const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
    throw new VantorError(`Vantor request failed: ${reason}`, { status: 504 });
  } finally {
    clearTimeout(timer);
  }
}
