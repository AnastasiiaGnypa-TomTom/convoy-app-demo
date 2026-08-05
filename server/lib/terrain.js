/**
 * Terrain / DEM source — the single swap point for MapLibre 3D terrain.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  SWAP VANTOR DEM IN HERE. Change DEM_SOURCE below and nothing else.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── Why this is not Vantor (re-verified 2026-08-03) ────────────────────────
 * Re-checked after the vendor entitlements broadened mid-project; the DEM
 * situation is unchanged:
 *   1. streaming/v1/3d/{layer}/latest/tileset.json → 403,
 *      "JWT does not contain expected claim mdsUser.mdsClientRoles.mgp:3D_TILES".
 *   2. elevation/v1 and terrain/v1 → 403.
 *   3. WMTS GetCapabilities advertises NO DEM/DSM/DTM raster layer at all.
 *   4. p3d-dsm / p3d-dtm / p3d-dsmdtm STAC items exist over the AOI and carry
 *      timestamps, but every one has ZERO assets — coverage footprints for
 *      orderable 3D data, not fetchable elevation. They are still surfaced in the
 *      temporal model (lib/temporal.js) as unavailable captures, so the time axis
 *      shows what Vantor *has* even where we cannot render it.
 *   5. Even fully entitled, Vantor 3D is Cesium 3D Tiles (b3dm/glTF mesh) while
 *      MapLibre terrain needs raster-dem (terrarium or mapbox encoding) — that
 *      would require server-side re-encoding, not just a URL change.
 *
 * So terrain runs on an open DEM, proxied like every other vendor call so the
 * frontend never talks to an upstream host directly.
 */

/* -------------------------------------------------------------------------- */
/*  DEM_SOURCE — the one config point                                         */
/*                                                                            */
/*  To move to a Vantor (or any other) DEM:                                    */
/*    upstreamTiles : the {z}/{x}/{y} raster-dem endpoint                      */
/*    encoding      : 'terrarium' | 'mapbox' (must match the vendor's encoding) */
/*    authHeader    : optional () => ({ header: value }) for a keyed source     */
/*    vendor/detail : shown in the UI and /api/terrain/meta                     */
/*                                                                            */
/*  Nothing else needs editing: the client receives the source definition from   */
/*  /api/terrain/meta and always fetches tiles through /api/terrain.            */
/* -------------------------------------------------------------------------- */
export const DEM_SOURCE = {
  vendor: 'open-dem-fallback',
  label: 'AWS Terrain Tiles (Terrarium)',
  detail:
    'Open DEM. Vantor 3D is Cesium 3D Tiles and this key lacks the mgp:3D_TILES role, ' +
    'so Vantor cannot back MapLibre terrain — see lib/terrain.js for the full check.',
  upstreamTiles: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  encoding: 'terrarium',
  tileSize: 256,
  /** Terrarium tiles exist to z15; beyond that MapLibre interpolates. */
  maxzoom: 15,
  attribution: 'Elevation: AWS Terrain Tiles / Mapzen',
  /** Keyless today. A keyed DEM would add its header here and stay server-side. */
  authHeader: null,
};

/** Default vertical exaggeration; the UI exposes a slider around this. */
export const DEFAULT_EXAGGERATION = 1.4;

/**
 * MapLibre source definition handed to the client.
 *
 * Always points at our own proxy, never the upstream host — so swapping to a keyed
 * DEM later needs no frontend change and cannot leak a credential.
 */
export function demSourceForClient() {
  return {
    type: 'raster-dem',
    tiles: ['/api/terrain/{z}/{x}/{y}.png'],
    encoding: DEM_SOURCE.encoding,
    tileSize: DEM_SOURCE.tileSize,
    maxzoom: DEM_SOURCE.maxzoom,
    attribution: DEM_SOURCE.attribution,
  };
}

/** Upstream URL for one tile. */
export function demTileUrl({ z, x, y }) {
  return DEM_SOURCE.upstreamTiles
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * Is the DEM reachable?
 *
 * Probed once and cached so the client can disable 3D and hillshade cleanly with a
 * note, rather than rendering black or broken terrain.
 */
let availability = null;

export async function checkDemAvailable({ timeoutMs = 8000 } = {}) {
  if (availability && Date.now() - availability.at < 5 * 60_000) return availability;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // A mid-latitude z10 tile: if this is missing, the source is unusable.
    const res = await fetch(demTileUrl({ z: 10, x: 525, y: 336 }), {
      headers: DEM_SOURCE.authHeader?.() || {},
      signal: ctl.signal,
    });
    const contentType = res.headers.get('content-type') || '';
    availability = {
      at: Date.now(),
      available: res.ok && /image\//i.test(contentType),
      status: res.status,
      detail: res.ok ? 'DEM reachable' : `DEM returned HTTP ${res.status}`,
    };
  } catch (err) {
    availability = {
      at: Date.now(),
      available: false,
      detail: err.name === 'AbortError' ? 'DEM probe timed out' : `DEM unreachable: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
  return availability;
}
