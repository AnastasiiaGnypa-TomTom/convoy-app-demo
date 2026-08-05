/**
 * Live traffic — /api/traffic
 *
 * Two complementary views, both proxied so the key stays server-side:
 *   - flow tiles: a raster congestion layer for the whole visible area
 *   - incidents: point/line features (jams, closures, roadworks) as GeoJSON
 *
 * A third view needs no endpoint at all: /api/route already returns
 * `trafficSections` per route, so congestion along the chosen route is drawn from
 * the routing response rather than a second vendor call.
 *
 * Endpoint notes (verified live 2026-07-29): Traffic Flow v4 and Incidents v5 both
 * work on this key. The Orbis traffic tile path rejects the v4 style names, so the
 * classic flow tile service is used.
 */

import { Router } from 'express';
import { createCache } from '../lib/cache.js';
import { VendorError, tomtomFetch, tomtomJson, tomtomUrl } from '../lib/tomtom.js';

export const trafficRouter = Router();

/* -------------------------------------------------------------------------- */
/*  CONFIG POINT — flow tile style                                            */
/*  relative0 colours every road by speed relative to free flow, which reads   */
/*  best as a demo backdrop. Alternatives: absolute, relative, relative-delay,  */
/*  reduced-sensitivity.                                                       */
/* -------------------------------------------------------------------------- */
const FLOW_STYLE = 'relative0';
const FLOW_MAX_ZOOM = 22;

// Incidents change on the order of a minute; caching keeps panning cheap.
const incidentCache = createCache({ ttlMs: 60_000 });

trafficRouter.get('/meta', (_req, res) => {
  res.set('cache-control', 'public, max-age=3600');
  res.json({
    flow: {
      source: {
        type: 'raster',
        tiles: ['/api/traffic/tile/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: FLOW_MAX_ZOOM,
        attribution: 'Traffic © TomTom',
      },
      style: FLOW_STYLE,
    },
  });
});

/* ------------------------------------------------------------- flow tiles */

trafficRouter.get('/tile/:z/:x/:y.png', async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  const max = 2 ** z;

  if (!Number.isInteger(z) || z < 0 || z > FLOW_MAX_ZOOM) {
    return res.status(400).json({ error: 'invalid zoom' });
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= max || y >= max) {
    return res.status(400).json({ error: 'tile out of range for zoom' });
  }

  try {
    const url = tomtomUrl(`/traffic/map/4/tile/flow/${FLOW_STYLE}/${z}/${x}/${y}.png`);
    const vendorRes = await tomtomFetch(url, { timeoutMs: 15_000 });
    if (!vendorRes.ok) {
      if (vendorRes.status !== 404) console.warn(`[traffic] tile z${z} → HTTP ${vendorRes.status}`);
      return res.status(vendorRes.status).end();
    }
    res.set('content-type', vendorRes.headers.get('content-type') || 'image/png');
    // Short cache: this is live data, but repeated pans within a demo shouldn't
    // each cost a vendor call.
    res.set('cache-control', 'public, max-age=60');
    return res.send(Buffer.from(await vendorRes.arrayBuffer()));
  } catch (err) {
    return res.status(err.status || 502).end();
  }
});

/* -------------------------------------------------------------- incidents */

/** Map TomTom's iconCategory to a short label the UI can show. */
const INCIDENT_CATEGORY = {
  0: 'Unknown',
  1: 'Accident',
  2: 'Fog',
  3: 'Dangerous conditions',
  4: 'Rain',
  5: 'Ice',
  6: 'Jam',
  7: 'Lane closed',
  8: 'Road closed',
  9: 'Roadworks',
  10: 'Wind',
  11: 'Flooding',
  14: 'Broken-down vehicle',
};

trafficRouter.get('/incidents', async (req, res, next) => {
  const bbox = String(req.query.bbox || '').trim();
  // minLon,minLat,maxLon,maxLat
  const parts = bbox.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'bbox must be minLon,minLat,maxLon,maxLat' });
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (maxLon <= minLon || maxLat <= minLat) {
    return res.status(400).json({ error: 'bbox is inverted or empty' });
  }
  // A very large bbox returns thousands of incidents and slows the demo down.
  if (maxLon - minLon > 5 || maxLat - minLat > 5) {
    return res.json({ type: 'FeatureCollection', features: [], note: 'bbox too large — zoom in' });
  }

  const key = parts.map((n) => n.toFixed(3)).join(',');
  const cached = incidentCache.get(key);
  if (cached) {
    res.set('x-cache', 'hit');
    return res.json(cached);
  }

  const fields =
    '{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,delay,startTime,endTime,from,to,roadNumbers,events{description}}}}';

  try {
    const json = await tomtomJson(
      tomtomUrl('/traffic/services/5/incidentDetails', {
        bbox: key,
        fields,
        language: 'en-GB',
        timeValidityFilter: 'present',
      }),
      { timeoutMs: 12_000 },
    );

    const features = (json.incidents || [])
      .filter((i) => i.geometry?.coordinates?.length)
      .map((i, index) => {
        const p = i.properties || {};
        return {
          type: 'Feature',
          id: index,
          geometry: i.geometry,
          properties: {
            category: INCIDENT_CATEGORY[p.iconCategory] || 'Incident',
            iconCategory: p.iconCategory ?? 0,
            magnitudeOfDelay: p.magnitudeOfDelay ?? 0,
            delaySeconds: p.delay ?? null,
            description: p.events?.[0]?.description || null,
            from: p.from || null,
            to: p.to || null,
            roadNumbers: p.roadNumbers || [],
          },
        };
      });

    const payload = { type: 'FeatureCollection', features };
    incidentCache.set(key, payload);
    res.set('x-cache', 'miss');
    return res.json(payload);
  } catch (err) {
    if (err instanceof VendorError) {
      // Traffic is enrichment, not core: degrade to empty rather than erroring the UI.
      console.warn('[traffic] incidents unavailable:', err.message);
      return res.json({ type: 'FeatureCollection', features: [], note: 'traffic incidents unavailable' });
    }
    return next(err);
  }
});
