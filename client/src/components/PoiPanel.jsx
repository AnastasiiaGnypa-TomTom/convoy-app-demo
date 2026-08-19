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
  onLocateLayer,
  highlighted,
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
  onCorridorChange,
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
            <button
              type="button"
              className={`poi-count poi-count-btn ${highlighted === l.id ? 'poi-count-active' : ''}`}
              onClick={(e) => {
                // Inside a <label>, so stop the click toggling the checkbox.
                e.preventDefault();
                e.stopPropagation();
                onLocateLayer?.(l.id);
              }}
              disabled={!n}
              title={
                n
                  ? `Show these ${n} on the map`
                  : 'Nothing in view'
              }
            >
              {n}
              {capped?.includes(l.id) ? '+' : ''}
            </button>
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
                    mode === 'along-route'
                      ? `within ${Number(corridorKm).toFixed(1)} km (${(Number(corridorKm) / 1.609).toFixed(0)} mi) of the route`
                      : 'in view'
                  }`}
            {!loading && capped?.length > 0 && (
              <span className="poi-trunc"> · capped at 50 per layer</span>
            )}

          {/*
            * Corridor width, shown only with a route active — it has no meaning for a
            * viewport browse. Primary unit is km to match the rest of the app and the
            * scale bar; miles are shown too because the convoy default is stated in
            * miles. Untouched, it stays at the 5-mile default.
            */}
          {mode === 'along-route' && onCorridorChange && (
            <div className="corridor-control">
              <label className="corridor-head" htmlFor="corridor-range">
                <span>Buffer each side of the route</span>
                <span className="corridor-value">
                  {Number(corridorKm).toFixed(1)} km · {(Number(corridorKm) / 1.609).toFixed(1)} mi
                </span>
              </label>
              <input
                id="corridor-range"
                type="range"
                min="1.61"
                max="24.15"
                step="0.805"
                value={corridorKm}
                onChange={(e) => onCorridorChange(Number(e.target.value))}
              />
              <div className="corridor-scale" aria-hidden="true">
                <span>1 mi</span>
                <span>5 mi</span>
                <span>15 mi</span>
              </div>
              <p className="corridor-note">A wider buffer finds more POIs and takes longer to load.</p>
            </div>
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
