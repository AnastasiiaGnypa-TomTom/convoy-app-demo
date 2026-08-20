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
  /*
   * Double-tap detection, done here rather than with onDoubleClick.
   *
   * Taking pointer capture on pointerdown — needed so a drag survives leaving the small
   * circle — swallows the click/dblclick sequence, so React's onDoubleClick never fired
   * and the reset silently did nothing. Timing two pointerdowns is independent of that
   * and works for touch as well as mouse.
   */
  const lastTapRef = useRef(0);

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
  /*
   * Angle from the dial centre to the pointer, or null in a small dead zone.
   *
   * The dead zone is not cosmetic. At the exact centre dx and dy are both 0 and
   * `Math.atan2(0, -0)` is PI, so a click in the middle snapped the map to 180 degrees —
   * which is what broke double-click-for-north: the second click's pointerdown set 180
   * before the reset could run. Near the centre there is no meaningful direction anyway,
   * so a click there is a click, not a rotation.
   */
  const resetNorth = () => map?.easeTo({ bearing: 0, duration: 400, essential: true });

  const DEAD_ZONE = 0.3; // fraction of the radius
  const angleFromEvent = (e) => {
    const el = dialRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < (r.width / 2) * DEAD_ZONE) return null;
    // atan2 measured from north, clockwise, matching MapLibre's bearing convention.
    return (Math.atan2(dx, -dy) * 180) / Math.PI;
  };

  const onPointerDown = (e) => {
    if (!map) return;

    const now = Date.now();
    const isDoubleTap = now - lastTapRef.current < 350;
    lastTapRef.current = now;
    if (isDoubleTap) {
      draggingRef.current = false;
      resetNorth();
      return;
    }

    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const a = angleFromEvent(e);
    // jumpTo, not easeTo: an animation per pointer event fights the next one.
    if (a !== null) map.jumpTo({ bearing: a });
  };
  const onPointerMove = (e) => {
    if (!draggingRef.current || !map) return;
    const a = angleFromEvent(e);
    if (a !== null) map.jumpTo({ bearing: a });
  };
  const onPointerUp = (e) => {
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

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
