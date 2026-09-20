/**
 * AuctiqNav.tsx
 * The four ways into the product, across the top of the landing.
 *
 * These used to live in the footer at 11px, which put the primary navigation
 * of the whole application four screens below the fold in the smallest type on
 * the page. They are the product's table of contents, so they belong where a
 * table of contents goes.
 *
 * Fixed, not scrolled. The page is 400vh; a header that scrolls away means the
 * only route to the Data Interface from the bottom of the showcase is to scroll
 * all the way back. Fixed also pairs it with the logo, which is already pinned
 * top-right — together they frame the top edge instead of one floating alone.
 *
 * On the sizing. 13px uppercase with 0.14em tracking, in a 44px-tall pill.
 * That clears the design database's 12px floor for legible UI text and its
 * 44px touch-target minimum, and it is the smallest size at which a row of
 * links reads as navigation rather than as fine print.
 *
 * On the two layouts. Above `sm` the pill sits top-left, level with the logo,
 * capped so it can never grow underneath it. Below `sm` there is no room for
 * both on one line — four labels at a legible size need roughly 500px and the
 * logo already owns the right-hand corner — so the row drops beneath the logo
 * and scrolls horizontally, with the edges masked so a half-cut label advertises
 * that there is more to the right. Still horizontal, still all four, no menu
 * to open.
 *
 * The entrance is a CSS class (`.auctiq-drop-in`), not a Framer Motion
 * variant like everything else on this page. That is deliberate and the
 * reasoning is in styles.css: Framer starts from `initial` and animates on
 * rAF, so a frame where rAF never runs leaves the nav stuck at `initial`
 * permanently. That is also why this entrance only moves and never fades —
 * its stuck state has to be "visible, fourteen pixels high", not "gone".
 */
import { Link } from "react-router-dom";

interface Destination {
  to: string;
  label: string;
  /** Read out to assistive tech; the labels alone are ambiguous out of context. */
  hint: string;
}

const DESTINATIONS: Destination[] = [
  { to: "/data", label: "Data Interface", hint: "Data Interface — read-only scouting and analytics" },
  { to: "/auction", label: "Live Bidding", hint: "Live Bidding — join the auction room" },
  { to: "/console", label: "Console", hint: "Console — the offline auction console" },
  { to: "/classic", label: "Classic", hint: "Classic — the original welcome screen" },
];

export default function AuctiqNav() {
  return (
    /*
      `pointer-events-none` on the frame, re-enabled on the pill. The frame spans
      the full width at the top of a page where the showcase cards scatter into
      the corners; without this it would swallow hover and clicks across a strip
      the nav does not actually occupy.
    */
    <header className="auctiq-drop-in pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-start px-4 pt-[72px] sm:px-6 sm:pt-6">
      <nav
        aria-label="Primary"
        /*
          `max-w` on `sm` reserves the top-right corner for the logo — roughly
          136px of pill plus its 24px offset, rounded up so the two never touch.
          Past that cap the row scrolls rather than sliding under the mark.
        */
        className="auctiq-rail pointer-events-auto w-full overflow-x-auto sm:w-auto sm:max-w-[calc(100vw-200px)]"
      >
        {/*
          The `::after` is a 24px flex item, present only below `sm`. It gives
          the row something to end on: scrolled fully right, the last label
          clears the 20px edge fade instead of sitting permanently half-dimmed,
          and what you see at the end is the pill's own rounded cap.
        */}
        <ul className="flex w-max items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] p-1.5 shadow-glass backdrop-blur-xl after:block after:w-6 after:shrink-0 after:content-[''] sm:after:hidden">
          {DESTINATIONS.map((destination) => (
            <li key={destination.to}>
              <Link
                to={destination.to}
                aria-label={destination.hint}
                className="group relative flex min-h-[44px] items-center whitespace-nowrap rounded-full px-4 font-tech text-[13px] uppercase tracking-[0.14em] text-auctiq-dim transition-colors duration-200 hover:bg-white/[0.05] hover:text-auctiq-text sm:px-5"
              >
                {destination.label}
                {/*
                  A gold hairline that opens from the centre on hover. An
                  underline rather than a fill because the pill already tints on
                  hover — two strong signals on one control read as a bug.
                */}
                <span
                  aria-hidden
                  className="absolute inset-x-4 bottom-[9px] h-px origin-center scale-x-0 bg-auctiq-gold/70 transition-transform duration-200 ease-out group-hover:scale-x-100 sm:inset-x-5"
                />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
