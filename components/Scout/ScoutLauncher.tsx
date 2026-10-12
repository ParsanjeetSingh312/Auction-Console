/**
 * ScoutLauncher.tsx
 * The floating widget that opens SCOUT, on every route.
 *
 * **It stays above the sheet rather than behind it.** The launcher is z-50 and
 * the sheet is z-40, so the button never disappears under the thing it opened
 * and doubles as the close control — the emblem crossfades to a cross while the
 * sheet is open. Below `md` the sheet is full width and its own header carries
 * the close button, so the launcher steps aside rather than sitting on the pill.
 *
 * **The mark is SCOUT's emblem, animated** — the ball through the stumps, the
 * rings turning (ScoutEmblem, "mark" variant). It pauses while the sheet is
 * open: a wicket still falling behind an open panel reads as SCOUT still
 * searching for something. Reduced motion gets the emblem's composed still.
 */
import {
  toggleScout,
  useHotkeyLabel,
  useScoutOpen,
} from "../../console/scoutStore";
import ScoutEmblem from "./ScoutEmblem";

export default function ScoutLauncher() {
  const open = useScoutOpen();
  const hotkey = useHotkeyLabel();

  return (
    <div
      className={`group/launcher fixed bottom-6 right-6 z-50 flex items-center gap-2 ${open ? "max-md:hidden" : ""}`}
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
        aria-label={open ? "Close SCOUT" : `Open SCOUT — press ${hotkey}`}
        data-testid="scout-launcher"
        className="relative grid h-14 w-14 place-items-center overflow-hidden rounded-full border border-auctiq-gold/35 bg-[#0a1430]/90 shadow-[0_8px_32px_rgba(0,0,0,.45),0_0_26px_-10px_rgba(245,185,43,.75)] backdrop-blur-xl transition-[transform,border-color,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:border-auctiq-gold/70 hover:shadow-[0_8px_32px_rgba(0,0,0,.45),0_0_34px_-8px_rgba(245,185,43,.95)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 active:translate-y-0"
      >
        <span
          className="absolute inset-0 grid place-items-center transition-[opacity,transform] duration-300 ease-out"
          style={{ opacity: open ? 0 : 1, transform: open ? "scale(0.8) rotate(-20deg)" : "none" }}
        >
          <ScoutEmblem variant="mark" className="h-[52px] w-[52px]" paused={open} />
        </span>
        <svg
          viewBox="0 0 40 40"
          className="relative h-6 w-6 text-auctiq-gold transition-[opacity,transform] duration-300 ease-out"
          style={{ opacity: open ? 1 : 0, transform: open ? "none" : "scale(0.6) rotate(45deg)" }}
          fill="none"
          aria-hidden
        >
          <path d="M12 12 L28 28 M28 12 L12 28" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
