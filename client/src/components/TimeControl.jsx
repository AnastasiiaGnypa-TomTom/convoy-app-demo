/**
 * Temporal capture control — one time axis for imagery and elevation.
 *
 * Captures come from the vendors' own metadata (Vantor WFS `acquisitionDate` for
 * imagery, STAC `datetime` for the p3d elevation coverages). Selecting one re-renders
 * the imagery via a CQL date filter, so this genuinely changes the pixels.
 *
 * Unavailable captures are shown, not hidden. Vantor's elevation coverages are real
 * and dated but not streamable on this key — "there is a DSM here from 2026-07-31
 * that we cannot fetch" is exactly what a change-detection workflow needs to know,
 * and omitting it would make the axis lie.
 *
 * "Compare over time" is wired to the real /api/temporal/change endpoint, which
 * currently answers 501 from a stubbed detectChange(). The control is deliberately
 * present and honest about that rather than hidden.
 */
const day = (iso) => String(iso).slice(0, 10);
const pretty = (iso) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export default function TimeControl({
  captures,
  timeRange,
  selected,
  latest,
  compareFrom,
  loading,
  changeResult,
  changeBusy,
  captureEmpty,
  onSelect,
  onSetCompareFrom,
  onCompare,
}) {
  if (loading) {
    return (
      <div className="panel-section">
        <h2>Capture date</h2>
        <p className="panel-note panel-note-dim">Loading captures…</p>
      </div>
    );
  }
  if (!captures?.length) return null;

  const renderable = captures.filter((c) => c.available);
  const unavailable = captures.filter((c) => !c.available);
  const index = Math.max(0, renderable.findIndex((c) => c.datetime === selected));

  return (
    <div className="panel-section">
      <div className="section-head">
        <h2>Capture date</h2>
        {timeRange && (
          <span className="time-range">
            {day(timeRange.earliest)} → {day(timeRange.latest)}
          </span>
        )}
      </div>

      {/* Newest is at the right, which is how people read a timeline. */}
      <input
        className="time-slider"
        type="range"
        min={0}
        max={Math.max(0, renderable.length - 1)}
        value={index}
        onChange={(e) => onSelect(renderable[Number(e.target.value)]?.datetime || null)}
        aria-label="Imagery capture date"
      />

      <div className="time-selected">
        {selected ? (
          <>
            <strong>{pretty(selected)}</strong>
            <span className="time-meta">
              {renderable[index]?.productName?.replace(/_/g, ' ')}
              {renderable[index]?.cloudCoverPercent != null &&
                ` · ${Math.round(renderable[index].cloudCoverPercent)}% cloud`}
              {renderable[index]?.resolutionMeters != null &&
                ` · ${Math.round(renderable[index].resolutionMeters * 100)} cm`}
            </span>
          </>
        ) : (
          <span className="time-meta">Latest available</span>
        )}
        <button type="button" className="link-btn" onClick={() => onSelect(null)}>
          Reset to latest
        </button>
      </div>

      {captureEmpty && (
        <p className="panel-note panel-note-dim">
          This capture does not cover the current view. The imagery is intentionally left
          blank rather than substituting another date.
        </p>
      )}

      <p className="time-counts">
        {renderable.length} renderable · {unavailable.length} coverage-only
        {unavailable.length > 0 && (
          <span className="time-unavail">
            {' '}
            (Vantor elevation exists here but is not streamable on this key)
          </span>
        )}
      </p>

      {/* ------------------------------------------------ change detection seam */}
      <div className="compare-block">
        <label className="compare-row">
          <span>Compare from</span>
          <select
            value={compareFrom || ''}
            onChange={(e) => onSetCompareFrom(e.target.value || null)}
          >
            <option value="">Choose an earlier capture…</option>
            {renderable
              .filter((c) => {
                const to = selected || latest;
                return !to || new Date(c.datetime) < new Date(to);
              })
              .map((c) => (
                <option key={c.id} value={c.datetime}>
                  {pretty(c.datetime)} — {c.productName?.replace(/_/g, ' ')}
                </option>
              ))}
          </select>
        </label>

        <button
          type="button"
          className="btn-secondary compare-btn"
          onClick={onCompare}
          disabled={!compareFrom || !(selected || latest) || changeBusy}
          title="Change detection is not implemented yet"
        >
          {changeBusy ? 'Checking…' : 'Compare over time'}
          <span className="compare-soon">coming soon</span>
        </button>

        {changeResult && (
          <p className="compare-result">
            {changeResult.implemented ? changeResult.summary : <em>{changeResult.summary}</em>}
          </p>
        )}
      </div>
    </div>
  );
}
