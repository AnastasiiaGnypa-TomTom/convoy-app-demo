/*
 * ux: a controlled, animated disclosure.
 *
 * Replaces the native <details> used for the avoidance, departure-time, makeup and
 * roundabout panels. Two reasons:
 *
 *  1. <details open> is DOM-local state. These blocks are conditionally rendered
 *     siblings, so whenever one of them flips in or out — which happens on every route
 *     recompute — React re-keys the list by position and recreates the element, and an
 *     open panel silently closed itself. That is the "closes and reappears" flicker.
 *     Open state now lives in App, above anything that remounts.
 *
 *  2. <details> cannot animate: the browser shows or hides its content outright. A grid
 *     row from 0fr to 1fr animates smoothly and needs no measured pixel height, so it
 *     works whatever the content is.
 *
 * Nothing here closes on its own. Only the header toggle changes the state.
 */
export default function Disclosure({ id, title, hint, open, onToggle, children, disabled }) {
  return (
    <section className={`disc ${open ? 'disc-open' : ''} ${disabled ? 'disc-disabled' : ''}`}>
      <button
        type="button"
        className="disc-head"
        onClick={() => !disabled && onToggle?.(id)}
        aria-expanded={Boolean(open)}
        aria-controls={`disc-body-${id}`}
        disabled={disabled}
      >
        <span className="disc-title">{title}</span>
        {hint && <span className="disc-hint">{hint}</span>}
        <span className="disc-chev" aria-hidden="true">
          ›
        </span>
      </button>
      {/*
        * Always rendered, never conditionally mounted — the animation needs both states
        * to exist, and unmounting is what lost the state in the first place. `inert`
        * keeps the collapsed content out of tab order and off screen readers.
        */}
      <div className="disc-wrap" id={`disc-body-${id}`} inert={open ? undefined : ''}>
        <div className="disc-body">{children}</div>
      </div>
    </section>
  );
}
