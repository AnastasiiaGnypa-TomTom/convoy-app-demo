#!/usr/bin/env node
/**
 * Build the demo POI cache for the Emmen -> Locarno corridor.
 *
 *   npm run cache:demo          (server must be running on PORT, default 8080)
 *
 * Writes server/data/poi-cache-demo.json. Delete that file to go back to live fetching —
 * there is no flag to flip and no code to change.
 *
 * Deliberately talks to the running server's own endpoints rather than calling TomTom
 * directly. Those endpoints already hold the verified allowlist, the runtime category
 * assertion and the corridor logic; duplicating any of that here would mean the cached
 * data could differ from what the live path would have returned, which is exactly the
 * bug a demo cache must not have.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEMO_CACHE_FILE } from '../lib/demoPoiCache.js';

const BASE = process.env.DEMO_CACHE_BASE || `http://localhost:${process.env.PORT || 8080}`;

/** The filmed route. */
const START = { lat: 47.092, lon: 8.305 }; // Emmen Airport, Switzerland
const END = { lat: 46.161, lon: 8.879 }; // Locarno Airport, Switzerland
/** Wide enough that panning around the corridor still hits the cache. */
const CORRIDOR_KM = 10;

const j = async (path, init) => {
  const r = await fetch(`${BASE}${path}`, init);
  if (!r.ok) throw new Error(`${path} → ${r.status} ${(await r.text()).slice(0, 140)}`);
  return r.json();
};

(async () => {
  console.log(`Building demo POI cache from ${BASE}`);

  const meta = await j('/api/pois/layers');
  const layers = (meta.layers || []).filter((l) => l.hasSource).map((l) => l.id);
  if (!layers.length) throw new Error('no sourced POI layers reported by /api/pois/layers');
  console.log(`  ${layers.length} sourced layers: ${layers.join(', ')}`);

  const route = await j('/api/route', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ start: START, end: END, profileId: 'heavy-truck' }),
  });
  const feature = route.routes?.features?.[0];
  if (!feature) throw new Error('routing returned no route for the demo endpoints');
  const coords = feature.geometry.coordinates;
  console.log(`  route: ${(feature.properties.lengthMeters / 1000).toFixed(0)} km, ${coords.length} points`);

  const pois = await j('/api/pois/along-route', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      route: coords.map(([lon, lat]) => ({ lat, lon })),
      layers,
      corridorKm: CORRIDOR_KM,
    }),
  });

  const payload = {
    builtAt: new Date().toISOString(),
    note: 'Demo cache for the Emmen -> Locarno corridor. Delete this file to return to live POI fetching.',
    start: START,
    end: END,
    corridorM: CORRIDOR_KM * 1000,
    route: coords,
    perLayer: pois.perLayer || {},
    features: pois.features || [],
  };

  mkdirSync(dirname(DEMO_CACHE_FILE), { recursive: true });
  writeFileSync(DEMO_CACHE_FILE, JSON.stringify(payload));
  const kb = (JSON.stringify(payload).length / 1024).toFixed(0);
  console.log(`  ${payload.features.length} POIs cached (${kb} KB) → ${DEMO_CACHE_FILE}`);
  console.log(`  per layer: ${JSON.stringify(payload.perLayer)}`);
  console.log('Done. Delete the file to disable.');
})().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
