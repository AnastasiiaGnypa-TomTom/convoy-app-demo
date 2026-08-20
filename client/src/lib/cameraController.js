/**
 * The single owner of the map camera.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 * Starting navigation used to zoom out, snap back and oscillate, because three
 * independent effects all moved the camera at once:
 *
 *   1. the route effect called fitBounds whenever route geometry changed — and
 *      pressing "Go" sets the destination, which produces new geometry;
 *   2. the 3D effect called fitBounds again, because entering navigation flipped
 *      `is3D` on and that effect re-framed the whole route at the new pitch;
 *   3. the follow effect called easeTo on EVERY position update — the simulated
 *      driver runs on requestAnimationFrame, so roughly sixty 250 ms animations
 *      were started per second, each fighting the last and each re-asserting zoom,
 *      pitch and padding.
 *
 * Every camera move now goes through here, so there is one authority and one
 * animation at a time. Nothing else in the app may call fitBounds/flyTo/easeTo
 * while navigating.
 */

/** Fixed navigation zoom. Never derived from route bounds — that was the bug. */
export const NAV_ZOOM = 16.5;
/** Overhead ("north-up") shows more of the road ahead, so it sits further out. */
export const OVERHEAD_ZOOM = 15.2;

/**
 * Camera modes offered during guidance.
 *
 *   follow   — 3D chase cam: bearing-up, tilted, puck low in frame.
 *   overhead — north-up, top-down, wider. The calm "map" view.
 */
export const CAMERA_MODES = { FOLLOW: 'follow', OVERHEAD: 'overhead' };
export const NAV_PITCH = 60;
/** Slightly flatter on a phone, where 60° at street level shows almost nothing. */
export const NAV_PITCH_NARROW = 50;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Puck sits low so the road ahead fills the view. */
/*
 * ux-center: no padding, so the vehicle sits in the CENTRE of the map.
 *
 * This used to push the camera centre 40% of the height downward, the usual satnav
 * placement that trades a centred vehicle for more visible road ahead. For a briefing
 * fly-through the vehicle being dead centre is what is wanted, so the offset is gone.
 *
 * The trade-off is real and worth knowing: at 60° pitch a centred vehicle shows roughly
 * half as much road ahead. Restore the old feel by putting `bottom` back to h * 0.4.
 */
function navPadding() {
  return { top: 0, bottom: 0, left: 0, right: 0 };
}

const narrow = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches;

/**
 * Shortest-arc bearing interpolation.
 *
 * Raw heading is noisy — a GPS fix jitters by several degrees when stationary, and
 * the simulated driver's bearing steps at each polyline vertex. Feeding that
 * straight to the camera makes the world twitch, so it is eased toward the target
 * and wrapped correctly across 0/360.
 */
export function smoothBearing(previous, target, factor = 0.18) {
  if (previous == null || Number.isNaN(previous)) return target;
  let delta = ((target - previous + 540) % 360) - 180;
  // Below a couple of degrees this is jitter, not turning.
  if (Math.abs(delta) < 1.5) return previous;
  return (previous + delta * factor + 360) % 360;
}

/**
 * Create a camera controller bound to one map instance.
 *
 * `mode` is explicit so a stray call cannot re-frame the route mid-drive: while in
 * 'navigate', fitRoute() is a no-op rather than a fight.
 */
const TRACE = typeof window !== 'undefined' && window.localStorage?.getItem('cameraTrace') === '1';
const trace = (...a) => { if (TRACE) console.log('[camera]', ...a); };

export function createCameraController(map) {
  let mode = 'browse';
  // Timestamp until which our own animation is expected to still be running.
  let busyUntil = 0;
  /*
   * While the entry animation is in flight, follow() must stay out of the way.
   *
   * follow() uses jumpTo for high-frequency sources, and jumpTo CANCELS any running
   * animation. The simulated driver ticks about 16 ms after "Go", so the first
   * follow call was killing the 900 ms entry easeTo before it had moved — the camera
   * stayed flat and city-wide, looking as though the nav camera had never applied.
   */
  let enteringUntil = 0;
  let lastBearing = null;

  const reduced = () => prefersReducedMotion();

  return {
    get mode() {
      return mode;
    },

    /** Frame the whole route. Only legal outside navigation. */
    fitRoute(bounds, { pitch = 0, bearing = 0, duration = 700 } = {}) {
      if (mode === 'navigate') return; // never re-fit while driving
      if (!bounds || bounds.isEmpty?.()) return;
      const pad = narrow()
        ? { top: 50, bottom: 50, left: 30, right: 30 }
        : { top: 70, bottom: 70, left: 70, right: 70 };
      map.fitBounds(bounds, {
        padding: pad,
        pitch,
        bearing,
        maxZoom: 15,
        duration: reduced() ? 0 : duration,
      });
      busyUntil = Date.now() + (reduced() ? 0 : duration);
    },

    /**
     * ENTER navigation: exactly one animation.
     *
     * easeTo, not flyTo — flyTo deliberately arcs out and back in, which is the
     * "zoom far out then snap" the user reported.
     */
    enterNavigation({ coord, bearing = 0, cameraMode = CAMERA_MODES.FOLLOW }) {
      trace('enterNavigation', { mode });
      mode = 'navigate';
      const overhead = cameraMode === CAMERA_MODES.OVERHEAD;
      lastBearing = overhead ? 0 : bearing;
      const pitch = overhead ? 0 : narrow() ? NAV_PITCH_NARROW : NAV_PITCH;
      const target = {
        center: coord,
        zoom: overhead ? OVERHEAD_ZOOM : NAV_ZOOM,
        pitch,
        bearing: overhead ? 0 : bearing,
        padding: navPadding(),
        essential: true,
      };
      if (reduced()) {
        map.jumpTo(target);
        busyUntil = 0;
        enteringUntil = 0;
        return;
      }
      map.easeTo({ ...target, duration: 900 });
      busyUntil = Date.now() + 900;
      enteringUntil = busyUntil;
    },

    /**
     * FOLLOW during navigation: centre and bearing only.
     *
     * Zoom, pitch and padding are deliberately NOT passed — re-asserting them on
     * every tick is what made the camera stutter. They were set once on entry and
     * are only touched again by recenter().
     *
     * High-frequency sources (the simulated driver, ~60 Hz) use jumpTo: the
     * positions are already interpolated, so an animation adds nothing but
     * contention. Low-frequency sources (GPS, ~1 Hz) get a short easeTo to bridge
     * the gap between fixes, guarded so ticks cannot stack.
     */
    /**
     * FOLLOW during navigation — called every animation frame.
     *
     * Always jumpTo. The motion model already interpolates position and bearing per
     * frame, so the camera has nothing left to animate; starting an easeTo per frame
     * was the original stutter, because each new animation cancelled and restarted
     * the last. Zoom, pitch and padding are never re-asserted here — they were set
     * once on entry.
     */
    follow({ coord, bearing, cameraMode = CAMERA_MODES.FOLLOW }) {
      if (mode !== 'navigate') return;
      // Let the single entry animation finish before taking over.
      if (Date.now() < enteringUntil) return;

      if (cameraMode === CAMERA_MODES.OVERHEAD) {
        // North-up: the map does not rotate, so bearing is left alone entirely.
        lastBearing = 0;
        map.jumpTo({ center: coord });
        return;
      }
      const smoothed = smoothBearing(lastBearing, bearing ?? lastBearing ?? 0, 0.35);
      lastBearing = smoothed;

      /*
       * Re-assert zoom and pitch ONLY if they have drifted.
       *
       * The entry ease can be cut short — a container resize landing inside its 900ms
       * (which is exactly what happens when the layout changes as mission planning
       * starts) leaves the camera wherever the ease had reached. Measured: frozen at
       * zoom 11.74 / pitch 10 instead of 16.5 / 60, following the vehicle correctly but
       * from a wide, flat view, so the arrow was a dot at screen centre.
       *
       * Since `follow` never re-asserted zoom or pitch — deliberately, because doing it
       * every frame was the original stutter — the camera stayed stuck there for the
       * whole drive. Correcting only on a real discrepancy keeps the per-frame path a
       * plain centre+bearing jump while making the entry self-healing.
       */
      const wantZoom = NAV_ZOOM;
      const wantPitch = narrow() ? NAV_PITCH_NARROW : NAV_PITCH;
      const drifted =
        Math.abs(map.getZoom() - wantZoom) > 0.3 || Math.abs(map.getPitch() - wantPitch) > 4;

      if (drifted) {
        map.jumpTo({ center: coord, bearing: smoothed, zoom: wantZoom, pitch: wantPitch });
        return;
      }
      map.jumpTo({ center: coord, bearing: smoothed });
    },

    /**
     * Switch camera mode mid-drive: exactly one easeTo, never a flyTo.
     *
     * Follow and overhead differ in pitch, bearing and zoom at once, so animating
     * them in separate calls would produce three competing moves.
     */
    setCameraMode(next, { coord, bearing = 0 }) {
      if (mode !== 'navigate') return;
      const overhead = next === CAMERA_MODES.OVERHEAD;
      const target = overhead
        ? { center: coord, zoom: OVERHEAD_ZOOM, pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } }
        : {
            center: coord,
            zoom: NAV_ZOOM,
            pitch: narrow() ? NAV_PITCH_NARROW : NAV_PITCH,
            bearing,
            padding: navPadding(map),
          };
      lastBearing = overhead ? 0 : bearing;
      if (reduced()) {
        map.jumpTo(target);
        enteringUntil = 0;
        return;
      }
      map.easeTo({ ...target, duration: 700, essential: true });
      busyUntil = Date.now() + 700;
      // Hold off per-frame follow until the transition lands.
      enteringUntil = busyUntil;
    },

    /** Re-centre after the user panned away — same single move as entry. */
    recenter({ coord, bearing = 0, cameraMode = CAMERA_MODES.FOLLOW }) {
      trace('recenter', { mode });
      if (mode !== 'navigate') return;
      this.enterNavigation({ coord, bearing, cameraMode });
    },

    /** EXIT navigation: one easeTo back to a flat overview. */
    exitNavigation() {
      trace('exitNavigation', { mode });
      mode = 'browse';
      enteringUntil = 0;
      lastBearing = null;
      const target = { pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } };
      if (reduced()) {
        map.jumpTo(target);
        busyUntil = 0;
        return;
      }
      map.easeTo({ ...target, duration: 700, essential: true });
      busyUntil = Date.now() + 700;
    },

    /** Simple recentre used outside navigation (e.g. "find me"). */
    /**
     * ux-center: put a coordinate in the middle of the map.
     *
     * Separate from `goTo` because it must work DURING the animation too — the panel is
     * on screen while mission planning runs, so a structure row can be clicked then, and
     * `goTo` deliberately refuses in navigate mode. It also passes padding explicitly:
     * the nav camera sets padding, and inheriting a stale value would land the structure
     * off-centre for reasons invisible from the call site.
     *
     * Centring on the CANVAS is centring in the visible map area, because the side panel
     * is a real grid column rather than an overlay — the canvas simply does not extend
     * beneath it.
     */
    centerOn({ coord, zoom = 15, duration = 700 }) {
      trace('centerOn', { mode });
      const target = {
        center: coord,
        zoom,
        padding: { top: 0, bottom: 0, left: 0, right: 0 },
        essential: true,
      };
      if (reduced()) {
        map.jumpTo(target);
        return;
      }
      map.easeTo({ ...target, duration });
      busyUntil = Date.now() + duration;
    },

    goTo({ coord, zoom = 12 }) {
      trace('goTo', { mode });
      if (mode === 'navigate') return;
      const target = { center: coord, zoom };
      if (reduced()) {
        map.jumpTo(target);
        return;
      }
      // easeTo, not flyTo: no zoom-out arc.
      map.easeTo({ ...target, duration: 800, essential: true });
      busyUntil = Date.now() + 800;
    },

    /** Tilt without touching centre or zoom. Used by the 2D/3D toggle outside nav. */
    setPitch(pitch) {
      if (mode === 'navigate') return; // the nav camera owns pitch while driving
      if (reduced()) {
        map.jumpTo({ pitch });
        return;
      }
      map.easeTo({ pitch, duration: 700, essential: true });
      busyUntil = Date.now() + 700;
    },

    setMode(next) {
      mode = next;
    },
  };
}
