/**
 * Geocoding — /api/geocode
 *
 * Backs the start/destination autocomplete and the reverse lookup used when the
 * user picks points by clicking the map.
 *
 * Uses TomTom Search v2 with typeahead. Orbis places/geocode returns 401 on this
 * key (verified 2026-07-29), so Search v2 is the working path; swapping back is a
 * one-line change to SEARCH_PATH.
 */

import { Router } from 'express';
import { createCache } from '../lib/cache.js';
import { VendorError, tomtomJson, tomtomUrl } from '../lib/tomtom.js';

export const geocodeRouter = Router();

const SEARCH_PATH = '/search/2/search';
const REVERSE_PATH = '/search/2/reverseGeocode';

// Autocomplete fires per keystroke, so caching matters for both latency and quota.
const forwardCache = createCache({ ttlMs: 10 * 60_000 });
const reverseCache = createCache({ ttlMs: 30 * 60_000 });

/** Shape a TomTom result into the minimum the UI needs. */
function toSuggestion(r) {
  const a = r.address || {};
  // freeformAddress is the full string; the first segment is the useful headline.
  const primary =
    r.poi?.name ||
    a.streetNameAndNumber ||
    a.streetName ||
    a.municipality ||
    a.freeformAddress ||
    'Unnamed location';
  const secondaryParts = [a.municipalitySubdivision, a.municipality, a.countrySubdivision, a.country]
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i && v !== primary);

  return {
    id: r.id,
    type: r.type,
    primary,
    secondary: secondaryParts.join(', '),
    label: a.freeformAddress || primary,
    position: { lat: r.position.lat, lon: r.position.lon },
  };
}

/* ------------------------------------------------------- forward geocoding */

geocodeRouter.get('/', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ query: q, results: [] });

  // Bias results toward the map view when the client supplies its centre.
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const hasBias = Number.isFinite(lat) && Number.isFinite(lon);

  const cacheKey = `${q.toLowerCase()}|${hasBias ? `${lat.toFixed(2)},${lon.toFixed(2)}` : ''}`;
  const cached = forwardCache.get(cacheKey);
  if (cached) {
    res.set('x-cache', 'hit');
    return res.json(cached);
  }

  try {
    const json = await tomtomJson(
      tomtomUrl(`${SEARCH_PATH}/${encodeURIComponent(q)}.json`, {
        typeahead: 'true',
        limit: 6,
        // Keep suggestions to things a vehicle can actually be routed to.
        idxSet: 'POI,PAD,Str,Xstr,Geo,Addr',
        ...(hasBias ? { lat, lon, radius: 150000 } : {}),
      }),
      { timeoutMs: 8000 },
    );

    const payload = {
      query: q,
      results: (json.results || []).filter((r) => r.position).map(toSuggestion),
    };
    forwardCache.set(cacheKey, payload);
    res.set('x-cache', 'miss');
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------- reverse geocoding */

geocodeRouter.get('/reverse', async (req, res, next) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon are required' });
  }

  const cacheKey = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cached = reverseCache.get(cacheKey);
  if (cached) {
    res.set('x-cache', 'hit');
    return res.json(cached);
  }

  try {
    const json = await tomtomJson(
      tomtomUrl(`${REVERSE_PATH}/${lat},${lon}.json`, { radius: 200 }),
      { timeoutMs: 8000 },
    );
    const first = json.addresses?.[0];
    const payload = {
      position: { lat, lon },
      // Falling back to coordinates keeps map-click selection working even where
      // reverse geocoding has nothing (open water, unmapped ground).
      label: first?.address?.freeformAddress || `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    };
    reverseCache.set(cacheKey, payload);
    res.set('x-cache', 'miss');
    return res.json(payload);
  } catch (err) {
    if (err instanceof VendorError) {
      return res.json({ position: { lat, lon }, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` });
    }
    return next(err);
  }
});
