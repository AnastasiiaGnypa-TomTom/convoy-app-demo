import maplibregl from 'maplibre-gl';
import { iconIdFor, registerPoiIcons } from './poiIcons.js';

/**
 * Critical-infrastructure POI layers.
 *
 * Drawn above imagery and traffic but below nothing — these are the topmost
 * interactive markers, since the whole point is being able to click a site and see
 * what it is.
 *
 * Colour comes from the server's category registry, so the map, the legend and the
 * checkboxes cannot drift apart.
 */

export const POI_SOURCE = 'infra-pois';
export const POI_LAYERS = {
  /** Low-zoom dot: cheap, never decluttered away, so nothing is invisible. */
  dot: 'infra-poi-dot',
  /** Icon badge, from mid zoom up. */
  icon: 'infra-poi-icon',
  label: 'infra-poi-label',
};

/**
 * Zoom at which icons take over from plain dots.
 *
 * Below this the markers are dots: at wide zoom an icon badge would be larger than
 * the feature it marks and the map turns to soup. Dots stay visible at every zoom
 * the data loads at, so the layer never looks empty just because it is zoomed out.
 */
/*
 * Icons carry the category letter, plain dots do not.
 *
 * This was 9, so anything wider than city scale showed featureless coloured circles —
 * you could see that something was there but not what. Lowered to 7 and the icon scaled
 * down to match, so the letter is legible at regional zoom instead of a blob. The dot
 * layer is kept only below that, where even a small icon would be noise.
 */
const ICON_MIN_ZOOM = 7;

const EMPTY = { type: 'FeatureCollection', features: [] };

/** Build a MapLibre `match` expression mapping category id → colour. */
function colorExpression(categories) {
  const expr = ['match', ['get', 'layer']];
  for (const c of categories) expr.push(c.id, c.color);
  expr.push('#94a3b8'); // fallback
  return expr;
}

export function ensurePoiLayers(map, categories) {
  if (map.getLayer(POI_LAYERS.icon)) return;
  if (!map.getSource(POI_SOURCE)) {
    map.addSource(POI_SOURCE, { type: 'geojson', data: EMPTY });
  }

  registerPoiIcons(map, categories);
  const color = colorExpression(categories);

  // Dots carry the low zooms. Deliberately allow-overlap so a dense area still
  // shows density rather than being thinned out by the collision grid.
  map.addLayer({
    id: POI_LAYERS.dot,
    type: 'circle',
    source: POI_SOURCE,
    maxzoom: ICON_MIN_ZOOM,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.6, 6, 3.4, ICON_MIN_ZOOM, 4.2],
      'circle-color': color,
      'circle-stroke-width': 1.2,
      'circle-stroke-color': 'rgba(11,16,22,0.9)',
      'circle-opacity': 0.95,
      // Fade in. New POIs arriving mid-pan used to appear instantly, which reads as a
      // flicker; a short ramp makes the same update feel like settling rather than
      // reloading. Paint transitions are per-property, hence the -transition keys.
      'circle-opacity-transition': { duration: 320, delay: 0 },
      'circle-stroke-opacity-transition': { duration: 320, delay: 0 },
    },
  });

  // Icon badges from mid zoom. Overlap is allowed so counts on screen match the
  // panel — silently dropping markers to avoid collisions reads as missing data.
  map.addLayer({
    id: POI_LAYERS.icon,
    type: 'symbol',
    source: POI_SOURCE,
    minzoom: ICON_MIN_ZOOM,
    layout: {
      visibility: 'none',
      'icon-image': ['concat', 'poi-icon-', ['get', 'layer']],
      /*
       * Sized so the letter is readable at every zoom, and clearly larger as you zoom in.
       *
       * The old ramp started at 0.5 and only reached 0.62 by z9, which at a regional view
       * rendered as anonymous coloured dots — the category letter was there but far too
       * small to read, so the layers were indistinguishable from each other.
       */
      /*
       * Target on-screen diameters, against the 48 px logical base (see poiIcons.js):
       *   z9  ~22 px   regional — letter readable
       *   z12 ~30 px   city
       *   z14 ~38 px
       *   z16 ~46 px   street level
       * Expressed as fractions of the base rather than round numbers so the intent
       * survives a change to the bitmap size.
       */
      'icon-size': [
        'interpolate',
        ['linear'],
        ['zoom'],
        ICON_MIN_ZOOM,
        0.42,
        9,
        0.46,
        12,
        0.63,
        14,
        0.79,
        16,
        0.96,
        18,
        1.1,
      ],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-anchor': 'center',
    },
    paint: {
      // Fade in. New POIs arriving after a pan used to appear instantly, which reads as
      // a flicker; a short ramp makes an update feel like settling rather than
      // reloading. Transitions are per-property, hence the -transition key.
      'icon-opacity': 1,
      'icon-opacity-transition': { duration: 320, delay: 0 },
    },
  });

  // Labels only once genuinely zoomed in, and these DO declutter — overlapping
  // text is unreadable, unlike overlapping markers.
  map.addLayer({
    id: POI_LAYERS.label,
    type: 'symbol',
    source: POI_SOURCE,
    minzoom: 14,
    layout: {
      visibility: 'none',
      'text-field': ['get', 'name'],
      /*
       * Must be a font the basemap's glyph service actually serves.
       *
       * Without this, MapLibre falls back to its default
       * "Open Sans Regular,Arial Unicode MS Regular", which the Orbis glyph endpoint
       * returns 404 for — so POI name labels silently never rendered. The Orbis style
       * itself uses Noto.
       */
      'text-font': ['Noto-Regular'],
      'text-size': 11,
      'text-offset': [0, 1.3],
      'text-anchor': 'top',
      'text-max-width': 12,
      'text-allow-overlap': false,
      'text-optional': true,
    },
    paint: {
      'text-color': '#f0f6fc',
      'text-opacity-transition': { duration: 320, delay: 0 },
      'text-halo-color': '#0b1016',
      'text-halo-width': 1.8,
    },
  });
}

export function setPoiData(map, featureCollection) {
  const source = map.getSource(POI_SOURCE);
  if (source) source.setData(featureCollection || EMPTY);
}

export function setPoiVisible(map, visible) {
  for (const id of Object.values(POI_LAYERS)) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }
}

/**
 * Click a marker to see what it is. Returns a cleanup function.
 *
 * Deliberately does NOT show TomTom's raw `classification` code: it reports
 * "SCHOOL" for military installations (verified on Ramstein Air Base), which would
 * read as a bug on screen. The category label we asked for is the honest field.
 */
export function bindPoiClicks(map, getCategoryLabel, onSelect) {
  let popup = null;

  const onClick = (e) => {
    const f = e.features?.[0];
    if (!f) return;
    // Prefer the app's place card when one is wired; fall back to a popup.
    if (onSelect) {
      onSelect(f.properties, f.geometry.coordinates);
      return;
    }
    const p = f.properties || {};
    const label = getCategoryLabel(p.layer) || p.layer;

    const esc = (s) =>
      String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

    /*
     * The REAL TomTom classification is shown, not just our layer name. That is how
     * a wrong mapping becomes visible in one click instead of surviving a demo.
     */
    const lines = [
      `<strong>${esc(p.name)}</strong>`,
      `<span class="poi-pop-cat">${esc(label)}</span>`,
      `<span class="poi-pop-code">TomTom: ${esc(p.tomtomCategory || 'unknown')}</span>`,
      p.address ? `<span class="poi-pop-addr">${esc(p.address)}</span>` : '',
    ]
      .filter(Boolean)
      .join('');

    popup?.remove();
    popup = new maplibregl.Popup({ closeButton: true, offset: 10, maxWidth: '260px' })
      .setLngLat(f.geometry.coordinates)
      .setHTML(`<div class="poi-popup">${lines}</div>`)
      .addTo(map);
  };

  const enter = () => {
    map.getCanvas().style.cursor = 'pointer';
  };
  const leave = () => {
    map.getCanvas().style.cursor = '';
  };

  const clickable = [POI_LAYERS.icon, POI_LAYERS.dot];
  for (const id of clickable) {
    map.on('click', id, onClick);
    map.on('mouseenter', id, enter);
    map.on('mouseleave', id, leave);
  }

  return () => {
    for (const id of clickable) {
      map.off('click', id, onClick);
      map.off('mouseenter', id, enter);
      map.off('mouseleave', id, leave);
    }
    popup?.remove();
  };
}

/* ──────────────────── "show me these" highlight ──────────────────── */

export const POI_HIGHLIGHT_LAYER = 'infra-poi-highlight';

/**
 * A ring drawn behind the POIs of one layer.
 *
 * Sits UNDER the icons so it frames them rather than covering them, and it is a
 * separate layer rather than a paint change on the existing ones — that way turning the
 * highlight on and off cannot disturb the normal styling or the click targets.
 */
export function ensurePoiHighlightLayer(map) {
  if (map.getLayer(POI_HIGHLIGHT_LAYER) || !map.getSource(POI_SOURCE)) return;
  map.addLayer(
    {
      id: POI_HIGHLIGHT_LAYER,
      type: 'circle',
      source: POI_SOURCE,
      // Matches nothing until a layer is chosen.
      filter: ['==', ['get', 'layer'], '__none__'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 20],
        'circle-color': 'rgba(56,189,248,0.18)',
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#38bdf8',
      },
    },
    map.getLayer(POI_LAYERS.dot) ? POI_LAYERS.dot : undefined,
  );
}

export function setPoiHighlight(map, layerId) {
  if (!map.getLayer(POI_HIGHLIGHT_LAYER)) return;
  map.setFilter(POI_HIGHLIGHT_LAYER, ['==', ['get', 'layer'], layerId || '__none__']);
}
