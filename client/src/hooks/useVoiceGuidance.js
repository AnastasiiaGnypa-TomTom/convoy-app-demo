import { useEffect, useRef } from 'react';

/**
 * Voice guidance via the Web Speech API. OFF by default, as specced.
 *
 * Announces each maneuver twice — once on approach (~300 m) and once immediately
 * before — which is the cadence drivers expect. Each announcement fires at most once
 * per maneuver per phase, tracked by index, so an utterance is never repeated on
 * every animation frame.
 */
export function useVoiceGuidance({ enabled, maneuver, navigating }) {
  const spokenRef = useRef({ index: -1, phase: null });

  // Clear history when navigation stops, so a new trip re-announces from the start.
  useEffect(() => {
    if (!navigating) {
      spokenRef.current = { index: -1, phase: null };
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    }
  }, [navigating]);

  useEffect(() => {
    if (!enabled || !navigating || !maneuver) return;
    if (typeof speechSynthesis === 'undefined') return;

    const d = maneuver.distanceToManeuver;
    const phase = d < 60 ? 'now' : d < 320 ? 'approach' : null;
    if (!phase) return;

    const already =
      spokenRef.current.index === maneuver.index && spokenRef.current.phase === phase;
    if (already) return;
    // Do not fire the far announcement after the near one has already played.
    if (spokenRef.current.index === maneuver.index && spokenRef.current.phase === 'now') return;

    spokenRef.current = { index: maneuver.index, phase };

    const base = maneuver.message || maneuver.maneuver?.replace(/_/g, ' ').toLowerCase() || 'continue';
    const text =
      phase === 'approach' ? `In ${Math.round(d / 50) * 50} meters, ${base}` : base;

    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.lang = 'en-GB';
      speechSynthesis.speak(u);
    } catch {
      /* speech is a nicety; never let it break guidance */
    }
  }, [enabled, navigating, maneuver]);
}
