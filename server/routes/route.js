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
import {
  AVOID_OPTIONS,
  ROUTING_ENDPOINT,
  publicProfiles,
  resolveConstraints,
  sanitiseAvoid,
} from '../lib/profiles.js';
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

/* ─────────────── task 9: roundabouts (+ rail crossings) ────────────────── */

/**
 * Roundabouts along the route, from the guidance instructions.
 *
 * Readily available and exact: TomTom returns ROUNDABOUT_LEFT / ROUNDABOUT_RIGHT
 * maneuvers carrying offsetMeters, the street, and which exit to take — 4 on a Utrecht →
 * Rotterdam truck route. Nothing is inferred; this is a filter over data already in the
 * response, which is why it costs no extra call.
 *
 * RAILROAD CROSSINGS ARE DELIBERATELY ABSENT. Checked before building: the Orbis style
 * carries railway LINES only (Surface/Bridge/Tunnel - Railway), there is no
 * level-crossing point layer, and no POI category for one survived the allowlist
 * verification. OpenStreetMap's railway=level_crossing would work but needs a new
 * external dependency (Overpass) outside the vendor-proxied setup, so it is reported as
 * pending rather than guessed at. A convoy planner acting on invented crossings is worse
 * off than one told the data is missing.
 */
function roundabouts(route) {
  const list = (route.guidance?.instructions || [])
    .filter((i) => /ROUNDABOUT/i.test(i.maneuver || ''))
    .map((i) => ({
      distanceMeters: i.routeOffsetInMeters ?? null,
      // ux-highlight: needed to centre the map on it, same as a bridge or tunnel.
      lat: i.point?.latitude ?? i.point?.lat ?? null,
      lon: i.point?.longitude ?? i.point?.lon ?? null,
      street: i.street || i.roadNumbers?.[0] || null,
      exit: i.roundaboutExitNumber ?? null,
      direction: /LEFT/i.test(i.maneuver) ? 'left' : 'right',
      message: i.message || null,
    }))
    .sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));

  return {
    count: list.length,
    items: list,
    railCrossings: {
      status: 'pending-data-source',
      note: 'Railroad crossings: no data source available. TomTom map data carries railway lines but no level-crossing points; adding them would need an OpenStreetMap (railway=level_crossing) feed.',
    },
  };
}

/* ─────────────────── task 8: departure-time routing ─────────────────────── */

/**
 * Time-dependent routing, verified against the live API.
 *
 *   departAt=now            200
 *   departAt=<ISO8601>      200   (accepts a trailing Z or a local offset)
 *   arriveAt=<ISO8601>      200   (back-solves the departure time)
 *   departAt AND arriveAt   400   "Only one of departAt and arriveAt parameters can be set"
 *
 * That last one is the reason this is a departure OR arrival choice rather than the
 * "time window" it might sound like: TomTom has no window parameter, so a window would
 * have to be faked by picking one end and calling it both.
 *
 * The effect is real and worth demonstrating — the same Utrecht -> Rotterdam truck route
 * with historical traffic: 03:00 52 min, 08:00 57, 12:00 61, 17:00 69, 22:00 53.
 *
 * One honest caveat carried through to the UI: for a FUTURE departure TomTom reports
 * trafficDelayInSeconds as 0, because that field describes live incidents. The travel
 * time itself does reflect typical traffic for the chosen hour, but there is no separate
 * delay figure to show, so the UI must not present one.
 */
function timeParams(departAt, arriveAt) {
  const iso = (v) => {
    if (!v || typeof v !== 'string') return null;
    if (v === 'now') return 'now';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  };
  const dep = iso(departAt);
  const arr = iso(arriveAt);
  // Mutually exclusive at the API, so enforce it here rather than forwarding a 400.
  if (arr && !dep) return { arriveAt: arr };
  if (dep && dep !== 'now') return { departAt: dep };
  return {};
}

/* ─────────────────────── ux-units: miles or kilometres ─────────────────────── */

/** Roads signed in miles. Canada and Mexico are metric, so "North America" is wrong. */
const IMPERIAL = new Set(['USA', 'GBR', 'LBR', 'MMR']);

/**
 * Countries the route passes through, and the unit system that implies.
 *
 * The FIRST country wins for the unit, because that is where the convoy sets off and
 * whose signage the driver reads first. A route crossing into a differently-signed
 * country is reported in `countries` so the client could say so if it ever needs to.
 */
function countryInfo(route) {
  const codes = [];
  for (const sec of route.sections || []) {
    if (sec.sectionType === 'COUNTRY' && sec.countryCode && !codes.includes(sec.countryCode)) {
      codes.push(sec.countryCode);
    }
  }
  return {
    countries: codes,
    units: codes.length && IMPERIAL.has(codes[0]) ? 'imperial' : 'metric',
    mixed: codes.some((c) => IMPERIAL.has(c)) && codes.some((c) => !IMPERIAL.has(c)),
  };
}

/* ─────────────────── task 7: road-type composition ──────────────────────── */

/** Metres between two lon/lat pairs, planar approximation (fine at section scale). */
function segMetres(a, b) {
  const mPerLon = Math.cos((a[1] * Math.PI) / 180) * 111320;
  return Math.hypot((b[0] - a[0]) * mPerLon, (b[1] - a[1]) * 110540);
}

/**
 * How much of the route runs on each road type.
 *
 * Derived only from the sections TomTom returned, measured against the route's own
 * geometry — nothing is estimated. Two honesty points baked in:
 *
 *  - Types OVERLAP. A stretch can be URBAN and TUNNEL and LOW_EMISSION_ZONE at once, so
 *    these are per-type distances, not slices of a pie, and they can sum to more than
 *    the route length. The UI says so rather than normalising the numbers into
 *    percentages that would look tidy and be wrong.
 *  - Absence is not zero. TomTom only returns sections for types present on the route,
 *    so a type with no sections is reported as "none on this route" — which is a real
 *    answer — while `unreported` lists the types we asked for and heard nothing about.
 */
function composition(route, coordinates) {
  const TYPES = {
    MOTORWAY: 'Motorway',
    TOLL_ROAD: 'Toll road',
    TUNNEL: 'Tunnel',
    URBAN: 'Urban',
    FERRY: 'Ferry',
    UNPAVED: 'Unpaved',
    CAR_TRAIN: 'Car train',
    CARPOOL: 'Carpool lane',
    LOW_EMISSION_ZONE: 'Low-emission zone',
  };

  // Cumulative distance along the geometry, so a section is one subtraction.
  const cum = [0];
  for (let i = 1; i < coordinates.length; i++) {
    cum.push(cum[i - 1] + segMetres(coordinates[i - 1], coordinates[i]));
  }
  const total = cum[cum.length - 1] || 0;

  const metres = {};
  const ranges = {};
  for (const sec of route.sections || []) {
    const type = sec.sectionType;
    if (!TYPES[type]) continue; // TRAFFIC and anything unknown are not road types
    const a = Math.max(0, Math.min(cum.length - 1, Number(sec.startPointIndex) || 0));
    const b = Math.max(0, Math.min(cum.length - 1, Number(sec.endPointIndex) || 0));
    if (b <= a) continue;
    metres[type] = (metres[type] || 0) + (cum[b] - cum[a]);
    (ranges[type] = ranges[type] || []).push([a, b]);
  }

  const present = Object.entries(metres)
    .map(([type, m]) => ({
      type,
      label: TYPES[type],
      // ux-highlight: the point ranges, so clicking a row can draw exactly the stretches
      // this figure was measured from. Without them the client would have to guess.
      sections: ranges[type] || [],
      meters: Math.round(m),
      // Share of the route, which may exceed 100% across types because they overlap.
      percent: total > 0 ? Math.round((m / total) * 1000) / 10 : null,
    }))
    .sort((x, y) => y.meters - x.meters);

  return {
    totalMeters: Math.round(total),
    types: present,
    unreported: Object.keys(TYPES).filter((t) => !metres[t]).map((t) => TYPES[t]),
    overlaps: true,
    note: 'Distances come from TomTom route sections. Types can overlap, so they may total more than the route length.',
  };
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
  const {
    start,
    end,
    profileId = 'light-vehicle',
    custom,
    maxAlternatives = 3,
    avoid, // task 7
    departAt, // task 8
    arriveAt, // task 8
  } = req.body || {};

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
    /*
     * task 7: road-type sections, requested as REPEATED sectionType params (comma-joined
     * is rejected). These are what the composition readout is derived from — nothing is
     * inferred or estimated. TRAFFIC stays in the list because the congestion overlay
     * needs it; it is excluded from the composition, being a delay rather than a road
     * type. `ferry`, `unpaved`, `carTrain` and `carpool` are requested too and simply
     * return no sections when the route has none.
     */
    sectionType: [
      // ux-units: gives countryCode per section (USA / NLD / CHE), which is what decides
      // miles vs km. Cheaper and more reliable than reverse-geocoding an endpoint.
      'country',
      'traffic',
      'motorway',
      'tollRoad',
      'tunnel',
      'urban',
      'ferry',
      'unpaved',
      'carTrain',
      'carpool',
      'lowEmissionZone',
    ],
    // task 7: only values verified against the live API (see AVOID_OPTIONS).
    ...(sanitiseAvoid(avoid).length ? { avoid: sanitiseAvoid(avoid) } : {}),
    ...timeParams(departAt, arriveAt), // task 8
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
          composition: composition(r, coordinates), // task 7
          roundabouts: roundabouts(r), // task 9
          ...countryInfo(r), // ux-units
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
      // task 7: the toggle catalogue, so the UI cannot offer a value the API rejects.
      avoidOptions: AVOID_OPTIONS,
      avoidApplied: sanitiseAvoid(avoid),
      // task 8: what time basis was actually used, and what is genuinely not supported.
      timing: {
        applied: timeParams(departAt, arriveAt),
        liveTraffic: !timeParams(departAt, arriveAt).departAt && !timeParams(departAt, arriveAt).arriveAt,
        windowSupported: false,
        restrictedHours: 'not-implemented',
        notes: [
          'departAt and arriveAt are mutually exclusive — TomTom has no time-window parameter.',
          'For a future time the travel time reflects typical traffic for that hour; TomTom reports no separate delay figure, so none is shown.',
          'Restricted-hours enforcement (night bans, weekend lorry bans) is NOT a TomTom parameter and is not implemented.',
        ],
      },
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

/* ─────────────── ux-insight: travel time by departure hour ───────────────── */

const timeProfileCache = createCache({ ttlMs: 10 * 60_000 });

/** Hours sampled across the day. Six keeps the vendor cost sane and still shows the shape. */
const PROFILE_HOURS = [4, 7, 10, 13, 16, 19];

/**
 * How long the same journey takes at different departure hours.
 *
 * This exists because TomTom gives no delay figure for a FUTURE departure. Measured:
 * with departAt set, trafficDelayInSeconds, noTrafficTravelTimeSeconds and
 * historicTrafficTravelTimeSeconds all come back absent, and traffic=false returns the
 * identical travel time — so there is nothing to diff against and the UI had no insight
 * to show even though the travel time itself was changing (61 min at 04:00 against 73 at
 * 17:00 on one Dutch route).
 *
 * So the comparison is built explicitly: the same route costed at several hours, which is
 * the question a convoy planner actually asks — when should we leave. One request per
 * hour, run at low concurrency and cached for ten minutes, since the answer only moves
 * with TomTom's historical model.
 */
routeRouter.post('/time-profile', async (req, res, next) => {
  const { start, end, profileId = 'light-vehicle', custom, avoid, date } = req.body || {};
  if (!validPoint(start) || !validPoint(end)) {
    return res.status(400).json({ error: 'start and end must each be {lat, lon}' });
  }

  const { constraints } = resolveConstraints({ profileId, custom });
  const locations = `${Number(start.lat)},${Number(start.lon)}:${Number(end.lat)},${Number(end.lon)}`;
  const day = date ? new Date(date) : new Date(Date.now() + 24 * 3600 * 1000);
  if (Number.isNaN(day.getTime())) {
    return res.status(400).json({ error: 'date is not a valid timestamp' });
  }

  const key = JSON.stringify([locations, profileId, custom || null, sanitiseAvoid(avoid), day.toDateString()]);
  const cached = timeProfileCache.get(key);
  if (cached) {
    res.set('x-cache', 'hit');
    return res.json(cached);
  }

  try {
    const tasks = PROFILE_HOURS.map((hour) => async () => {
      const at = new Date(day);
      at.setHours(hour, 0, 0, 0);
      const params = {
        ...constraints,
        traffic: 'true',
        routeType: 'fastest',
        maxAlternatives: 0,
        departAt: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        ...(sanitiseAvoid(avoid).length ? { avoid: sanitiseAvoid(avoid) } : {}),
      };
      const json = await tomtomJson(
        tomtomUrl(`${ROUTING_ENDPOINT.path}/${locations}/json`, params),
        { timeoutMs: 12_000 },
      );
      const s = json.routes?.[0]?.summary;
      return {
        hour,
        travelSeconds: s?.travelTimeInSeconds ?? null,
        lengthMeters: s?.lengthInMeters ?? null,
      };
    });

    // Sequential-ish: this is six calls for one answer, not a user-facing latency path.
    const settled = [];
    for (const t of tasks) {
      try {
        settled.push(await t());
      } catch (err) {
        console.warn('[time-profile]', err.message);
        settled.push(null);
      }
    }

    const points = settled.filter((x) => x && x.travelSeconds != null);
    if (!points.length) {
      return res.status(502).json({ error: 'No travel times available for those hours.' });
    }
    const best = points.reduce((a, b) => (b.travelSeconds < a.travelSeconds ? b : a));
    const worst = points.reduce((a, b) => (b.travelSeconds > a.travelSeconds ? b : a));

    const payload = {
      date: day.toISOString(),
      points,
      best,
      worst,
      spreadSeconds: worst.travelSeconds - best.travelSeconds,
      missing: settled.filter((x) => !x || x.travelSeconds == null).length,
      note: 'Typical travel times from TomTom historical traffic. For a future departure TomTom reports no separate delay figure, so these are compared against each other rather than against free-flow.',
    };
    timeProfileCache.set(key, payload);
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});
