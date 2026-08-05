/**
 * Basemap and View — two independent segmented toggles.
 *
 * These replaced a single button that cycled 2D → 3D-buildings → 3D-terrain. That
 * cycle forced the user to understand a rendering trade-off (extrusions vs draped
 * imagery) that the app can decide for itself, and it needed a third "imagery
 * paused" state to explain itself.
 *
 * Now the user picks two orthogonal things and the render is DERIVED:
 *
 *   Map       + 2D  → flat street map
 *   Map       + 3D  → tilted, buildings extruded, terrain underneath
 *   Satellite + 2D  → flat Vantor imagery, imagery-first declutter
 *   Satellite + 3D  → imagery draped over terrain, no extrusions
 *
 * Because Satellite and Map are one choice, satellite-plus-buildings is
 * unreachable — the doubled-building artifact is prevented structurally rather
 * than by a rule the user has to know about.
 */
export default function ViewToggles({
  basemap,
  view,
  exaggeration,
  satelliteAvailable,
  buildingsAvailable,
  terrainAvailable,
  onBasemapChange,
  onViewChange,
  onExaggerationChange,
  compact = false,
}) {
  const segment = (label, options, value, onChange) => (
    <div className="toggle-group">
      {!compact && <span className="toggle-label">{label}</span>}
      <div className="segmented" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`segment ${value === o.value ? 'segment-on' : ''}`}
            onClick={() => onChange(o.value)}
            disabled={o.disabled}
            aria-pressed={value === o.value}
            title={o.title}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className={`view-toggles ${compact ? 'view-toggles-compact' : ''}`}>
      {segment(
        'Basemap',
        [
          { value: 'map', label: 'Map', title: 'TomTom street map' },
          {
            value: 'satellite',
            label: 'Satellite',
            title: satelliteAvailable
              ? 'Vantor satellite mosaic'
              : 'Vantor imagery unavailable',
            disabled: !satelliteAvailable,
          },
        ],
        basemap,
        onBasemapChange,
      )}

      {segment(
        'View',
        [
          { value: '2d', label: '2D', title: 'Top-down' },
          {
            value: '3d',
            label: '3D',
            title:
              basemap === 'satellite'
                ? 'Imagery draped over terrain'
                : 'Tilted with 3D buildings',
          },
        ],
        view,
        onViewChange,
      )}

      {/* Exaggeration is only meaningful when tilted, so it only exists then. */}
      {view === '3d' && terrainAvailable && !compact && (
        <label className="exag-row">
          <span>
            Terrain exaggeration <em>{exaggeration.toFixed(1)}×</em>
          </span>
          <input
            type="range"
            min="1"
            max="3"
            step="0.1"
            value={exaggeration}
            onChange={(e) => onExaggerationChange(Number(e.target.value))}
          />
        </label>
      )}

      {!compact && (
        <p className="view-hint">
          {basemap === 'map' && view === '3d' && buildingsAvailable && 'Buildings extruded from TomTom heights.'}
          {basemap === 'map' && view === '3d' && !buildingsAvailable && 'Tilted view — no building heights in this area.'}
          {basemap === 'satellite' && view === '3d' && 'Vantor imagery draped over elevation.'}
          {basemap === 'satellite' && view === '2d' && 'Vantor mosaic with TomTom roads and labels.'}
          {basemap === 'map' && view === '2d' && 'TomTom street map.'}
        </p>
      )}
    </div>
  );
}
