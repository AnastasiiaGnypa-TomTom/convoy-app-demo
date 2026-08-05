/**
 * Terrain / DEM — /api/terrain
 *
 * Proxies DEM tiles so the frontend never talks to an upstream host and a future
 * keyed DEM (Vantor, or a commercial provider) needs no frontend change and leaks
 * no credential. Also reports availability so the client can disable 3D and
 * hillshade cleanly instead of rendering black terrain.
 */

import { Router } from 'express';
import {
  DEFAULT_EXAGGERATION,
  DEM_SOURCE,
  checkDemAvailable,
  demSourceForClient,
  demTileUrl,
} from '../lib/terrain.js';

export const terrainRouter = Router();

terrainRouter.get('/meta', async (_req, res) => {
  const availability = await checkDemAvailable();
  res.set('cache-control', 'public, max-age=120');
  res.json({
    available: availability.available,
    detail: availability.available ? DEM_SOURCE.detail : availability.detail,
    vendor: DEM_SOURCE.vendor,
    label: DEM_SOURCE.label,
    encoding: DEM_SOURCE.encoding,
    maxzoom: DEM_SOURCE.maxzoom,
    defaultExaggeration: DEFAULT_EXAGGERATION,
    source: demSourceForClient(),
  });
});

terrainRouter.get('/:z/:x/:y.png', async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  const max = 2 ** z;

  if (!Number.isInteger(z) || z < 0 || z > DEM_SOURCE.maxzoom + 2) {
    return res.status(400).json({ error: 'invalid zoom' });
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= max || y >= max) {
    return res.status(400).json({ error: 'tile out of range for zoom' });
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const upstream = await fetch(demTileUrl({ z, x, y }), {
      headers: DEM_SOURCE.authHeader?.() || {},
      signal: ctl.signal,
    });
    if (!upstream.ok) {
      // 404 at the edge of DEM coverage is normal; MapLibre treats it as no data.
      return res.status(upstream.status).end();
    }
    res.set('content-type', upstream.headers.get('content-type') || 'image/png');
    // Elevation is static — cache hard so panning in 3D stays smooth.
    res.set('cache-control', 'public, max-age=604800, immutable');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    console.warn(`[terrain] z${z}/${x}/${y} → ${reason}`);
    return res.status(504).end();
  } finally {
    clearTimeout(timer);
  }
});
