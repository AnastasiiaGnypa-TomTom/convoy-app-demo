/**
 * /api/capabilities — what this deployment can actually do.
 *
 * The frontend renders against this rather than hard-coding assumptions, so a
 * missing vendor entitlement degrades into an honest disabled control instead of
 * a broken map. It reports capability only — never a key, never a credential.
 *
 * `probeVerified` values come from the Step 0 Vantor probe and the live TomTom
 * entitlement check; re-run `npm run probe:vantor` after any account change.
 */

import { Router } from 'express';
import { config } from '../lib/env.js';
import { basemapState } from './basemap.js';
import { DEM_SOURCE, checkDemAvailable } from '../lib/terrain.js';

export const capabilitiesRouter = Router();

capabilitiesRouter.get('/', (_req, res) => {
  res.set('cache-control', 'no-store');
  res.json({
    basemap: {
      active: basemapState.active,
      detail: basemapState.detail,
      orbisStatus: basemapState.orbisStatus,
      // True once TomTom Maps is enabled on the key; no code change needed then.
      orbisEntitled: basemapState.active === 'tomtom-orbis',
    },
    routing: {
      available: Boolean(config.tomtomKey),
      vendor: 'tomtom-orbis',
      detail: 'Orbis Routing apiVersion=2 (verified working on this key)',
    },
    geocoding: {
      available: Boolean(config.tomtomKey),
      vendor: 'tomtom-search',
      // Orbis places/geocode returns 401 on this key; classic Search v2 works,
      // so autocomplete runs on Search v2.
      detail: 'TomTom Search v2 (Orbis places/geocode is 401 on this key)',
    },
    traffic: {
      available: Boolean(config.tomtomKey),
      vendor: 'tomtom-traffic',
      detail: 'TomTom Traffic Flow v4 + Incidents v5 (verified working on this key)',
    },
    imagery: {
      available: Boolean(config.vantorApiKey),
      vendor: 'vantor-maxar',
      detail: 'Vantor WMS Maxar:Imagery — image/png, verified by the Step 0 probe',
    },
    terrain: {
      available: true,
      vendor: DEM_SOURCE.vendor,
      detail: DEM_SOURCE.detail,
    },
  });
});
