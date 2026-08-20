import { useEffect, useRef, useState } from 'react';

/*
 * ux-camera: tilt slider + draggable compass.
 *
 * Both drive the map directly rather than going through React state, because a drag
 * produces a value every pointer event and routing that through a re-render makes the
 * rotation feel heavy. The displayed numbers come from the map's own `rotate`/`pitch`
 * events, so the widget shows what the camera IS rather than what it was told — they
 * differ while an easeTo is still running.
 *
 * MapLibre already ships a NavigationControl with a compass; this is here because that
 * one only offers click-to-step and no tilt, and the ask was a compass you can drag and
 * a tilt you can sweep.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export default function CameraControls({ map, maxPitch = 70, hidden }) {
  const [bearing, setBearing] = useState(0);
  const [pitch, setPitch] = useState(0);
  const dialRef = useRef(null);
  const draggingRef = useRef(false);

  // Follow the camera, so the readout is never a stale echo of our own input.
  useEffect(() => {
    if (!map) return;
    const sync = () => {
      setBearing(map.getBearing());
      setPitch(map.getPitch());
    };
    sync();
    map.on('rotate', sync);
    map.on('pitch', sync);
    map.on('moveend', sync);
    return () => {
      map.off('rotate', sync);
      map.off('pitch', sync);
      map.off('moveend', sync);
    };
  }, [map]);

  /*
   * Drag anywhere on the dial: the bearing is the angle from the dial's centre to the
   * pointer, so the compass follows the finger exactly instead of applying a delta.
   * Pointer capture keeps the drag alive when the pointer leaves the small circle.
   */
  const angleFromEvent = (e) => {
    const el = dialRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    // atan2 measured from north, clockwise, matching MapLibre's bearing convention.
    return (Math.atan2(dx, -dy) * 180) / Math.PI;
  };

  const onPointerDown = (e) => {
    if (!map) return;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // jumpTo, not easeTo: an animation per pointer event fights the next one.
    map.jumpTo({ bearing: angleFromEvent(e) });
  };
  const onPointerMove = (e) => {
    if (!draggingRef.current || !map) return;
    map.jumpTo({ bearing: angleFromEvent(e) });
  };
  const onPointerUp = (e) => {
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const resetNorth = () => map?.easeTo({ bearing: 0, duration: 400, essential: true });

  const applyPitch = (next) => {
    if (!map) return;
    const p = clamp(Number(next), 0, maxPitch);
    // Live during a drag, so jumpTo; the slider itself is the smoothing.
    map.jumpTo({ pitch: p });
  };

  if (hidden) return null;

  return (
    <div className="cam-controls">
      {/* ── compass ─────────────────────────────────────────────── */}
      <div
        ref={dialRef}
        className="cam-dial"
        role="slider"
        aria-label="Map rotation"
        aria-valuenow={Math.round(((bearing % 360) + 360) % 360)}
        aria-valuemin={0}
        aria-valuemax={359}
        tabIndex={0}
        title="Drag to rotate · double-click for north"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={resetNorth}
        onKeyDown={(e) => {
          if (!map) return;
          if (e.key === 'ArrowLeft') map.easeTo({ bearing: map.getBearing() - 15, duration: 200 });
          if (e.key === 'ArrowRight') map.easeTo({ bearing: map.getBearing() + 15, duration: 200 });
          if (e.key === 'Home') resetNorth();
        }}
      >
        {/* The needle counter-rotates, so N always points at true north. */}
        <div className="cam-needle" style={{ transform: `rotate(${-bearing}deg)` }}>
          <span className="cam-n">N</span>
          <span className="cam-arrow" aria-hidden="true" />
        </div>
      </div>

      {/* ── tilt ────────────────────────────────────────────────── */}
      <div className="cam-tilt">
        <span className="cam-tilt-label" aria-hidden="true">
          ⌄
        </span>
        <input
          type="range"
          min="0"
          max={maxPitch}
          step="1"
          value={Math.round(pitch)}
          onChange={(e) => applyPitch(e.target.value)}
          aria-label="Map tilt"
          title={`Tilt ${Math.round(pitch)}° — top-down at 0, toward the horizon at ${maxPitch}`}
        />
        <span className="cam-tilt-val">{Math.round(pitch)}°</span>
      </div>
    </div>
  );
}
