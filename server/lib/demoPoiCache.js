/**
 * Demo POI cache — a pure, deletable fallback.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The Emmen -> Locarno corridor is the route being filmed. POIs there normally come from
 * live TomTom calls, which take a second or two and occasionally rate-limit; on camera
 * that reads as the app being slow. This lets those POIs be fetched ONCE ahead of time
 * and served instantly during the demo.
 *
 * ── The one rule ──────────────────────────────────────────────────────────
 * It must be impossible for this to change behaviour anywhere else, and impossible to
 * get stuck with stale data. So:
 *   - if server/data/poi-cache-demo.json is absent, every function here reports "no
 *     match" and the live path runs exactly as before;
 *   - deleting that file is the complete off switch — no code change, no flag;
 *   - a request only matches when it is genuinely inside the demo corridor.
 *
 * Nothing here writes. The file is produced by server/scripts/build-demo-poi-cache.js.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEMO_CACHE_FILE = join(HERE, '..', 'data', 'poi-cache-demo.json');

let cached = null;
let loadedFrom = null;

/** Loads once per process. Returns null when the file is absent or unreadable. */
export function loadDemoCache() {
  if (cached && loadedFrom === DEMO_CACHE_FILE) return cached;
  if (!existsSync(DEMO_CACHE_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(DEMO_CACHE_FILE, 'utf8'));
    if (!Array.isArray(parsed?.features) || !Array.isArray(parsed?.route)) return null;
    cached = parsed;
    loadedFrom = DEMO_CACHE_FILE;
    return cached;
  } catch {
    // A corrupt cache must not break the live path.
    return null;
  }
}

/** Metres from a coordinate to the cached corridor polyline. */
function metresToRoute([lon, lat], route) {
  const mPerLon = Math.cos((lat * Math.PI) / 180) * 111320;
  let best = Infinity;
  for (let i = 1; i < route.length; i++) {
    const ax = (route[i - 1][0] - lon) * mPerLon;
    const ay = (route[i - 1][1] - lat) * 110540;
    const bx = (route[i][0] - lon) * mPerLon;
    const by = (route[i][1] - lat) * 110540;
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

/**
 * Does this viewport sit on the demo corridor?
 *
 * Deliberately strict: the view centre must be within the corridor the cache was built
 * for. A view merely in the same country does not match, so panning off the corridor
 * returns to live data by itself.
 */
export function bboxMatchesDemo([minLon, minLat, maxLon, maxLat]) {
  const c = loadDemoCache();
  if (!c) return false;
  const centre = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  return metresToRoute(centre, c.route) <= (c.corridorM || 10_000);
}

/** Does this requested route match the cached demo route, endpoint to endpoint? */
/**
 * Does this request refer to the cached demo route?
 *
 * Endpoints alone are NOT enough, which was a real bug: every alternative between the
 * same origin and destination matched, so switching primary <-> alternative kept serving
 * the PRIMARY route's cached POIs. On Emmen -> Locarno that is a 160 km route and a
 * 266 km one over a different pass being given the same corridor.
 *
 * So the shape has to match too. The requested route is sampled and each sample must lie
 * close to the cached polyline; a genuinely different alternative fails this immediately
 * and falls through to the live corridor sweep. The filmed primary route still matches
 * and still loads instantly.
 */
const DEMO_ENDPOINT_TOLERANCE_M = 5000;
const DEMO_SHAPE_TOLERANCE_M = 2500;
/** Fraction of sampled points that must sit inside the shape tolerance. */
const DEMO_SHAPE_MATCH = 0.9;

function metresToPolyline([lon, lat], line) {
  const mPerLon = Math.cos((lat * Math.PI) / 180) * 111320;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1][0] - lon) * mPerLon;
    const ay = (line[i - 1][1] - lat) * 110540;
    const bx = (line[i][0] - lon) * mPerLon;
    const by = (line[i][1] - lat) * 110540;
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

export function routeMatchesDemo(points) {
  const c = loadDemoCache();
  if (!c || !points?.length || !c.route?.length) return false;

  const near = (a, b, tol) => {
    const mPerLon = Math.cos((a[1] * Math.PI) / 180) * 111320;
    return Math.hypot((a[0] - b[0]) * mPerLon, (a[1] - b[1]) * 110540) <= tol;
  };
  const first = [points[0].lon, points[0].lat];
  const last = [points[points.length - 1].lon, points[points.length - 1].lat];
  if (!near(first, c.route[0], DEMO_ENDPOINT_TOLERANCE_M)) return false;
  if (!near(last, c.route[c.route.length - 1], DEMO_ENDPOINT_TOLERANCE_M)) return false;

  // Shape check: sample the request and measure against the cached polyline.
  const SAMPLES = 24;
  let inside = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const p = points[Math.floor((i * (points.length - 1)) / (SAMPLES - 1))];
    if (metresToPolyline([p.lon, p.lat], c.route) <= DEMO_SHAPE_TOLERANCE_M) inside++;
  }
  return inside / SAMPLES >= DEMO_SHAPE_MATCH;
}

/** Cached features for the requested layers, optionally clipped to a bbox. */
export function demoFeatures(layerIds, bbox = null) {
  const c = loadDemoCache();
  if (!c) return null;
  const wanted = new Set(layerIds);
  let feats = c.features.filter((f) => wanted.has(f.properties?.layer));
  if (bbox) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    feats = feats.filter((f) => {
      const [lon, lat] = f.geometry.coordinates;
      return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
    });
  }
  const perLayer = {};
  for (const id of layerIds) perLayer[id] = 0;
  for (const f of feats) perLayer[f.properties.layer] = (perLayer[f.properties.layer] || 0) + 1;
  return { features: feats, perLayer, builtAt: c.builtAt || null };
}
