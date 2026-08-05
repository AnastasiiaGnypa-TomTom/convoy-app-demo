import {
  formatCaptureDate,
  formatCaptureQuarter,
  formatCloudCover,
  formatProductName,
  formatResolution,
} from '../lib/format.js';

/**
 * On-map layer controls: imagery, traffic, and the 2D/3D switch.
 *
 * Sits on the map rather than in the panel so it stays reachable on a phone with
 * the panel collapsed — these are the toggles a presenter reaches for mid-sentence.
 */
export default function MapControls({
  imageryOn,
  trafficOn,
  is3D,
  imageryAvailable,
  trafficAvailable,
  terrainVendor,
  incidentCount,
  congestionCount,
  provenance,
  imageryMaxZoom,
  zoom,
  imageryModes,
  imageryMode,
  effectiveImageryMode,
  fellBack,
  onToggleImagery,
  onToggleTraffic,
  onToggle3D,
  onImageryModeChange,
}) {
  /*
   * Provenance describes the streaming layer's own capture over the current view
   * (Vantor WFS FinishedFeature), so it is an honest answer to "how current is
   * this imagery?" — unlike a catalog date, which describes orderable archive.
   *
   * The two modes are described differently on purpose:
   *  - seamless: quarter, not a day, because the mosaic is a periodically rebuilt
   *    product; and the words "seamless mosaic" set the expectation of no seams.
   *  - latest: exact date plus cloud and resolution, ending "single capture" — so
   *    visible strip edges read as recent single-pass imagery rather than as a
   *    rendering fault.
   */
  const isSeamless = effectiveImageryMode === 'seamless';
  const provenanceParts = provenance
    ? (isSeamless
        ? [
            formatProductName(provenance.productName),
            formatCaptureQuarter(provenance.acquisitionDate),
            'seamless mosaic',
          ]
        : [
            formatProductName(provenance.productName),
            formatCaptureDate(provenance.acquisitionDate),
            formatCloudCover(provenance.cloudCoverPercent),
            formatResolution(provenance.resolution, provenance.resolutionUnit),
            'single capture',
          ]
      ).filter(Boolean)
    : [];

  // Past the cost cap MapLibre upsamples the last real tile, so say so rather than
  // letting the imagery just look soft for no visible reason.
  const beyondCap = imageryOn && imageryMaxZoom != null && zoom != null && zoom > imageryMaxZoom + 0.5;
  return (
    <div className="map-controls" role="group" aria-label="Map layers">
      <button
        type="button"
        className={`layer-btn ${imageryOn ? 'layer-btn-on' : ''}`}
        onClick={onToggleImagery}
        aria-pressed={imageryOn}
        title="Vantor satellite imagery beneath TomTom roads and labels"
      >
        <span className="layer-dot layer-dot-imagery" aria-hidden="true" />
        Imagery
      </button>

      <button
        type="button"
        className={`layer-btn ${trafficOn ? 'layer-btn-on' : ''}`}
        onClick={onToggleTraffic}
        disabled={!trafficAvailable}
        aria-pressed={trafficOn}
        title="TomTom live traffic flow and incidents"
      >
        <span className="layer-dot layer-dot-traffic" aria-hidden="true" />
        Traffic
        {trafficOn && incidentCount > 0 && <span className="layer-count">{incidentCount}</span>}
      </button>

      <button
        type="button"
        className={`layer-btn ${is3D ? 'layer-btn-on' : ''}`}
        onClick={onToggle3D}
        aria-pressed={is3D}
        title={`3D terrain — elevation from ${terrainVendor || 'DEM source'}`}
      >
        <span className="layer-dot layer-dot-3d" aria-hidden="true" />
        {is3D ? '3D' : '2D'}
      </button>

      {/* Mode switch — only meaningful while imagery is on. */}
      {imageryOn && imageryModes?.length > 1 && (
        <div className="mode-switch" role="group" aria-label="Imagery mode">
          {imageryModes.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mode-btn ${imageryMode === m.id ? 'mode-btn-on' : ''}`}
              onClick={() => onImageryModeChange(m.id)}
              aria-pressed={imageryMode === m.id}
              title={m.detail}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      {imageryOn && provenanceParts.length > 0 && (
        <div className="imagery-provenance">
          <span className="prov-label">Imagery on screen</span>
          <span className="prov-value">{provenanceParts.join(' · ')}</span>
          {fellBack && (
            <span className="prov-note">
              No seamless mosaic covers this area — showing latest capture instead
            </span>
          )}
          {beyondCap && (
            <span className="prov-note">Upsampled beyond zoom {imageryMaxZoom}</span>
          )}
        </div>
      )}

      {trafficOn && congestionCount > 0 && (
        <p className="layer-hint">
          {congestionCount} congested stretch{congestionCount === 1 ? '' : 'es'} on this route
        </p>
      )}
    </div>
  );
}
