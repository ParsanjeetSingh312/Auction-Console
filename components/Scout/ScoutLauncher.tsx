/**
 * ScoutLauncher.tsx
 * The floating widget that opens SCOUT, on every route.
 *
 * **It stays above the drawer rather than behind it.** The launcher is z-50 and
 * the panel is z-40, so the button never disappears under the thing it opened
 * and doubles as the close control — the pattern every docked assistant uses,
 * and the reason the mark below crossfades to a cross instead of the panel
 * carrying its own separate close button in the corner.
 *
 * **The idle animation is a radar sweep, and it is GSAP rather than CSS.** A
 * rotating conic gradient would be one line of CSS, but `prefers-reduced-motion`
 * would then have to be handled in a media query that duplicates the geometry,
 * and the sweep has to stop while the panel is open — which is a state CSS
 * cannot see. `gsap.matchMedia` gives both for free: the tween is simply never
 * created for a reduced-motion user, so there is no animation to fight.
 *
 * The mark is drawn rather than imported. There is no SCOUT logo asset in the
 * repo, and a 40px inline SVG costs nothing next to a network request.
 */
import { useRef } from "react";

import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import {
  toggleScout,
  useHotkeyLabel,
  useScoutOpen,
} from "../../console/scoutStore";

gsap.registerPlugin(useGSAP);

export default function ScoutLauncher() {
  const container = useRef<HTMLDivElement>(null);
  const sweep = useRef<SVGGElement>(null);
  const ring = useRef<SVGCircleElement>(null);

  const open = useScoutOpen();
  const hotkey = useHotkeyLabel();

  /*
    The idle loop. Scoped to the container so nothing here can select an
    element that belongs to another component, and torn down automatically
    when the launcher unmounts — which is what `useGSAP` buys over a bare
    `useEffect` full of `gsap.to` calls.

    It rebuilds when `open` flips because a radar that keeps sweeping behind an
    open panel reads as the assistant still searching for something.
  */
  useGSAP(
    () => {
      if (open) return;

      const media = gsap.matchMedia();

      media.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.to(sweep.current, {
          rotation: 360,
          transformOrigin: "50% 50%",
          duration: 3.2,
          ease: "none",
          repeat: -1,
        });

        // A slow breath on the outer ring, so the widget reads as listening
        // rather than as a static button someone forgot to style.
        gsap.to(ring.current, {
          opacity: 0.25,
          scale: 1.08,
          transformOrigin: "50% 50%",
          duration: 1.9,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
        });
      });

      return () => media.revert();
    },
    { dependencies: [open], scope: container },
  );

  return (
    <div
      ref={container}
      className="fixed bottom-6 right-6 z-50 flex items-center gap-2"
    >
      {/* The shortcut hint. Hidden from the accessibility tree because the
          button's own label already announces it, and a touch device has no
          keyboard to press it on — hence `hidden sm:flex`. */}
      <span
        aria-hidden
        className="pointer-events-none hidden select-none items-center rounded-full border border-white/10 bg-auctiq-card/80 px-2.5 py-1 font-tech text-[10px] font-medium uppercase tracking-[0.14em] text-auctiq-dim opacity-0 shadow-glass backdrop-blur-md transition-opacity duration-200 group-hover/launcher:opacity-100 sm:flex"
      >
        {hotkey}
      </span>

      <button
        type="button"
        onClick={() => toggleScout("launcher")}
        aria-expanded={open}
        aria-controls="scout-drawer"
        aria-label={
          open ? "Close SCOUT" : `Open SCOUT — press ${hotkey}`
        }
        className="group/launcher grid h-14 w-14 place-items-center rounded-full border border-white/12 bg-auctiq-card/85 text-cyan-300 shadow-glass backdrop-blur-xl transition-[transform,border-color,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:border-cyan-400/45 hover:shadow-[0_8px_32px_rgba(0,0,0,.45),0_0_34px_-10px_rgba(34,211,238,.8)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 active:translate-y-0"
      >
        <svg viewBox="0 0 40 40" className="h-7 w-7" fill="none" aria-hidden>
          {/* Radar rings */}
          <circle
            ref={ring}
            cx="20"
            cy="20"
            r="16"
            stroke="currentColor"
            strokeWidth="1.25"
            opacity="0.55"
          />
          <circle
            cx="20"
            cy="20"
            r="9.5"
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.3"
          />

          {/* The sweep: a wedge plus its leading edge. */}
          <g
            ref={sweep}
            className="origin-center transition-opacity duration-300"
            style={{ opacity: open ? 0 : 1 }}
          >
            <path
              d="M20 20 L20 4 A16 16 0 0 1 33.9 12 Z"
              fill="currentColor"
              opacity="0.16"
            />
            <line
              x1="20"
              y1="20"
              x2="20"
              y2="4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </g>

          {/* The contact blip, and the cross it becomes when open. */}
          <circle
            cx="20"
            cy="20"
            r="2.75"
            fill="currentColor"
            className="transition-opacity duration-300"
            style={{ opacity: open ? 0 : 1 }}
          />
          <path
            d="M14 14 L26 26 M26 14 L14 26"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            className="transition-opacity duration-300"
            style={{ opacity: open ? 1 : 0 }}
          />
        </svg>
      </button>
    </div>
  );
}
