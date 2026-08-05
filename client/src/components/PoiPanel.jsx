/**
 * POI layer selector.
 *
 * Only layers that can actually populate are listed — the server filters out any
 * whose categories failed build-time verification, so there are no permanently empty
 * rows. Those layers still exist in server/lib/poiAllowlist.js with the reason they
 * cannot be sourced, which is what stops one being re-added later by borrowing a
 * loosely-related category (the jewellery-studio-as-defence-industry mistake).
 */
export default function PoiPanel({
  layers,
  selected,
  counts,
  capped,
  enabled,
  loading,
  mode,
  corridorKm,
  total,
  droppedOutOfCategory,
  onToggleEnabled,
  onToggleLayer,
  onSelectPreset,
}) {
  if (!layers?.length) return null;

  // The server only sends layers that can actually populate.
  const sourced = layers;

  const row = (l) => {
    const on = selected.includes(l.id);
    const n = counts?.[l.id];
    return (
      <li key={l.id}>
        <label className={`poi-row ${on ? 'poi-row-on' : ''}`}>
          <input type="checkbox" checked={on} onChange={() => onToggleLayer(l.id)} />
          <span className="poi-swatch" style={{ background: l.color }} aria-hidden="true">
            {l.glyph}
          </span>
          <span className="poi-name">{l.label}</span>
          {on && n != null && (
            <span className="poi-count">
              {n}
              {capped?.includes(l.id) ? '+' : ''}
            </span>
          )}
        </label>

        {on && l.caveat && (
          <p className="poi-caveat">
            <strong>{l.lowerConfidence ? 'Lower confidence:' : 'Note:'}</strong> {l.caveat}
          </p>
        )}
        {on && l.allowedCodes?.length > 0 && (
          <p className="poi-codes">{[...new Set(l.allowedCodes)].join(' · ')}</p>
        )}
      </li>
    );
  };

  return (
    <div className="panel-section">
      <div className="section-head">
        <h2>POI layers</h2>
        <button
          type="button"
          className={`toggle-pill ${enabled ? 'toggle-pill-on' : ''}`}
          onClick={onToggleEnabled}
          aria-pressed={enabled}
        >
          {enabled ? 'On' : 'Show'}
        </button>
      </div>

      {enabled && (
        <>
          <div className="poi-presets">
            <button type="button" className="link-btn" onClick={() => onSelectPreset('convoy')}>
              Convoy essentials
            </button>
            <button type="button" className="link-btn" onClick={() => onSelectPreset('all')}>
              All available
            </button>
            <button type="button" className="link-btn" onClick={() => onSelectPreset('none')}>
              None
            </button>
          </div>

          <ul className="poi-list">{sourced.map(row)}</ul>


          <p className="poi-footer">
            {loading
              ? 'Loading…'
              : selected.length === 0
                ? 'Select one or more layers.'
                : `${total} POI${total === 1 ? '' : 's'} ${
                    mode === 'along-route' ? `within ${corridorKm} km of the route` : 'in view'
                  }`}
            {!loading && capped?.length > 0 && (
              <span className="poi-trunc"> · capped at 50 per layer</span>
            )}
          </p>

          {/* Proof the runtime assertion is doing work, not decoration. */}
          {!loading && droppedOutOfCategory > 0 && (
            <p className="poi-assert">
              {droppedOutOfCategory} result{droppedOutOfCategory === 1 ? '' : 's'} dropped for
              falling outside the layer allowlist
            </p>
          )}
          <p className="poi-source">POI data © TomTom · categories verified at build time</p>
        </>
      )}
    </div>
  );
}
