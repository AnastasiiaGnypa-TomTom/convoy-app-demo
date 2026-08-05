/**
 * Temporal captures and the change-detection seam — /api/temporal
 *
 * One time axis for imagery and elevation. The change endpoint is deliberately
 * stubbed: it calls the real detectChange() interface and returns its honest
 * "not implemented" result, so the UI is already wired to the shape a real diff
 * will produce. See server/lib/temporal.js for the contract.
 */

import { Router } from 'express';
import { createCache } from '../lib/cache.js';
import { detectChange, listCaptures } from '../lib/temporal.js';
import { hasVantorKey } from '../lib/vantor.js';

export const temporalRouter = Router();

// Captures over an AOI change only when new imagery is published.
const captureCache = createCache({ ttlMs: 10 * 60_000 });

function parseBbox(raw) {
  const parts = String(raw || '')
    .split(',')
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (maxLon <= minLon || maxLat <= minLat) return null;
  return parts;
}

/** All captures over the AOI, newest first, on one time axis. */
temporalRouter.get('/captures', async (req, res, next) => {
  const bbox = parseBbox(req.query.bbox);
  if (!bbox) return res.status(400).json({ error: 'bbox must be minLon,minLat,maxLon,maxLat' });
  if (!hasVantorKey()) return res.status(503).json({ error: 'imagery vendor not configured' });

  const key = bbox.map((n) => n.toFixed(3)).join(',');
  const cached = captureCache.get(key);
  if (cached) {
    res.set('x-cache', 'hit');
    return res.json(cached);
  }

  try {
    const payload = await listCaptures(bbox);
    captureCache.set(key, payload);
    res.set('x-cache', 'miss');
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

/**
 * Change detection — STUB.
 *
 * Returns 501 with a well-formed ChangeResult body rather than an error, because the
 * UI renders the summary and needs a real response from a real endpoint. When
 * detectChange() is implemented, this route starts returning 200 and the client
 * needs no change: it already reads `implemented`, `summary` and `features`.
 */
temporalRouter.post('/change', async (req, res, next) => {
  const { aoi, from, to } = req.body || {};
  const bbox = Array.isArray(aoi) ? aoi : parseBbox(aoi);
  if (!bbox) return res.status(400).json({ error: 'aoi must be [minLon,minLat,maxLon,maxLat]' });
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to capture timestamps are required' });
  }

  try {
    const result = await detectChange(bbox, from, to);
    // 501 while stubbed; a real implementation returns implemented: true and 200.
    return res.status(result.implemented ? 200 : 501).json(result);
  } catch (err) {
    return next(err);
  }
});
