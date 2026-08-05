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
const ICON_MIN_ZOOM = 9;

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
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4.5, 8, 6.5, ICON_MIN_ZOOM, 8.5],
      'circle-color': color,
      'circle-stroke-width': 2,
      'circle-stroke-color': 'rgba(11,16,22,0.9)',
      'circle-opacity': 0.95,
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
      'icon-size': ['interpolate', ['linear'], ['zoom'], ICON_MIN_ZOOM, 0.85, 13, 1.05, 16, 1.35],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-anchor': 'center',
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
