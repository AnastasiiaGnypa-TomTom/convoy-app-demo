import { formatDistance, formatDuration } from '../lib/format.js';

/**
 * The place card — bottom sheet on phones, side panel on desktop (CSS decides).
 *
 * Opens on tapping a POI marker or dropping a pin. Two actions, in the order a
 * navigation app puts them: "Directions" to review the route, "Go" to move
 * immediately. "Go" is what makes POI-to-moving a two-tap flow.
 */
export default function PlaceCard({ place, preview, previewLoading, onDirections, onGo, onClose }) {
  if (!place) return null;

  return (
    <section className="sheet place-card" aria-label="Selected place">
      <div className="sheet-grip" aria-hidden="true" />

      <header className="place-head">
        <div className="place-title">
          <h2>{place.name || 'Dropped pin'}</h2>
          {/* The REAL TomTom category, never a friendly relabel. */}
          {place.tomtomCategory && <span className="place-cat">{place.tomtomCategory}</span>}
          {place.layerLabel && !place.tomtomCategory && (
            <span className="place-cat">{place.layerLabel}</span>
          )}
        </div>
        <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      {place.address && <p className="place-addr">{place.address}</p>}

      <div className="place-stats">
        {previewLoading && <span className="place-stat-dim">Calculating…</span>}
        {!previewLoading && preview && (
          <>
            <span className="place-stat">
              <strong>{formatDuration(preview.travelTimeSeconds)}</strong> drive
            </span>
            <span className="place-stat-dim">{formatDistance(preview.lengthMeters)}</span>
            {preview.straightLineMeters != null && (
              <span className="place-stat-dim">
                {formatDistance(preview.straightLineMeters)} direct
              </span>
            )}
          </>
        )}
        {!previewLoading && !preview && (
          <span className="place-stat-dim">No route for this vehicle profile</span>
        )}
      </div>

      <div className="place-actions">
        <button type="button" className="btn-primary" onClick={onDirections}>
          Directions
        </button>
        <button type="button" className="btn-secondary" onClick={onGo} disabled={!preview}>
          Go
        </button>
      </div>
    </section>
  );
}
