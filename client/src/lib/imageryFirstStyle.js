/**
 * Imagery-first style transform.
 *
 * The Orbis basemap is a full street style: 121 layers, of which 20 are fills and 69
 * are lines. Drawn over satellite imagery that reads as clutter — land-use polygons
 * tint the ground, building footprints double up on buildings you can already see,
 * administrative hairlines cross everything, and every road carries a bright casing
 * ("outline") plus a fill.
 *
 * When imagery is on we therefore hide the basemap's *ground truth* layers — the
 * things the imagery already shows better — and keep only what imagery cannot give
 * you: names, and a muted road network for orientation. The reference is the Vantor
 * Hub: sharp imagery, few lines, quiet labels.
 *
 * The partnership framing is deliberate. Vantor supplies the ground; TomTom supplies
 * the labels, the road network and (above these) the route, traffic and POIs. Hiding
 * TomTom's decorative linework makes TomTom's *useful* layers more prominent, not
 * less.
 *
 * Every change is recorded so turning imagery off restores the street style exactly.
 */

/* ── Hidden outright: things the imagery itself shows, or pure administrivia ── */
const HIDE_PREFIXES = [
  'LULC', // land-use / landcover fills — the worst offender, tints the whole ground
  'Buildings', // footprints and shadows, over real rooftops
  '3D - Building',
  'Borders', // administrative and maritime hairlines
  'Areas', // pedestrian-area fills
  'Structure', // bridge & pier fills/shadows
  'Transit - Aeroway area',
  'House Number',
  // The basemap's own POI symbols compete with our POI markers for the same space.
  'POI',
];

/*
 * KEPT even with imagery on: the fallback surface for uncovered areas.
 *
 * Vantor imagery is AOI-limited, not global. Hiding the style background and the
 * water fill made everywhere outside coverage render near-black — at a country-wide
 * zoom the map looked broken rather than "no imagery here". Imagery is opaque, so
 * these cost nothing where it does cover; they only show through where it does not.
 */
const KEEP_AS_FALLBACK = ['background', 'Water - Fill', 'Water - Intermittent'];

/**
 * Road layers kept for orientation, muted. Only genuinely major classes: minor
 * roads, streets, tracks, paths and links are dropped because at imagery zooms the
 * road surface is plainly visible and the lines only obscure it.
 */
const KEEP_ROADS = [
  'Surface - Motorway & Trunk',
  'Surface - Primary road',
  'Surface - Secondary road',
  'Surface - Railway fill',
];

/** Everything road-ish that is neither kept nor a label. */
const ROAD_PREFIXES = ['Surface', 'Bridge', 'Tunnel'];

/** Label layers are always kept — this is what imagery cannot provide. */
const LABEL_PREFIXES = ['Places', 'TransitLabels', 'NatureLabels'];

const isLabelLayer = (l) =>
  l.type === 'symbol' && (LABEL_PREFIXES.some((p) => l.id.startsWith(p)) || /label|name/i.test(l.id));

/** Cached original values so the street style can be restored exactly. */
let saved = null;

function setIf(map, id, prop, value, kind = 'paint') {
  try {
    if (kind === 'paint') map.setPaintProperty(id, prop, value);
    else map.setLayoutProperty(id, prop, value);
  } catch {
    /* property not applicable to this layer — harmless */
  }
}

/**
 * Switch to the imagery-first look.
 *
 * Called whenever the imagery layer becomes visible. Idempotent.
 */
export function applyImageryFirst(map) {
  if (saved) return;
  const layers = map.getStyle()?.layers || [];
  saved = [];

  for (const l of layers) {
    // Our own layers are prefixed and must never be touched by this transform.
    if (/^(convoy-|nav-|infra-|vantor-|tomtom-traffic|route-)/.test(l.id)) continue;

    const visibility = l.layout?.visibility ?? 'visible';
    const record = { id: l.id, visibility, paint: {} };

    // 1. Keep the base surface so uncovered areas still read as a map.
    if (KEEP_AS_FALLBACK.some((k) => l.id === k || l.id.startsWith(k))) {
      saved.push(record);
      continue;
    }

    // 2. Ground-truth and administrative layers: hide.
    if (HIDE_PREFIXES.some((p) => l.id.startsWith(p))) {
      record.hidden = true;
      saved.push(record);
      setIf(map, l.id, 'visibility', 'none', 'layout');
      continue;
    }

    // 3. Labels: keep, but strengthen the halo so they stay legible on imagery.
    if (isLabelLayer(l)) {
      record.paint['text-halo-color'] = l.paint?.['text-halo-color'];
      record.paint['text-halo-width'] = l.paint?.['text-halo-width'];
      record.paint['text-color'] = l.paint?.['text-color'];
      saved.push(record);
      setIf(map, l.id, 'text-halo-color', 'rgba(8,12,18,0.9)');
      setIf(map, l.id, 'text-halo-width', 1.8);
      setIf(map, l.id, 'text-color', '#f2f6fa');
      continue;
    }

    // 4. Roads: keep a muted skeleton of major classes, drop the rest.
    if (ROAD_PREFIXES.some((p) => l.id.startsWith(p))) {
      if (l.type === 'symbol') {
        // Road shields / arrows / names — keep, they are labels.
        saved.push(record);
        continue;
      }
      const keep = KEEP_ROADS.some((k) => l.id === k);
      if (!keep) {
        record.hidden = true;
        saved.push(record);
        setIf(map, l.id, 'visibility', 'none', 'layout');
      } else {
        // Muted grey at low opacity: orientation without competing with the imagery.
        record.paint['line-opacity'] = l.paint?.['line-opacity'];
        record.paint['line-color'] = l.paint?.['line-color'];
        saved.push(record);
        setIf(map, l.id, 'line-color', '#d8dee6');
        setIf(map, l.id, 'line-opacity', 0.38);
      }
      continue;
    }

    // Water outlines and shadows are casings, not surface — still hidden.
    if (l.id.startsWith('Water')) {
      record.hidden = true;
      saved.push(record);
      setIf(map, l.id, 'visibility', 'none', 'layout');
      continue;
    }

    // 5. Anything else that paints ground area: hide fills, leave the rest alone.
    if (l.type === 'fill' || l.type === 'fill-extrusion') {
      record.hidden = true;
      saved.push(record);
      setIf(map, l.id, 'visibility', 'none', 'layout');
    }
  }
}

/** Restore the full street style. */
export function restoreStreetStyle(map) {
  if (!saved) return;
  for (const r of saved) {
    if (!map.getLayer(r.id)) continue;
    if (r.hidden) setIf(map, r.id, 'visibility', r.visibility, 'layout');
    for (const [prop, value] of Object.entries(r.paint)) {
      // undefined restores the stylesheet's own value.
      setIf(map, r.id, prop, value);
    }
  }
  saved = null;
}

export const isImageryFirstActive = () => saved !== null;
