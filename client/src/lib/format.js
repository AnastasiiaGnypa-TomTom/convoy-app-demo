/** Display helpers for route summaries. */

/* ─────────────────────────── ux-units: miles or km ─────────────────────────
 * The unit follows the ROUTE's country, not the browser's locale: someone in
 * Amsterdam planning a Baltimore convoy wants miles, because that is what the road
 * signs and the driver will use.
 *
 * Held as module state with a setter rather than threaded as a prop through the seven
 * components that format distances. It is safe here because the unit only ever changes
 * when a new route arrives, and App sets it during render — before any child reads it —
 * so there is no frame where a distance is drawn in the wrong unit. A React context
 * would be more orthodox; this is one call site instead of fourteen, and reverting it is
 * deleting one function.
 *
 * Imperial by country, not by continent: the US, the UK, Liberia and Myanmar sign roads
 * in miles. Canada and Mexico are metric, so "North America" would be wrong.
 */
const IMPERIAL_COUNTRIES = new Set(['USA', 'US', 'GBR', 'GB', 'LBR', 'LR', 'MMR', 'MM']);

let units = 'metric';

/** 'imperial' | 'metric'. Anything else is ignored, so a bad value cannot break output. */
export function setDistanceUnits(next) {
  if (next === 'imperial' || next === 'metric') units = next;
}

export function getDistanceUnits() {
  return units;
}

/** Which unit system a country code implies. Accepts alpha-2 or alpha-3. */
export function unitsForCountry(code) {
  return code && IMPERIAL_COUNTRIES.has(String(code).toUpperCase()) ? 'imperial' : 'metric';
}

const M_PER_MILE = 1609.344;
const M_PER_FOOT = 0.3048;

export function formatDistance(meters) {
  if (meters == null) return '—';
  if (units === 'imperial') {
    // Feet below about a tenth of a mile, where "0.05 mi" tells you nothing useful.
    if (meters < 160) return `${Math.round(meters / M_PER_FOOT)} ft`;
    const mi = meters / M_PER_MILE;
    return `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

/** Short form for tight spots: always the large unit, one decimal. */
export function formatDistanceShort(meters) {
  if (meters == null) return '—';
  return units === 'imperial'
    ? `${(meters / M_PER_MILE).toFixed(1)} mi`
    : `${(meters / 1000).toFixed(1)} km`;
}

/** Elevation and climb figures follow the same system: feet in imperial countries. */
export function formatElevation(meters) {
  if (meters == null) return '—';
  return units === 'imperial'
    ? `${Math.round(meters / M_PER_FOOT)} ft`
    : `${Math.round(meters)} m`;
}

export function formatDuration(seconds) {
  if (seconds == null) return '—';
  const total = Math.round(seconds / 60);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Traffic delay, only worth showing once it is material. */
export function formatDelay(seconds) {
  if (!seconds || seconds < 60) return null;
  return `+${Math.round(seconds / 60)} min traffic`;
}

/* ------------------------------------------------- imagery provenance ---- */

/** VIVID_STANDARD_30 → Vivid Standard 30 */
export function formatProductName(name) {
  if (!name) return null;
  return name
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** 0.3 Meter → 30 cm; 1.5 Meter → 1.5 m */
export function formatResolution(value, unit) {
  if (value == null) return null;
  const isMetres = !unit || /met/i.test(unit);
  if (!isMetres) return `${value} ${unit}`;
  return value < 1 ? `${Math.round(value * 100)} cm` : `${value} m`;
}

/** 2026-05-05T11:08:56Z → 5 May 2026 */
export function formatCaptureDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * 2026-05-05T11:08:56Z → Q2 2026
 *
 * Used for the seamless mosaic, which is a periodically rebuilt product rather
 * than a single moment — a specific day would imply more precision than the
 * mosaic actually has. Its own identifiers use the same convention (…_26Q2).
 */
export function formatCaptureQuarter(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

/** Cloud cover is a percentage; round so 0.0009 does not read as "0.0009%". */
export function formatCloudCover(percent) {
  if (percent == null) return null;
  if (percent < 1) return percent === 0 ? '0% cloud' : '<1% cloud';
  return `${Math.round(percent)}% cloud`;
}

export function formatVehicleSpec(spec) {
  if (!spec) return '';
  const t = spec.weightKg >= 1000 ? `${(spec.weightKg / 1000).toFixed(spec.weightKg % 1000 ? 1 : 0)} t` : `${spec.weightKg} kg`;
  return `${t} · ${spec.lengthM} m long · ${spec.heightM} m high`;
}
