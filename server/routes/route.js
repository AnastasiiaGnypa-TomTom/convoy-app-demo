/**
 * Routing — /api/route
 *
 * Takes a start, an end and a fleet profile; returns the primary route plus
 * alternatives as GeoJSON that MapLibre can add as a source without conversion.
 *
 * The vehicle profile → TomTom constraint mapping lives in lib/profiles.js, which
 * also documents why this uses classic Routing v1 rather than Orbis Routing.
 */

import { Router } from 'express';
import { createCache } from '../lib/cache.js';
import { ROUTING_ENDPOINT, publicProfiles, resolveConstraints } from '../lib/profiles.js';
import { VendorError, tomtomJson, tomtomUrl } from '../lib/tomtom.js';

export const routeRouter = Router();

// Identical profile+coordinate requests are common when demoing (toggling back and
// forth between light and heavy), and this key rate-limits aggressively.
const routeCache = createCache({ ttlMs: 3 * 60_000 });

/** Fleet presets and custom-field bounds for the RoutePanel. */
routeRouter.get('/profiles', (_req, res) => {
  res.set('cache-control', 'public, max-age=3600');
  res.json({ ...publicProfiles(), routingVendor: ROUTING_ENDPOINT.vendor });
});

function validPoint(p) {
  return (
    p &&
    Number.isFinite(Number(p.lat)) &&
    Number.isFinite(Number(p.lon)) &&
    Math.abs(Number(p.lat)) <= 90 &&
    Math.abs(Number(p.lon)) <= 180
  );
}

/**
 * TomTom returns route geometry as leg point arrays. Flatten to a single
 * GeoJSON LineString per route, dropping the duplicated point at each leg join.
 */
function toLineString(route) {
  const coords = [];
  for (const leg of route.legs || []) {
    for (const p of leg.points || []) {
      const c = [p.longitude, p.latitude];
      const last = coords[coords.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) coords.push(c);
    }
  }
  return coords;
}

/**
 * Turn-by-turn maneuvers for the navigation banner.
 *
 * `routeOffsetInMeters` is the distance along the route at which the maneuver
 * happens, which is exactly what the guidance view needs to work out "next turn in
 * 300 m" from a position anywhere on the line.
 *
 * Maneuver codes seen on this key: DEPART, TURN_LEFT, TURN_RIGHT, KEEP_LEFT,
 * ROUNDABOUT_LEFT, ROUNDABOUT_RIGHT, ROUNDABOUT_CROSS, TAKE_EXIT, ARRIVE.
 */
function maneuvers(route) {
  return (route.guidance?.instructions || []).map((i) => ({
    offsetMeters: i.routeOffsetInMeters ?? 0,
    pointIndex: i.pointIndex ?? null,
    travelTimeSeconds: i.travelTimeInSeconds ?? null,
    maneuver: i.maneuver || i.instructionType || 'STRAIGHT',
    street: i.street || (i.roadNumbers || []).join(' / ') || null,
    message: i.message || null,
    point: i.point ? { lat: i.point.latitude, lon: i.point.longitude } : null,
    exitNumber: i.exitNumber || null,
    roundaboutExit: i.roundaboutExitNumber || null,
  }));
}

/**
 * Traffic sections come back as indices into the flattened point array. Kept on
 * the feature so Step 5 can render congestion without a second vendor call.
 */
function trafficSections(route) {
  return (route.sections || [])
    .filter((s) => s.sectionType === 'TRAFFIC' || s.simpleCategory)
    .map((s) => ({
      startPointIndex: s.startPointIndex,
      endPointIndex: s.endPointIndex,
      category: s.simpleCategory || s.sectionType,
      magnitude: s.magnitudeOfDelay ?? null,
      delaySeconds: s.delayInSeconds ?? null,
    }));
}

routeRouter.post('/', async (req, res, next) => {
  const { start, end, profileId = 'light-vehicle', custom, maxAlternatives = 3 } = req.body || {};

  if (!validPoint(start) || !validPoint(end)) {
    return res.status(400).json({ error: 'start and end must each be {lat, lon}' });
  }

  const { label, spec, constraints } = resolveConstraints({ profileId, custom });
  const alts = Math.min(Math.max(Number(maxAlternatives) || 0, 0), 5);

  const locations = `${Number(start.lat)},${Number(start.lon)}:${Number(end.lat)},${Number(end.lon)}`;
  const params = {
    ...constraints,
    maxAlternatives: alts,
    /*
     * `anyRoute` gives genuinely distinct alternatives; `betterRoute` often returns
     * none at all, which makes the alternatives UI look broken.
     *
     * Only sent when alternatives are actually requested: TomTom rejects
     * alternativeType alongside maxAlternatives=0, and that rejection surfaced as
     * the misleading "could not route this vehicle between those points".
     */
    ...(alts > 0 ? { alternativeType: 'anyRoute' } : {}),
    traffic: 'true',
    routeType: 'fastest',
    computeTravelTimeFor: 'all',
    sectionType: 'traffic',
    /*
     * Turn-by-turn guidance.
     *
     * Classic v1 needs only `instructionsType` and returns usable text
     * ("Turn right onto Oudkerkhof") with street names and maneuver codes.
     *
     * Orbis v2 was checked (2026-08-03) and rejected for guidance: it demands
     * instructionsType + guidanceVersion + instructionPhonetics together, and then
     * returns instructions whose `message` is an EMPTY STRING — nothing to put in a
     * navigation banner. Another reason routing stays on v1 alongside the vehicle
     * constraints Orbis cannot express.
     */
    instructionsType: 'text',
    language: 'en-GB',
  };

  const cacheKey = JSON.stringify([locations, params]);
  const cached = routeCache.get(cacheKey);
  if (cached) {
    res.set('x-cache', 'hit');
    return res.json(cached);
  }

  try {
    const json = await tomtomJson(
      tomtomUrl(`${ROUTING_ENDPOINT.path}/${locations}/json`, params),
      { timeoutMs: 20_000 },
    );

    const routes = (json.routes || []).map((r, index) => {
      const coordinates = toLineString(r);
      const s = r.summary || {};
      return {
        type: 'Feature',
        id: index,
        geometry: { type: 'LineString', coordinates },
        properties: {
          index,
          isPrimary: index === 0,
          lengthMeters: s.lengthInMeters ?? null,
          travelTimeSeconds: s.travelTimeInSeconds ?? null,
          trafficDelaySeconds: s.trafficDelayInSeconds ?? 0,
          noTrafficTravelTimeSeconds: s.noTrafficTravelTimeSeconds ?? null,
          departureTime: s.departureTime ?? null,
          arrivalTime: s.arrivalTime ?? null,
          trafficSections: trafficSections(r),
          maneuvers: maneuvers(r),
          maneuverCount: (r.guidance?.instructions || []).length,
        },
      };
    });

    if (!routes.length) {
      return res.status(422).json({
        error: 'No route found for this vehicle profile between those points.',
        profile: label,
      });
    }

    const payload = {
      profile: { id: profileId, label, spec, travelMode: constraints.travelMode },
      vendor: ROUTING_ENDPOINT.vendor,
      routeCount: routes.length,
      routes: { type: 'FeatureCollection', features: routes },
    };
    routeCache.set(cacheKey, payload);
    res.set('x-cache', 'miss');
    return res.json(payload);
  } catch (err) {
    // A vendor 400 here almost always means "no route for these constraints"
    // (e.g. an oversized load with no legal path), which is a user-facing fact
    // rather than a server fault.
    if (err instanceof VendorError && err.vendorStatus === 400) {
      return res.status(422).json({
        error:
          'TomTom could not route this vehicle between those points. Try a less restrictive profile or different endpoints.',
        profile: label,
      });
    }
    return next(err);
  }
});
