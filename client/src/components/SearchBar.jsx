import { useEffect, useId, useRef, useState } from 'react';
import { geocode } from '../api.js';

/**
 * Floating search bar — the app's primary entry point, like Google Maps.
 *
 * Free-text search is legitimate HERE and only here: the user is naming a place they
 * want. It is never used to populate a POI layer (see server/routes/pois.js).
 *
 * Debounced so a typed query costs one vendor call rather than one per keystroke.
 */
export default function SearchBar({ mapCenter, onPick, onOpenLayers, layerCount }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const id = useId();
  const wrapRef = useRef(null);
  const typedRef = useRef(false);
  // Bias without making the map centre an effect dependency, which would otherwise
  // reopen the dropdown every time the camera moves.
  const centerRef = useRef(mapCenter);
  centerRef.current = mapCenter;

  useEffect(() => {
    if (!typedRef.current) return;
    const q = text.trim();
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const { results: r } = await geocode(q, { center: centerRef.current, signal: ctl.signal });
        setResults(r);
        setOpen(r.length > 0);
        setActiveIndex(-1);
      } catch (err) {
        if (err.name !== 'AbortError') setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [text]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const choose = (r) => {
    typedRef.current = false;
    setText(r.label);
    setOpen(false);
    setResults([]);
    onPick({
      lat: r.position.lat,
      lon: r.position.lon,
      name: r.primary,
      address: r.label,
      category: r.type,
    });
  };

  return (
    <div className="searchbar" ref={wrapRef}>
      <div className="searchbar-field">
        <span className="searchbar-icon" aria-hidden="true">
          ⌕
        </span>
        <input
          id={id}
          type="search"
          value={text}
          placeholder="Search a place or address"
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          onChange={(e) => {
            typedRef.current = true;
            setText(e.target.value);
          }}
          onFocus={() => results.length && setOpen(true)}
          onKeyDown={(e) => {
            if (!open || !results.length) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActiveIndex((i) => (i + 1) % results.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(results[activeIndex >= 0 ? activeIndex : 0]);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        {loading && <span className="place-spinner" aria-hidden="true" />}
        {text && !loading && (
          <button
            type="button"
            className="searchbar-clear"
            onClick={() => {
              setText('');
              setResults([]);
              setOpen(false);
            }}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
        <button
          type="button"
          className={`searchbar-layers ${layerCount ? 'searchbar-layers-on' : ''}`}
          onClick={onOpenLayers}
          title="Map layers"
        >
          ☰{layerCount ? <span className="searchbar-badge">{layerCount}</span> : null}
        </button>
      </div>

      {open && (
        <ul className="suggestions searchbar-suggestions" role="listbox">
          {results.map((r, i) => (
            <li
              key={r.id || `${r.position.lat},${r.position.lon}`}
              role="option"
              aria-selected={i === activeIndex}
              className={i === activeIndex ? 'active' : ''}
              onMouseEnter={() => setActiveIndex(i)}
              onPointerDown={(e) => {
                e.preventDefault();
                choose(r);
              }}
            >
              <span className="sugg-primary">{r.primary}</span>
              {r.secondary && <span className="sugg-secondary">{r.secondary}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
