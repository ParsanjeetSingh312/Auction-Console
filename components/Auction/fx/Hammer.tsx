/**
 * Hammer.tsx
 * The auction hammer, as a drawing.
 *
 * Ported from the prototype unchanged, because it was right: SVG rather than an
 * image so it scales to any size, inherits colour, and costs no second request.
 *
 * **The transform origin matters more than the artwork.** It sits at the grip —
 * 72% across, 88% down — so a parent can rotate this element and the head
 * swings around the hand the way a hammer does. Rotated about its centre
 * instead, the whole tool pivots in mid-air like a compass needle, which is the
 * single thing most likely to make the strike look wrong.
 *
 * Kept separate from the cinematic that swings it because the mark is meant to
 * recur — the SOLD strike now, section transitions and a loading state later —
 * and a shape used in three places should not carry one of them's animation.
 */
export function Hammer({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 120 120"
      width="100%"
      height="100%"
      role="presentation"
      focusable="false"
    >
      <defs>
        <linearGradient id="auctiq-hammer-head" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f7e2ae" />
          <stop offset="48%" stopColor="#d8b271" />
          <stop offset="100%" stopColor="#8d6a35" />
        </linearGradient>
        <linearGradient id="auctiq-hammer-shaft" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e2c896" />
          <stop offset="100%" stopColor="#7d5c2e" />
        </linearGradient>
      </defs>

      {/* Head, with a cheek at each end. */}
      <g transform="rotate(-38 52 40)">
        <rect x="16" y="26" width="72" height="28" rx="8" fill="url(#auctiq-hammer-head)" />
        <rect x="12" y="22" width="14" height="36" rx="5" fill="url(#auctiq-hammer-head)" />
        <rect x="78" y="22" width="14" height="36" rx="5" fill="url(#auctiq-hammer-head)" />
        {/* A band of highlight, so the head reads as turned metal. */}
        <rect x="46" y="26" width="6" height="28" rx="3" fill="#fff6dd" opacity="0.5" />
      </g>

      <rect
        x="54"
        y="46"
        width="11"
        height="62"
        rx="5.5"
        fill="url(#auctiq-hammer-shaft)"
        transform="rotate(-38 59 77)"
      />
    </svg>
  );
}
