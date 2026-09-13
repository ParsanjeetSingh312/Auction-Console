/**
 * AuctiqLogo.tsx
 * The brand mark, pinned to the top-right of the landing surface.
 *
 * Fixed rather than scrolled, because on a page whose whole job is to move —
 * a scattering card stack, a revolving trophy, parallax on the pointer — one
 * thing has to stay still for the rest to read as motion rather than chaos.
 *
 * On the pulse. The brief asked for a pulsating effect and this one is
 * deliberately quiet: the ring breathes across 4.5 seconds at a few per cent,
 * and the wordmark does not move at all. A logo that throbs in the corner of
 * every screen is the kind of animation that is charming for ten seconds and
 * irritating for the rest of the session, and it competes with the scroll
 * choreography that is supposed to be the star. Reduced motion stops it dead.
 *
 * It is a link, not an ornament. A brand mark in the corner of a page is the
 * one element every visitor already expects to take them home, and making it
 * inert breaks a convention for no gain. That also gets it a focus ring and a
 * 44px touch target for free — the design database's first two priorities are
 * contrast and touch sizing, and a decorative `div` satisfies neither.
 */
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";

export interface AuctiqLogoProps {
  /** Where the mark navigates. Defaults to the landing itself. */
  to?: string;
  /** Hides the wordmark, leaving the mark alone — for narrow overlays. */
  markOnly?: boolean;
  className?: string;
}

export default function AuctiqLogo({
  to = "/auctiq",
  markOnly = false,
  className = "",
}: AuctiqLogoProps) {
  const reduced = useReducedMotion();

  return (
    <div
      className={`pointer-events-none fixed right-4 top-4 z-50 sm:right-6 sm:top-6 ${className}`}
    >
      <Link
        to={to}
        aria-label="AUCTIQ — home"
        className="pointer-events-auto group flex min-h-[44px] items-center gap-2.5 rounded-full border border-white/10 bg-white/[0.04] py-2 pl-2 pr-3.5 shadow-glass backdrop-blur-xl transition-colors duration-200 hover:border-auctiq-gold/40 sm:pr-4"
      >
        <span className="relative grid h-7 w-7 shrink-0 place-items-center">
          {/*
            The breathing ring, drawn behind the mark. Scaling a shadow rather
            than the mark itself means the geometry never shifts — a logo that
            changes size in the corner is read as a layout bug.
          */}
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full"
            style={{ boxShadow: "0 0 18px -4px rgba(246,196,90,0.55)" }}
            animate={reduced ? { opacity: 0.5 } : { opacity: [0.35, 0.8, 0.35] }}
            transition={
              reduced
                ? { duration: 0 }
                : { duration: 4.5, repeat: Infinity, ease: "easeInOut" }
            }
          />
          <AuctiqMark className="relative h-7 w-7" />
        </span>

        {!markOnly && (
          <span className="flex flex-col leading-none">
            <span className="font-auctiq text-[15px] tracking-[0.16em] text-auctiq-text">
              AUCTIQ
            </span>
            {/*
              The tagline is hidden below `sm` rather than shrunk. At 9px it
              would be under the database's 12px floor for legible text, and an
              unreadable line is worse than an absent one.
            */}
            <span className="mt-[3px] hidden font-tech text-[9.5px] uppercase tracking-[0.22em] text-auctiq-dim sm:block">
              IPL 2026
            </span>
          </span>
        )}
      </Link>
    </div>
  );
}

/**
 * The mark: a cricket ball whose seam doubles as a rising line.
 *
 * Carried over from the white-theme landing deliberately — the same geometry
 * in a gold-on-dark colourway, so the two surfaces are recognisably one
 * product rather than two designs that happen to share a name.
 */
export function AuctiqMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id="auctiq-dark-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#141A2E" />
          <stop offset="100%" stopColor="#020617" />
        </linearGradient>
        <linearGradient id="auctiq-dark-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F6C45A" />
          <stop offset="100%" stopColor="#CA8A04" />
        </linearGradient>
      </defs>

      <rect
        width="32"
        height="32"
        rx="9"
        fill="url(#auctiq-dark-mark)"
        stroke="rgba(246,196,90,0.30)"
      />
      <circle
        cx="16"
        cy="16"
        r="8"
        fill="none"
        stroke="url(#auctiq-dark-gold)"
        strokeWidth="1.8"
      />
      <path
        d="M16 8.2 C11.6 10.8 11.6 21.2 16 23.8"
        fill="none"
        stroke="#F6C45A"
        strokeOpacity="0.55"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M16 8.2 C20.4 10.8 20.4 21.2 16 23.8"
        fill="none"
        stroke="#F6C45A"
        strokeOpacity="0.55"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="24.5" cy="7.5" r="3" fill="#F6C45A" />
    </svg>
  );
}
