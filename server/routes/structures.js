/**
 * Bridges and tunnels as GeoJSON, for zoom levels where the client cannot get them.
 *
 * Above zoom 12 the client reads these straight out of the basemap vector tiles it is
 * already loading — no request, no cost, and that path stays. This route exists only for
 * z10-z12, where TomTom has stripped the attributes from the tiles the camera would
 * fetch, so the only way to have them is to read deeper tiles server-side.
 *
 * See lib/structures.js for why no client-side workaround is possible.
 */

import { Router } from 'express';
import { MIN_REQUEST_ZOOM, structuresAlongRoute, structuresForBbox } from '../lib/structures.js';

export const structuresRouter = Router();

structuresRouter.get('/', async (req, res, next) => {
  const parts = String(req.query.bbox || '')
    .split(',')
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'bbox must be minLon,minLat,maxLon,maxLat' });
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (maxLon <= minLon || maxLat <= minLat) {
    return res.status(400).json({ error: 'bbox must be minLon,minLat,maxLon,maxLat' });
  }

  const zoom = Number(req.query.zoom);
  /*
   * Refused rather than silently degraded. Below z10 a single viewport needs hundreds of
   * source tiles, so the honest answer is "not at this zoom" — the client shows that as a
   * note instead of drawing an incomplete picture that looks complete.
   */
  if (Number.isFinite(zoom) && zoom < MIN_REQUEST_ZOOM) {
    return res.status(422).json({
      error: `Bridges and tunnels need zoom ${MIN_REQUEST_ZOOM} or closer.`,
      reason:
        'TomTom omits the bridge/tunnel attributes from tiles below zoom 12, so they must be read from deeper tiles; below zoom 10 that is too many tiles for one view.',
      minZoom: MIN_REQUEST_ZOOM,
    });
  }

  try {
    const result = await structuresForBbox([minLon, minLat, maxLon, maxLat], {
      /*
       * Fetched through this app's OWN tile proxy, not directly from TomTom.
       *
       * That keeps the vendor key in exactly one place — the basemap module — instead of
       * this route growing its own copy of the key handling. It also inherits the proxy's
       * rate limiting and error behaviour for free. The loopback hop costs nothing
       * measurable next to the upstream request.
       */
      fetchTile: async ({ z, x, y }) => {
        const port = req.socket.localPort;
        const r = await fetch(`http://127.0.0.1:${port}/api/basemap/tile/${z}/${x}/${y}.pbf`);
        if (!r.ok) return null;
        return Buffer.from(await r.arrayBuffer());
      },
    });

    // Static enough to cache hard; the geometry of a bridge does not move.
    res.set('cache-control', 'public, max-age=3600');
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * Structures along an active route, at any zoom.
 *
 * POST because a route polyline does not belong in a query string. Not zoom-gated: a
 * corridor's tile count grows with route length, not with how far out the camera is.
 */
structuresRouter.post('/along-route', async (req, res, next) => {
  const { route, corridorM } = req.body || {};
  if (!Array.isArray(route) || route.length < 2) {
    return res.status(400).json({ error: 'route must be an array of at least 2 {lat, lon} points' });
  }

  // Thin very dense polylines: tile selection does not need metre-level detail.
  const step = Math.max(1, Math.ceil(route.length / 600));
  const points = route.filter((_, i) => i % step === 0 || i === route.length - 1);

  try {
    const result = await structuresAlongRoute(points, {
      corridorM: Math.min(5000, Math.max(200, Number(corridorM) || 1500)),
      fetchTile: async ({ z, x, y }) => {
        const port = req.socket.localPort;
        const r = await fetch(`http://127.0.0.1:${port}/api/basemap/tile/${z}/${x}/${y}.pbf`);
        if (!r.ok) return null;
        return Buffer.from(await r.arrayBuffer());
      },
    });
    res.set('cache-control', 'no-store');
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});
