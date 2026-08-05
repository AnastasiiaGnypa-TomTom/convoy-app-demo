/**
 * 3D buildings.
 *
 * ── Height source: TomTom Orbis, confirmed ────────────────────────────────
 * No OSM fallback is needed. The Orbis style already ships a `3D - Building`
 * fill-extrusion layer on source-layer `buildings`, and it carries real heights:
 *
 *   fill-extrusion-height : ["case", ["has","height"],        ["get","height"], 4]
 *   fill-extrusion-base   : ["case", ["has","ground_height"], ["get","ground_height"], 0]
 *
 * TomTom ships it switched off two ways: `layout.visibility: "none"` AND a leading
 * `false` in its filter — ["all", false, …]. Both have to be undone, which is why
 * simply setting visibility was not enough.
 *
 * The 4 m fallback matters: buildings without a height attribute extrude to 4 m
 * rather than vanishing, so a partially-attributed city still reads as built-up
 * instead of pockmarked with holes.
 *
 * ── Why the base style changes with it ────────────────────────────────────
 * Draped satellite imagery already shows rooftops from above. Standing extrusions
 * on top of that produce the "doubled building" artifact — a photographed roof at
 * ground level plus a solid block rising out of it. So this implements option (a)
 * from the brief: 3D buildings is a dedicated look on the VECTOR style, and the
 * caller turns imagery off while it is active. Satellite drape remains the right
 * choice for terrain, and stays available.
 */

const BUILDINGS_LAYER = '3D - Building';
/** Companion layers that give the extrusions a base shadow / occlusion feel. */
const SHADOW_LAYER = 'Buildings - Shadow';
const FILL_LAYER = 'Buildings - Fill';

/** Original values, so the style is restored exactly when buildings are turned off. */
let saved = null;

const set = (map, id, prop, value, kind = 'paint') => {
  try {
    if (kind === 'paint') map.setPaintProperty(id, prop, value);
    else map.setLayoutProperty(id, prop, value);
  } catch {
    /* layer or property missing — harmless */
  }
};

export const hasBuildingsLayer = (map) => Boolean(map?.getLayer?.(BUILDINGS_LAYER));

/**
 * Turn the extrusions on.
 *
 * Fades in from z14 so a wide view is not a field of grey blocks, and uses a
 * height-driven colour ramp plus a vertical gradient so blocks read as solid
 * volumes rather than flat silhouettes.
 */
export function enableBuildings3D(map) {
  if (!hasBuildingsLayer(map) || saved) return false;

  const layer = map.getStyle().layers.find((l) => l.id === BUILDINGS_LAYER);
  saved = {
    filter: layer?.filter,
    visibility: layer?.layout?.visibility ?? 'visible',
    paint: {
      'fill-extrusion-opacity': layer?.paint?.['fill-extrusion-opacity'],
      'fill-extrusion-color': layer?.paint?.['fill-extrusion-color'],
      'fill-extrusion-vertical-gradient': layer?.paint?.['fill-extrusion-vertical-gradient'],
    },
    shadowOpacity: map.getLayer(SHADOW_LAYER)
      ? map.getStyle().layers.find((l) => l.id === SHADOW_LAYER)?.paint?.['fill-opacity']
      : undefined,
  };

  // 1. Undo TomTom's two "off" switches.
  if (Array.isArray(saved.filter) && saved.filter[0] === 'all') {
    const next = [...saved.filter];
    // Element 1 is the hard-coded `false` that disables the layer.
    if (next[1] === false) next[1] = true;
    try {
      map.setFilter(BUILDINGS_LAYER, next);
    } catch {
      /* filter shape unexpected — leave it */
    }
  }
  set(map, BUILDINGS_LAYER, 'visibility', 'visible', 'layout');

  /*
   * 2. Height-driven colour ramp.
   *
   * Taller blocks render lighter, which separates towers from low-rise and gives a
   * flat city like Amsterdam visible structure — the whole point here, since over
   * flat terrain a tilted camera alone shows nothing.
   */
  set(map, BUILDINGS_LAYER, 'fill-extrusion-color', [
    'interpolate',
    ['linear'],
    ['case', ['has', 'height'], ['get', 'height'], 4],
    0,
    '#8d97a4',
    12,
    '#a7b1bd',
    30,
    '#c2cad4',
    80,
    '#dde3ea',
  ]);

  // 3. Vertical gradient: MapLibre shades wall tops lighter than bases — the cheap
  //    ambient-occlusion feel that makes blocks look solid rather than pasted on.
  set(map, BUILDINGS_LAYER, 'fill-extrusion-vertical-gradient', true);

  // 4. Fade in past z14, and go nearly opaque once close so blocks look solid.
  set(map, BUILDINGS_LAYER, 'fill-extrusion-opacity', [
    'interpolate',
    ['linear'],
    ['zoom'],
    14,
    0,
    15.5,
    0.75,
    17,
    0.95,
  ]);

  // 5. Strengthen the footprint shadow for contact with the ground.
  if (map.getLayer(SHADOW_LAYER)) {
    set(map, SHADOW_LAYER, 'fill-opacity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      14,
      0,
      16,
      0.55,
    ]);
  }

  return true;
}

/** Restore the style exactly as TomTom shipped it. */
export function disableBuildings3D(map) {
  if (!saved || !hasBuildingsLayer(map)) {
    saved = null;
    return;
  }
  try {
    if (saved.filter) map.setFilter(BUILDINGS_LAYER, saved.filter);
  } catch {
    /* ignore */
  }
  set(map, BUILDINGS_LAYER, 'visibility', saved.visibility, 'layout');
  for (const [prop, value] of Object.entries(saved.paint)) {
    set(map, BUILDINGS_LAYER, prop, value);
  }
  if (saved.shadowOpacity !== undefined && map.getLayer(SHADOW_LAYER)) {
    set(map, SHADOW_LAYER, 'fill-opacity', saved.shadowOpacity);
  }
  // The vector fill must come back or the ground reads as empty at high zoom.
  set(map, FILL_LAYER, 'visibility', 'visible', 'layout');
  saved = null;
}

export const isBuildings3DActive = () => saved !== null;
