/**
 * POI marker icons.
 *
 * Generated at runtime onto a canvas and registered with map.addImage(), rather
 * than shipped as sprite files. Two reasons: the icon colour has to match the
 * category colour the server sends (so the legend, the checkbox swatch and the map
 * can never drift apart), and generating them avoids another asset request on a
 * connection we do not control during a live demo.
 *
 * Glyphs are deliberately plain geometric characters, not emoji: emoji render
 * inconsistently across platforms and would look different on a customer's machine.
 */


export const iconIdFor = (layerId) => `poi-icon-${layerId}`;

/**
 * Glyphs come from the server's layer definitions, so the map marker, the legend
 * swatch and the allowlist can never disagree about what a layer is.
 */
export const glyphFor = (layer) => (typeof layer === 'string' ? '•' : layer?.glyph || '•');

/**
 * Draw a filled pin-style badge with a glyph.
 *
 * Rendered at 2× and declared with pixelRatio 2 so it stays crisp on retina and
 * when MapLibre scales it up at high zoom.
 */
/*
 * Rendered at 96px and registered at pixelRatio 2, so the LOGICAL size is 48 CSS px.
 *
 * It was 48px at pixelRatio 2, i.e. a 24 px logical badge — so even icon-size 1.5 only
 * produced a 31 px marker, which is why they still read as small dots when zoomed in.
 * Doubling the bitmap raises the base and keeps it crisp on retina; the zoom ramp in
 * poiLayers.js is expressed against this 48 px base.
 */
function renderIcon({ color, glyph, size = 96 }) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  const r = size * 0.36;

  // Dark outer ring so the marker reads over both the light basemap and satellite.
  ctx.beginPath();
  ctx.arc(c, c, r + size * 0.07, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(11,16,22,0.85)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = size * 0.045;
  ctx.stroke();

  // Glyph in near-black for contrast against the saturated category colours.
  ctx.fillStyle = '#0b1016';
  ctx.font = `700 ${Math.round(size * 0.5)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, c, c + size * 0.02);

  return ctx.getImageData(0, 0, size, size);
}

/**
 * Register one icon per category. Safe to call repeatedly — existing images are
 * skipped, so a re-render or a style reload does not throw.
 */
export function registerPoiIcons(map, layers) {
  for (const cat of layers) {
    const id = iconIdFor(cat.id);
    if (map.hasImage(id)) continue;
    try {
      const data = renderIcon({ color: cat.color, glyph: cat.glyph || '•' });
      map.addImage(id, data, { pixelRatio: 2 });
    } catch (err) {
      console.warn(`[poiIcons] ${cat.id}:`, err.message);
    }
  }
}
