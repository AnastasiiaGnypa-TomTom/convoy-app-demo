/**
 * The frontend's only channel to the vendors.
 *
 * Everything goes through our own /api/* proxy — there is deliberately no vendor
 * hostname and no API key anywhere in the client bundle. If a future feature needs
 * a new vendor call, add an endpoint to the Express proxy rather than fetching the
 * vendor from here.
 */

async function request(path, { signal, method = 'GET', body } = {}) {
  const res = await fetch(path, {
    signal,
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* empty or non-JSON body */
  }

  if (!res.ok) {
    // The proxy sends a human-readable `error` for the cases a user can act on
    // (no route for this profile, bad coordinates), so prefer it over the status.
    const err = new Error(payload?.error || `${path} failed: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return payload;
}

/** Non-secret map/terrain configuration, resolved server-side. */
export const fetchConfig = (opts) => request('/api/config', opts);

/** What this deployment can actually do, given the current vendor entitlements. */
export const fetchCapabilities = (opts) => request('/api/capabilities', opts);

/** Fleet presets plus the bounds for the custom-vehicle fields. */
export const fetchProfiles = (opts) => request('/api/route/profiles', opts);

/** Autocomplete suggestions, biased toward the current map centre when given. */
export function geocode(query, { center, signal } = {}) {
  const params = new URLSearchParams({ q: query });
  if (center) {
    params.set('lat', center.lat.toFixed(4));
    params.set('lon', center.lon.toFixed(4));
  }
  return request(`/api/geocode?${params}`, { signal });
}

/** Turn a clicked map point into a human-readable place name. */
export function reverseGeocode({ lat, lon }, { signal } = {}) {
  return request(`/api/geocode/reverse?lat=${lat}&lon=${lon}`, { signal });
}

/** MapLibre source definition for the Vantor imagery overlay. */
export const fetchImageryMeta = (opts) => request('/api/imagery/meta', opts);

/**
 * What imagery is actually on screen for a [minLon, minLat, maxLon, maxLat] box.
 * Resolves to { provenance: {...} | null } — null simply means no coverage.
 */
export function fetchImageryProvenance(bbox, mode, { signal } = {}) {
  const b = bbox.map((n) => n.toFixed(4)).join(',');
  const q = new URLSearchParams({ bbox: b });
  if (mode) q.set('mode', mode);
  return request(`/api/imagery/provenance?${q}`, { signal });
}

/** MapLibre source definition for the TomTom traffic flow overlay. */
export const fetchTrafficMeta = (opts) => request('/api/traffic/meta', opts);

/** Live traffic incidents within a [minLon, minLat, maxLon, maxLat] box. */
export function fetchTrafficIncidents(bbox, { signal } = {}) {
  const b = bbox.map((n) => n.toFixed(4)).join(',');
  return request(`/api/traffic/incidents?bbox=${b}`, { signal });
}

/** POI layer definitions, including which have no data source and why. */
export const fetchPoiLayers = (opts) => request('/api/pois/layers', opts);

/** Category browse for the current viewport. No free text is ever sent. */
export function fetchPois(bbox, layers, { signal } = {}) {
  const b = bbox.map((n) => n.toFixed(4)).join(',');
  return request(`/api/pois?bbox=${b}&layers=${layers.join(',')}`, { signal });
}

/** POIs within a corridor around the active convoy route. */
export function fetchPoisAlongRoute({ route, layers, corridorKm }, { signal } = {}) {
  return request('/api/pois/along-route', {
    method: 'POST',
    signal,
    body: { route, layers, corridorKm },
  });
}

/** DEM availability and the MapLibre raster-dem source definition. */
export const fetchTerrainMeta = (opts) => request('/api/terrain/meta', opts);

/** All imagery + elevation captures over an AOI, on one time axis. */
export function fetchCaptures(bbox, { signal } = {}) {
  const b = bbox.map((n) => n.toFixed(4)).join(',');
  return request(`/api/temporal/captures?bbox=${b}`, { signal });
}

/**
 * Change detection. Currently answers 501 from a stubbed detectChange(); the client
 * reads `implemented` and `summary`, so a real implementation needs no client change.
 */
export async function requestChangeDetection({ aoi, from, to }, { signal } = {}) {
  const res = await fetch('/api/temporal/change', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ aoi, from, to }),
  });
  // 501 is the expected stub response and carries a valid ChangeResult body.
  return res.json();
}

/** Constraint-aware route + alternatives for a vehicle profile. */

export function requestRoute(
  { start, end, profileId, custom, maxAlternatives = 3, avoid, departAt, arriveAt },
  { signal } = {},
) {
  return request('/api/route', {
    method: 'POST',
    signal,
    // task 7: `avoid` is validated server-side against the verified list, so an
    // unsupported value here is dropped rather than failing the whole route.
    // task 8: departAt/arriveAt are mutually exclusive; the server enforces that.
    body: { start, end, profileId, custom, maxAlternatives, avoid, departAt, arriveAt },
  });
}

/**
 * ux-insight: travel time at several departure hours.
 *
 * Separate from the route request because it costs one vendor call per hour and is only
 * wanted when someone is actually thinking about departure time — fetched when that
 * panel is opened, not on every route.
 */
export function fetchTimeProfile({ start, end, profileId, custom, avoid }, { signal } = {}) {
  return request('/api/route/time-profile', {
    method: 'POST',
    signal,
    body: { start, end, profileId, custom, avoid },
  });
}
