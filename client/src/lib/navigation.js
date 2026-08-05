/**
 * Navigation maths.
 *
 * Everything the guidance view needs is derived from one number: how far along the
 * route polyline the vehicle is. Distance-along drives the maneuver banner, the
 * travelled/ahead split, remaining distance, remaining time and ETA — so the
 * simulated driver and real GPS feed the identical code path, exactly as specced.
 *
 * All distances are metres, all bearings degrees clockwise from north.
 */

const R = 6371000; // Earth radius, metres
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Haversine distance between two [lon, lat] pairs. */
export function distanceBetween([lon1, lat1], [lon2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial bearing from one [lon, lat] to another. */
export function bearingBetween([lon1, lat1], [lon2, lat2]) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Pre-compute cumulative distances along a route so lookups are cheap.
 *
 * Built once per route rather than per animation frame — at 60fps over a 400-point
 * line, recomputing would be the most expensive thing on the page.
 */
export function buildRouteIndex(coordinates) {
  const cum = [0];
  for (let i = 1; i < coordinates.length; i++) {
    cum.push(cum[i - 1] + distanceBetween(coordinates[i - 1], coordinates[i]));
  }
  return { coordinates, cum, totalMeters: cum[cum.length - 1] || 0 };
}

/** Interpolate the position at a given distance along the route. */
export function positionAt(index, meters) {
  const { coordinates, cum, totalMeters } = index;
  if (!coordinates.length) return null;
  const d = Math.max(0, Math.min(meters, totalMeters));

  // Binary search for the segment containing d.
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }

  const segLen = cum[hi] - cum[lo];
  const t = segLen > 0 ? (d - cum[lo]) / segLen : 0;
  const [x1, y1] = coordinates[lo];
  const [x2, y2] = coordinates[hi];
  return {
    coord: [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t],
    bearing: bearingBetween(coordinates[lo], coordinates[hi]),
    segmentIndex: lo,
  };
}

/**
 * Snap a real GPS fix onto the route and return its distance along.
 *
 * Searched within a window around the last known position rather than over the
 * whole line: without that, a route that doubles back on itself (common in cities)
 * can snap the vehicle kilometres backwards or forwards.
 */
export function snapToRoute(index, coord, { fromMeters = 0, windowMeters = 2000 } = {}) {
  const { coordinates, cum } = index;
  let best = { distanceAlong: fromMeters, offRouteMeters: Infinity, coord };

  for (let i = 1; i < coordinates.length; i++) {
    if (cum[i] < fromMeters - windowMeters) continue;
    if (cum[i - 1] > fromMeters + windowMeters) break;

    const a = coordinates[i - 1];
    const b = coordinates[i];
    const segLen = cum[i] - cum[i - 1];
    if (segLen === 0) continue;

    // Project onto the segment in a local planar approximation — fine at segment scale.
    const mPerDegLat = 111_320;
    const mPerDegLon = 111_320 * Math.cos(toRad(coord[1]));
    const ax = a[0] * mPerDegLon;
    const ay = a[1] * mPerDegLat;
    const bx = b[0] * mPerDegLon;
    const by = b[1] * mPerDegLat;
    const px = coord[0] * mPerDegLon;
    const py = coord[1] * mPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const off = Math.hypot(px - cx, py - cy);

    if (off < best.offRouteMeters) {
      best = {
        distanceAlong: cum[i - 1] + segLen * t,
        offRouteMeters: off,
        coord: [cx / mPerDegLon, cy / mPerDegLat],
      };
    }
  }
  return best;
}

/** The maneuver the driver is heading toward, plus how far to it. */
export function nextManeuver(maneuvers, distanceAlong) {
  if (!maneuvers?.length) return null;
  for (let i = 0; i < maneuvers.length; i++) {
    // A maneuver counts as passed once we are 15 m beyond it, so the banner does
    // not flip back and forth while sitting on top of a junction.
    if (maneuvers[i].offsetMeters > distanceAlong + 15) {
      return { ...maneuvers[i], distanceToManeuver: maneuvers[i].offsetMeters - distanceAlong, index: i };
    }
  }
  const last = maneuvers[maneuvers.length - 1];
  return { ...last, distanceToManeuver: Math.max(0, last.offsetMeters - distanceAlong), index: maneuvers.length - 1 };
}

/**
 * Remaining distance, time and clock ETA.
 *
 * Remaining time scales the route's own traffic-aware travel time by the fraction
 * left, so live traffic stays reflected in the ETA rather than being recomputed
 * from a nominal speed.
 */
export function progressSummary({ index, distanceAlong, travelTimeSeconds }) {
  const total = index.totalMeters || 0;
  const remainingMeters = Math.max(0, total - distanceAlong);
  const fraction = total > 0 ? remainingMeters / total : 0;
  const remainingSeconds = Math.round((travelTimeSeconds || 0) * fraction);
  return {
    remainingMeters,
    remainingSeconds,
    travelledMeters: distanceAlong,
    fractionComplete: total > 0 ? distanceAlong / total : 0,
    etaDate: new Date(Date.now() + remainingSeconds * 1000),
  };
}

/** Split the line into travelled and ahead, for dimming what is behind. */
export function splitRoute(index, distanceAlong) {
  const { coordinates, cum } = index;
  if (!coordinates.length) return { travelled: [], ahead: [] };

  const here = positionAt(index, distanceAlong);
  const cut = here?.segmentIndex ?? 0;
  const travelled = coordinates.slice(0, cut + 1);
  if (here) travelled.push(here.coord);
  const ahead = here ? [here.coord, ...coordinates.slice(cut + 1)] : coordinates;
  // cum is unused here but kept in the signature so callers pass the built index.
  void cum;
  return { travelled, ahead };
}

/** Realistic cruising speed in m/s, scaled to the vehicle profile. */
export function speedForProfile(profileId) {
  switch (profileId) {
    case 'oversized-convoy':
      return 55 / 3.6;
    case 'heavy-truck':
      return 70 / 3.6;
    case 'van':
      return 85 / 3.6;
    default:
      return 95 / 3.6;
  }
}

/** Icon glyph per TomTom maneuver code. */
export function maneuverGlyph(maneuver = '') {
  const m = maneuver.toUpperCase();
  if (m.includes('ROUNDABOUT')) return '↻';
  if (m.includes('SHARP_LEFT')) return '⬅';
  if (m.includes('SHARP_RIGHT')) return '➡';
  if (m.includes('LEFT')) return '↰';
  if (m.includes('RIGHT')) return '↱';
  if (m.includes('EXIT')) return '⤴';
  if (m === 'DEPART') return '●';
  if (m === 'ARRIVE') return '⚑';
  if (m.includes('UTURN')) return '⟲';
  if (m.includes('MERGE')) return '⤳';
  return '↑';
}
