/** Display helpers for route summaries. */

export function formatDistance(meters) {
  if (meters == null) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
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
