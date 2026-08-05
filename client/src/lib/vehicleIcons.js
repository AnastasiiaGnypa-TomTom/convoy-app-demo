/**
 * Vehicle pucks — one per fleet profile, rotated to heading.
 *
 * Inline SVG rather than sprite images: the marker is a DOM element, so it rotates
 * with a CSS transform on the marker itself and stays crisp at any zoom or device
 * pixel ratio. No sprite sheet to load, nothing to go blurry.
 *
 * Styling is deliberately tactical rather than consumer-satnav: a directional
 * chevron body with a class-specific silhouette, high-contrast fill and a dark
 * outline so it reads over both satellite imagery and the light street basemap.
 */

/** Colour per class — the same accent used for that class elsewhere in the UI. */
const CLASS_STYLE = {
  'light-vehicle': { fill: '#38bdf8', stroke: '#04222b', scale: 0.9 },
  van: { fill: '#34d399', stroke: '#052e12', scale: 1.0 },
  'heavy-truck': { fill: '#f59e0b', stroke: '#3a2503', scale: 1.12 },
  'oversized-convoy': { fill: '#ef4444', stroke: '#3d0a0a', scale: 1.24 },
  custom: { fill: '#a78bfa', stroke: '#231a44', scale: 1.05 },
};

/**
 * Body shapes, drawn nose-up in a 32×32 box so rotation is about the centre.
 *
 * Each is a directional arrowhead plus a hull whose length grows with the class —
 * a HET reads as visibly longer than a light vehicle at a glance, which is the
 * point for a convoy planner.
 */
const BODY = {
  'light-vehicle': `
    <path d="M16 3 L23 13 L19 13 L19 25 L13 25 L13 13 L9 13 Z"/>`,
  van: `
    <path d="M16 3 L23 12 L20 12 L20 26 L12 26 L12 12 L9 12 Z"/>
    <rect x="12.5" y="15" width="7" height="2.2" rx="0.6" class="puck-band"/>`,
  'heavy-truck': `
    <path d="M16 2 L24 12 L20.5 12 L20.5 28 L11.5 28 L11.5 12 L8 12 Z"/>
    <rect x="12" y="15" width="8" height="2.4" rx="0.6" class="puck-band"/>
    <rect x="12" y="19.5" width="8" height="2.4" rx="0.6" class="puck-band"/>`,
  'oversized-convoy': `
    <path d="M16 1.5 L25 12 L21 12 L21 30 L11 30 L11 12 L7 12 Z"/>
    <rect x="11.6" y="15" width="8.8" height="2.4" rx="0.6" class="puck-band"/>
    <rect x="11.6" y="19.5" width="8.8" height="2.4" rx="0.6" class="puck-band"/>
    <rect x="11.6" y="24" width="8.8" height="2.4" rx="0.6" class="puck-band"/>`,
};
BODY.custom = BODY['heavy-truck'];

const styleFor = (profileId) => CLASS_STYLE[profileId] || CLASS_STYLE['light-vehicle'];
const bodyFor = (profileId) => BODY[profileId] || BODY['light-vehicle'];

/**
 * Vertical re-centring per shape, in viewBox units.
 *
 * The bodies are drawn nose-up but do not fill the 32x32 box symmetrically — a light
 * vehicle spans y 3..25 (centroid 14) while a convoy spans y 1.5..30 (centroid 15.75).
 * Rotation and marker anchoring both act on the box centre (16,16), so an un-centred
 * glyph sits slightly off the line and, worse, sits off by a DIFFERENT amount per
 * profile — so switching vehicle would nudge the puck off the route. Shifting each
 * body onto the box centre makes every icon share one pivot and one anchor.
 */
const CENTER_ADJUST = {
  'light-vehicle': 2,
  van: 1.5,
  'heavy-truck': 1,
  'oversized-convoy': 0.25,
  custom: 1,
};

/**
 * Build the puck element.
 *
 * ── Why the scale is on an inner element ──────────────────────────────────
 * This element is handed to maplibregl.Marker, which positions it by writing
 * `transform: translate(-50%,-50%) translate(Xpx,Ypx) ...`. The CSS `scale` property is
 * NOT part of `transform` — per CSS Transforms 2 the individual properties are applied
 * after it, about transform-origin. So `scale` on this root multiplied MapLibre's
 * positional translate and pushed the puck off the route line by (scale-1) x its
 * distance from the container origin: at scale 1.12 a projected (756,367) rendered at
 * (845,409), which is exactly the ~90px drift that was visible.
 *
 * The scale therefore belongs on an inner wrapper. The marker root now carries no
 * transform of its own, so MapLibre's projection is the only thing positioning it.
 *
 * The accuracy halo sits behind the body and is shown only for real GPS, where position
 * genuinely is uncertain — drawing it for the simulated driver would imply a precision
 * claim that does not exist.
 */
export function createVehiclePuckElement(profileId, { showAccuracy = false } = {}) {
  const st = styleFor(profileId);
  const dy = CENTER_ADJUST[profileId] ?? 0;

  const el = document.createElement('div');
  el.className = 'vehicle-puck-v2';
  el.innerHTML = `
    <span class="puck-inner" style="--puck-scale:${st.scale}">
      ${showAccuracy ? '<span class="puck-accuracy"></span>' : ''}
      <svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">
        <g class="puck-body" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.6"
           stroke-linejoin="round" transform="translate(0 ${dy})">
          ${bodyFor(profileId)}
        </g>
      </svg>
    </span>`;
  return el;
}

/** Route line tint per class — subtle, the icon carries the identification. */
export function routeColourFor(profileId) {
  return styleFor(profileId).fill;
}

export function routeWidthFactorFor(profileId) {
  return styleFor(profileId).scale;
}
