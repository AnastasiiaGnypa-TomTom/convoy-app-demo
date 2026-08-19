/**
 * Bridge and tunnel extraction from TomTom vector tiles, server-side.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The client draws bridges and tunnels straight from the basemap vector tiles, which
 * costs nothing extra — but only works at zoom 12 and above, because TomTom strips the
 * `bridge` / `tunnel` attributes from tiles below that. Measured: at z11 a view held
 * 29,220 road features and not one carried a `bridge` key at all.
 *
 * Every client-side workaround was tried and none exist:
 *   - no other attribute survives generalisation (z_level, covered, access all absent);
 *   - MapLibre cannot be made to fetch deeper tiles than the camera zoom —
 *     `tileSize` on a vector source is rejected outright:
 *     "vector tile sources must have a tileSize of 512".
 *
 * So to show them at regional zoom the tiles have to be read where that restriction does
 * not apply: here. This fetches the z12 tiles covering a viewport, decodes them, and
 * returns only the bridge/tunnel line geometry as GeoJSON — a few hundred KB instead of
 * the tens of MB the raw tiles would be.
 *
 * ── The cost, and why z10 is the floor ────────────────────────────────────
 * A viewport needs 4^(12-z) times as many z12 tiles as it does tiles at its own zoom:
 *   z11 -> ~15 tiles      z10 -> ~61 tiles
 *   z9  -> ~243 tiles     z8  -> ~973 tiles
 * z10 is the last level where this is honest work rather than abuse of the vendor. Below
 * it the request is refused and the client says so, instead of silently drawing nothing.
 */

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { createCache } from './cache.js';

/** The zoom at which TomTom first includes the attributes. Verified, not assumed. */
export const SOURCE_ZOOM = 12;
/**
 * Browse floor.
 *
 * Lowered from 10 to 9.5 for regional views — an Alpine corridor at z9 is exactly the
 * view a viewer wants, and the old floor left it blank. It cannot go much lower: the
 * attributes only exist at z12, so a z8.5 viewport would need roughly 1300 source tiles.
 */
export const MIN_REQUEST_ZOOM = 9.5;

/**
 * Hard ceiling per request.
 *
 * Raised from 80. At z10 a viewport spans about 320 source tiles, so 80 covered only a
 * quarter of the view and quietly returned a partial answer — bridges simply missing
 * from three quarters of the screen with no indication. Tiles are cached per tile for
 * six hours and fetched in parallel, so the real cost is paid once per area.
 */
export const MAX_TILES = 450;

/*
 * Extracted geometry is cached per tile, not per request.
 *
 * Panning re-uses most of the same tiles, so a per-request cache would miss constantly
 * while a per-tile cache hits almost every time. Road geometry barely changes, so the
 * TTL is long.
 */
const tileCache = createCache({ ttlMs: 6 * 60 * 60_000 });

const lonToTileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

export function tilesForBbox([minLon, minLat, maxLon, maxLat], z = SOURCE_ZOOM) {
  const x0 = lonToTileX(minLon, z);
  const x1 = lonToTileX(maxLon, z);
  // Tile Y runs north to south, so maxLat gives the smaller index.
  const y0 = latToTileY(maxLat, z);
  const y1 = latToTileY(minLat, z);
  const tiles = [];
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      tiles.push({ z, x, y });
    }
  }
  return tiles;
}

/** Tile-local coordinates to lon/lat. */
function toLngLat(x, y, extent, tile) {
  const n = 2 ** tile.z;
  const lon = ((tile.x + x / extent) / n) * 360 - 180;
  const yy = 1 - 2 * ((tile.y + y / extent) / n);
  const lat = (Math.atan(Math.sinh(Math.PI * yy)) * 180) / Math.PI;
  return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
}

/**
 * Decode one tile into bridge/tunnel line features.
 *
 * Only the properties the inspector popup actually shows are kept. Carrying the full
 * property bag would multiply the response size for data nothing reads.
 */
function extractFromTile(buffer, tile) {
  const vt = new VectorTile(new PbfReader(buffer));
  const out = [];

  for (const layerName of ['roads', 'transit']) {
    const layer = vt.layers[layerName];
    if (!layer) continue;

    for (let i = 0; i < layer.length; i++) {
      const feat = layer.feature(i);
      const p = feat.properties || {};
      const isBridge = p.bridge === true || p.bridge === 1;
      const isTunnel = p.tunnel === true || p.tunnel === 1;
      if (!isBridge && !isTunnel) continue;

      const geo = feat.loadGeometry();
      const lines = [];
      for (const ring of geo) {
        if (ring.length < 2) continue;
        lines.push(ring.map((pt) => toLngLat(pt.x, pt.y, layer.extent, tile)));
      }
      if (!lines.length) continue;

      /*
       * Length in metres, so the client can decide what is worth drawing at a wide view.
       * A canal city has hundreds of 15 m footbridges; an Alpine valley has a handful of
       * multi-kilometre tunnels. Without a size the two are indistinguishable and the
       * dense case turns the map into noise.
       */
      /*
       * tweak: the LONGEST part, not the sum of all parts. A tile feature can be a
       * MultiLineString of several disjoint bridge sections on the same road, so summing
       * reported a single 2.5 km "bridge" that is really a few hundred metres of viaduct
       * repeated along the valley.
       */
      let lengthM = 0;
      for (const line of lines) {
        let partM = 0;
        for (let k = 1; k < line.length; k++) {
          const mPerLon = Math.cos((line[k][1] * Math.PI) / 180) * 111320;
          partM += Math.hypot(
            (line[k][0] - line[k - 1][0]) * mPerLon,
            (line[k][1] - line[k - 1][1]) * 110540,
          );
        }
        lengthM = Math.max(lengthM, partM);
      }

      out.push({
        type: 'Feature',
        geometry:
          lines.length === 1
            ? { type: 'LineString', coordinates: lines[0] }
            : { type: 'MultiLineString', coordinates: lines },
        properties: {
          // `tunnel` wins when a segment somehow carries both, so the stricter
          // constraint is the one shown.
          kind: isTunnel ? 'tunnel' : 'bridge',
          name: p.name || p.name_en || null,
          category: p.category || null,
          route_number: p.route_number || p.route_shield_text || null,
          z_level: typeof p.z_level === 'number' ? p.z_level : null,
          rail: layerName === 'transit',
          length_m: Math.round(lengthM),
        },
      });
    }
  }
  return out;
}

/**
 * Bridge and tunnel lines for a bbox.
 *
 * `fetchTile` is injected so the caller owns how tiles are requested — the vendor key
 * and the proxy live there, not here.
 */
export async function structuresForBbox(bbox, { fetchTile, concurrency = 6, signal } = {}) {
  const tiles = tilesForBbox(bbox, SOURCE_ZOOM);
  const truncated = tiles.length > MAX_TILES;
  const use = truncated ? tiles.slice(0, MAX_TILES) : tiles;

  const features = [];
  let fromCache = 0;
  let fetched = 0;
  let failed = 0;
  let next = 0;

  const worker = async () => {
    while (next < use.length) {
      if (signal?.aborted) return;
      const tile = use[next++];
      const key = `${tile.z}/${tile.x}/${tile.y}`;

      const hit = tileCache.get(key);
      if (hit) {
        fromCache++;
        features.push(...hit);
        continue;
      }

      try {
        const buf = await fetchTile(tile);
        if (!buf) {
          failed++;
          continue;
        }
        const extracted = extractFromTile(buf, tile);
        tileCache.set(key, extracted);
        fetched++;
        features.push(...extracted);
      } catch {
        // A missing tile is a gap, not a failure of the whole request.
        failed++;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, use.length) }, worker));

  return {
    type: 'FeatureCollection',
    features,
    tiles: use.length,
    fromCache,
    fetched,
    failed,
    truncated,
    sourceZoom: SOURCE_ZOOM,
  };
}


/* ─────────────────── along an active route, at any zoom ─────────────────── */

/** Tile budget for a route corridor. A long Alpine route is well inside this. */
export const MAX_ROUTE_TILES = 200;

/**
 * Bridge and tunnel lines along a route, independent of the camera zoom.
 *
 * The viewport version is bounded by zoom because a wide view needs a quadratic number
 * of source tiles. A route corridor does not have that problem: it needs tiles along a
 * LINE, which grows linearly with distance. A 190 km Swiss route is roughly 40 tiles plus
 * a one-tile ring — affordable at any zoom.
 *
 * That matters because it is the case a convoy planner actually cares about. Seeing every
 * tunnel on the road you are about to drive should not depend on how far you happen to be
 * zoomed out.
 */
export async function structuresAlongRoute(points, { fetchTile, corridorM = 1500, signal } = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    return { type: 'FeatureCollection', features: [], tiles: 0 };
  }

  // Tiles touched by the route, plus one ring so structures just off the line are caught.
  const seen = new Set();
  const tiles = [];
  const n = 2 ** SOURCE_ZOOM;
  for (const pt of points) {
    const cx = lonToTileX(pt.lon, SOURCE_ZOOM);
    const cy = latToTileY(pt.lat, SOURCE_ZOOM);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const k = `${x}/${y}`;
        if (seen.has(k)) continue;
        seen.add(k);
        tiles.push({ z: SOURCE_ZOOM, x, y });
      }
    }
  }

  const truncated = tiles.length > MAX_ROUTE_TILES;
  const use = truncated ? tiles.slice(0, MAX_ROUTE_TILES) : tiles;

  const collected = [];
  let next = 0;
  let failed = 0;
  const worker = async () => {
    while (next < use.length) {
      if (signal?.aborted) return;
      const tile = use[next++];
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      const hit = tileCache.get(key);
      if (hit) {
        collected.push(...hit);
        continue;
      }
      try {
        const buf = await fetchTile(tile);
        if (!buf) {
          failed++;
          continue;
        }
        const ex = extractFromTile(buf, tile);
        tileCache.set(key, ex);
        collected.push(...ex);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, use.length) }, worker));

  /*
   * Keep only what is actually ON the route. The tile ring pulls in everything within a
   * tile of the line, which at z12 is several kilometres — without this filter a city the
   * route merely passes near would dump hundreds of its bridges into the result.
   */
  const near = collected.filter((f) => {
    const parts =
      f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const line of parts) {
      for (const c of line) {
        if (metresToRoute(c, points) <= corridorM) return true;
      }
    }
    return false;
  });

  /*
   * tweak: stamp each structure with how far along the route it sits, so the panel can
   * list them in travel order with a distance. Previously the list was derived from what
   * the map had RENDERED, which meant it was empty at regional zoom and empty whenever
   * the Bridges & tunnels layer was switched off.
   */
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const mPerLon = Math.cos((points[i].lat * Math.PI) / 180) * 111320;
    cum.push(
      cum[i - 1] +
        Math.hypot(
          (points[i].lon - points[i - 1].lon) * mPerLon,
          (points[i].lat - points[i - 1].lat) * 110540,
        ),
    );
  }
  const distanceAlong = ([lon, lat]) => {
    const mPerLon = Math.cos((lat * Math.PI) / 180) * 111320;
    let best = Infinity;
    let at = 0;
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
      if (d2 < best) {
        best = d2;
        at = cum[i - 1] + (cum[i] - cum[i - 1]) * t;
      }
    }
    return at;
  };

  for (const f of near) {
    const parts =
      f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    const first = parts[0]?.[0];

    /*
     * offset_m: the CLOSEST this structure comes to the route.
     *
     * The corridor filter above only asks whether a structure is within corridorM of the
     * route, which for a 1.2 km corridor is "somewhere nearby" — in a canal city that is
     * dozens of bridges the convoy never touches. Recording the actual offset lets the
     * caller separate "the route crosses this" from "this is near the route", which is the
     * difference between a clearance concern and background context.
     */
    let offset = Infinity;
    for (const line of parts) {
      for (const c of line) {
        const d = metresToRoute(c, points);
        if (d < offset) offset = d;
      }
    }

    f.properties = {
      ...f.properties,
      distance_m: first ? Math.round(distanceAlong(first)) : null,
      offset_m: Number.isFinite(offset) ? Math.round(offset) : null,
    };
  }

  return {
    type: 'FeatureCollection',
    features: near,
    tiles: use.length,
    failed,
    truncated,
    corridorM,
  };
}

/** Distance from a coordinate to the route polyline, planar approximation. */
function metresToRoute([lon, lat], points) {
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
