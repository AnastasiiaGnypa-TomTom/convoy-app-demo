/**
 * Basemap proxy — /api/basemap/*
 *
 * MapLibre needs a style.json plus vector tiles, a sprite and glyph ranges. TomTom
 * serves all of those only with an API key in the query string, so every one is
 * proxied through here: the browser fetches /api/basemap/*, this module attaches
 * the key, and the key never reaches frontend code or the browser network tab.
 *
 * ── Why the routes are path-based, not ?u=<encoded upstream> ───────────────
 * MapLibre substitutes {z}/{x}/{y} and {fontstack}/{range} by literal string
 * replacement on the URL, and it appends .json / .png / @2x.png to the sprite URL.
 * Percent-encoding an upstream URL into a query param breaks both: the braces
 * become %7B…%7D and are never substituted, and the sprite suffix lands after the
 * query string. So the placeholders stay literal in our own path, and the upstream
 * templates live server-side in `upstream` below.
 *
 * Verified live 2026-07-29 — the Orbis style references:
 *   tiles   https://api.tomtom.com/maps/orbis/map-display/tile/{z}/{x}/{y}.pbf?apiVersion=1
 *   sprite  https://api.tomtom.com/maps/orbis/assets/sprites/<ver>/sprite?map=<style>&apiVersion=1
 *   glyphs  https://api.tomtom.com/maps/orbis/assets/fonts/<ver>/{fontstack}/{range}.pbf?apiVersion=1
 */

import { Router } from 'express';
import { config } from '../lib/env.js';
import {
  ORBIS_API_VERSION,
  ORBIS_MAP_STYLE,
  redact,
  tomtomFetch,
  tomtomUrl,
} from '../lib/tomtom.js';

export const basemapRouter = Router();

/* -------------------------------------------------------------------------- */
/*  CONFIG POINT — development fallback basemap                               */
/*                                                                            */
/*  Only used if the TomTom key loses the Maps entitlement (Orbis style 403)   */
/*  or TOMTOM_API_KEY is unset, so the app still renders instead of showing a  */
/*  blank canvas in a live meeting. Keyless raster OSM.                        */
/* -------------------------------------------------------------------------- */
const FALLBACK_BASEMAP = {
  version: 8,
  name: 'Convoy fallback basemap (development only)',
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {
    'fallback-osm': {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0d1117' } },
    {
      id: 'fallback-osm',
      type: 'raster',
      source: 'fallback-osm',
      paint: { 'raster-saturation': -0.55, 'raster-brightness-max': 0.82 },
    },
  ],
};

/**
 * Upstream templates, key-stripped. Seeded with the shapes verified above so a
 * tile request that arrives before any style.json request still resolves, then
 * refreshed from the real style on every style.json fetch (which is how a TomTom
 * asset-version bump is picked up without a code change).
 */
const upstream = {
  tile: 'https://api.tomtom.com/maps/orbis/map-display/tile/{z}/{x}/{y}.pbf?apiVersion=1',
  sprite: `https://api.tomtom.com/maps/orbis/assets/sprites/0.8.1-0/sprite?map=${ORBIS_MAP_STYLE}&apiVersion=1`,
  glyphs:
    'https://api.tomtom.com/maps/orbis/assets/fonts/0.8.1-0/{fontstack}/{range}.pbf?apiVersion=1',
};

/** Tracks which basemap the last style.json served, for /api/capabilities. */
export const basemapState = {
  active: 'unknown',
  orbisStatus: null,
  detail: 'style.json not requested yet',
};

/** Remove any key TomTom embedded, so we never forward or double-append one. */
function stripKey(url) {
  return String(url)
    .replace(/([?&])key=[^&]*&?/gi, '$1')
    .replace(/[?&]$/, '');
}

/**
 * Rewrite an Orbis style so every vendor URL points back at this proxy, and
 * capture the upstream templates while we are here.
 */
function rewriteStyle(style, origin) {
  const out = structuredClone(style);
  const prefix = `${origin}/api/basemap`;

  for (const source of Object.values(out.sources || {})) {
    const first = Array.isArray(source.tiles) ? source.tiles[0] : source.url;
    if (!first) continue;
    if (/tomtom\.com/.test(first)) upstream.tile = stripKey(first);
    // Always hand MapLibre a tiles array — a TileJSON `url` would be another
    // round trip that also needs rewriting.
    delete source.url;
    source.tiles = [`${prefix}/tile/{z}/{x}/{y}.pbf`];
  }

  const spriteUrl = typeof out.sprite === 'string' ? out.sprite : out.sprite?.[0]?.url;
  if (spriteUrl && /tomtom\.com/.test(spriteUrl)) upstream.sprite = stripKey(spriteUrl);
  // MapLibre appends .json/.png/@2x.png to this, which our sprite route handles.
  out.sprite = `${prefix}/sprite`;

  if (typeof out.glyphs === 'string' && /tomtom\.com/.test(out.glyphs)) {
    upstream.glyphs = stripKey(out.glyphs);
  }
  out.glyphs = `${prefix}/glyphs/{fontstack}/{range}.pbf`;

  return out;
}

/** Insert a filename suffix before the query string (for sprite.json / @2x.png). */
function withSuffix(templateUrl, suffix) {
  const [path, query] = templateUrl.split('?');
  return query ? `${path}${suffix}?${query}` : `${path}${suffix}`;
}

/* --------------------------------------------------------------- style.json */

basemapRouter.get('/style.json', async (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;

  const serveFallback = (detail, level = 'warn') => {
    basemapState.active = 'fallback';
    basemapState.detail = detail;
    console[level]('[basemap]', detail);
    res.set('cache-control', 'no-store');
    return res.json(FALLBACK_BASEMAP);
  };

  if (!config.tomtomKey) {
    return serveFallback('TOMTOM_API_KEY not set — serving development fallback basemap');
  }

  const url = tomtomUrl('/maps/orbis/assets/styles/0.*/style.json', {
    apiVersion: ORBIS_API_VERSION.maps,
    map: ORBIS_MAP_STYLE,
  });

  try {
    const vendorRes = await tomtomFetch(url);
    if (!vendorRes.ok) {
      basemapState.orbisStatus = vendorRes.status;
      const body = redact(await vendorRes.text()).slice(0, 200);
      return serveFallback(
        vendorRes.status === 403
          ? 'TomTom Maps (Orbis basemap) is not enabled on this API key — serving development fallback basemap'
          : `Orbis style returned HTTP ${vendorRes.status} (${body}) — serving development fallback basemap`,
      );
    }

    const style = rewriteStyle(await vendorRes.json(), origin);
    basemapState.active = 'tomtom-orbis';
    basemapState.orbisStatus = 200;
    basemapState.detail = `TomTom Orbis ${ORBIS_MAP_STYLE}`;
    res.set('cache-control', 'public, max-age=300');
    return res.json(style);
  } catch (err) {
    return serveFallback(`Orbis style unreachable (${err.message}) — serving fallback basemap`);
  }
});

/* ------------------------------------------------- tiles / sprite / glyphs */

/** Stream an upstream asset through, attaching the key server-side. */
async function proxyAsset(res, vendorPath, { cache = 'public, max-age=86400', quiet404 = false }) {
  try {
    const vendorRes = await tomtomFetch(tomtomUrl(vendorPath), { timeoutMs: 20_000 });
    if (!vendorRes.ok) {
      // A 404 on a vector tile is normal — it just means no data at that z/x/y.
      if (!(quiet404 && vendorRes.status === 404)) {
        console.warn(`[basemap] ${redact(vendorPath).slice(0, 120)} → HTTP ${vendorRes.status}`);
      }
      return res.status(vendorRes.status).end();
    }
    const type = vendorRes.headers.get('content-type');
    if (type) res.set('content-type', type);
    res.set('cache-control', cache);
    return res.send(Buffer.from(await vendorRes.arrayBuffer()));
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
}

// Vector tiles.
basemapRouter.get('/tile/:z/:x/:y.pbf', (req, res) => {
  const { z, x, y } = req.params;
  // The source advertises maxzoom 22, and at z22 an x/y index reaches 7 digits.
  // Rejecting out-of-range zooms here avoids forwarding junk to TomTom.
  if (!(Number(z) >= 0 && Number(z) <= 22) || !/^\d{1,7}$/.test(x) || !/^\d{1,7}$/.test(y)) {
    return res.status(400).json({ error: 'invalid tile coordinate' });
  }
  const path = upstream.tile.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  return proxyAsset(res, path, { quiet404: true });
});

// Sprite: MapLibre asks for sprite.json, sprite.png, sprite@2x.json, sprite@2x.png.
basemapRouter.get('/sprite:suffix(*)', (req, res) => {
  const suffix = req.params.suffix || '';
  if (!/^(@2x)?\.(json|png)$/.test(suffix)) {
    return res.status(400).json({ error: 'invalid sprite request' });
  }
  return proxyAsset(res, withSuffix(upstream.sprite, suffix), {});
});

// Glyph ranges for label rendering.
basemapRouter.get('/glyphs/:fontstack/:range.pbf', (req, res) => {
  const { fontstack, range } = req.params;
  if (!/^\d+-\d+$/.test(range)) {
    return res.status(400).json({ error: 'invalid glyph range' });
  }
  const path = upstream.glyphs
    .replace('{fontstack}', encodeURIComponent(fontstack))
    .replace('{range}', range);
  return proxyAsset(res, path, {});
});
