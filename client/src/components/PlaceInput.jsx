import { useEffect, useId, useRef, useState } from 'react';
import { geocode } from '../api.js';

/**
 * Text input with geocoding autocomplete.
 *
 * Debounced so a typed query costs one vendor call rather than one per keystroke —
 * the proxy also caches, but the key is rate-limited and a live demo must not
 * stall. Supports keyboard selection and a "pick on map" affordance.
 */
export default function PlaceInput({
  label,
  value,
  placeholder,
  mapCenter,
  onSelect,
  onPickOnMap,
  isPicking,
  accent,
}) {
  const [text, setText] = useState(value?.label || '');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const listId = useId();
  const wrapRef = useRef(null);
  /*
   * Suggestions are fetched only in response to typing. Without this guard the
   * dropdown reopens on its own whenever anything else in the effect's inputs
   * changes — notably the map centre, which updates on every `moveend`, so
   * fitting the camera to a new route would pop open an autocomplete list over
   * the route alternatives and swallow their clicks.
   */
  const typedRef = useRef(false);
  // Read the bias without making it an effect dependency.
  const centerRef = useRef(mapCenter);
  centerRef.current = mapCenter;

  // Keep the field in step when the parent sets a point (map click, demo default).
  useEffect(() => {
    setText(value?.label || '');
    typedRef.current = false;
    setSuggestions([]);
    setOpen(false);
  }, [value?.label, value?.lat, value?.lon]);

  useEffect(() => {
    if (!typedRef.current) return;
    const q = text.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const { results } = await geocode(q, { center: centerRef.current, signal: ctl.signal });
        setSuggestions(results);
        setOpen(results.length > 0);
        setActiveIndex(-1);
      } catch (err) {
        if (err.name !== 'AbortError') setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [text]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const choose = (s) => {
    typedRef.current = false;
    setText(s.label);
    setSuggestions([]);
    setOpen(false);
    onSelect({ lat: s.position.lat, lon: s.position.lon, label: s.label });
  };

  const onKeyDown = (e) => {
    if (!open || !suggestions.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(suggestions[activeIndex >= 0 ? activeIndex : 0]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="place-input" ref={wrapRef}>
      <div className="place-input-head">
        <label htmlFor={listId}>
          <span className="place-dot" style={{ background: accent }} aria-hidden="true" />
          {label}
        </label>
        <button
          type="button"
          className={`pick-btn ${isPicking ? 'pick-btn-active' : ''}`}
          onClick={onPickOnMap}
          aria-pressed={isPicking}
          title="Pick this point by clicking the map"
        >
          {isPicking ? 'Click map…' : 'Pick on map'}
        </button>
      </div>

      <div className="place-input-field">
        <input
          id={listId}
          type="text"
          value={text}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck="false"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${listId}-list`}
          onChange={(e) => {
            typedRef.current = true;
            setText(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => suggestions.length && setOpen(true)}
        />
        {loading && <span className="place-spinner" aria-hidden="true" />}
      </div>

      {open && (
        <ul className="suggestions" id={`${listId}-list`} role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={s.id || `${s.position.lat},${s.position.lon}`}
              role="option"
              aria-selected={i === activeIndex}
              className={i === activeIndex ? 'active' : ''}
              onMouseEnter={() => setActiveIndex(i)}
              // pointerdown fires before blur, so the click is not lost.
              onPointerDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
            >
              <span className="sugg-primary">{s.primary}</span>
              {s.secondary && <span className="sugg-secondary">{s.secondary}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
