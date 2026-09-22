/**
 * AuctiqNav.tsx
 * The landing's header bar: mark on the left, destinations across the middle,
 * social and the call to action on the right.
 *
 * Restyled from the reference mockup, which mirrors what was here before — the
 * mark used to pin itself to the top-right and the links sat in a glass pill on
 * the left. The bar is one row now, so the mark comes in through
 * `AuctiqLogo inline` rather than floating separately above the page.
 *
 * **The destinations are the real ones.** The reference's row reads HOME · LIVE
 * SCORES · PLAYERS · AUCTIONS · TEAM · MORE, and four of those six go nowhere in
 * this product. Shipping dead links because a mockup drew them is worse than the
 * row being shorter than the picture, so the labels below are the routes that
 * exist. `Home` is new and earns its place: the reference marks the current page
 * in cyan, and without it the landing had nothing to mark.
 *
 * **The entrance is a CSS class, not a Framer variant, and must stay that way.**
 * Framer sets `initial` inline and drives the animation on requestAnimationFrame,
 * so any frame where rAF never runs — a backgrounded tab, a throttled renderer,
 * an embedded preview — leaves the element at `initial` permanently. For a
 * decorative section that is a missed flourish; for primary navigation it is
 * navigation that never appears. `.auctiq-drop-in` runs off the document
 * timeline, and its keyframes move without fading, so even a stuck animation
 * leaves the bar visible fourteen pixels high rather than gone. The reasoning is
 * written out beside the keyframes in styles.css.
 *
 * **On the scrim.** The reference's bar is fully transparent, which works in a
 * still of the hero and fails the moment the page scrolls: this bar is fixed
 * over four viewports of content. The gradient below is opaque at the top edge
 * and transparent at the bottom, so it reads as an overlay on the hero while
 * keeping the labels legible over whatever scrolls beneath. A scroll listener
 * swapping the background at a threshold would match the mockup more exactly and
 * would put the legibility of the navigation behind a JS event, for the same
 * reason the entrance is not a Framer variant.
 */
import { Link, useLocation } from "react-router-dom";

import AuctiqLogo from "./AuctiqLogo";
import SocialRow from "./SocialRow";

interface Destination {
  to: string;
  label: string;
  /** Read out to assistive tech; the labels alone are ambiguous out of context. */
  hint: string;
}

const DESTINATIONS: Destination[] = [
  { to: "/", label: "Home", hint: "Home — the AUCTIQ landing" },
  { to: "/data", label: "Data Interface", hint: "Data Interface — read-only scouting and analytics" },
  {
    to: "/auction/live",
    label: "Live Bidding",
    hint: "Live Bidding — join the auction room",
  },
  { to: "/console", label: "Console", hint: "Console — the offline auction console" },
  { to: "/classic", label: "Classic", hint: "Classic — the original welcome screen" },
];

export default function AuctiqNav() {
  const { pathname } = useLocation();

  return (
    <header className="auctiq-drop-in fixed inset-x-0 top-0 z-40 bg-gradient-to-b from-auctiq-void/92 via-auctiq-void/55 to-transparent">
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-8 sm:py-4">
        {/*
          The mark is wrapped so the bar can be a true three-column row above
          `sm`: both flanks take `flex-1` and the nav between them does not, which
          puts the links on the viewport's centre line. Left to `mx-auto` alone
          the nav centres inside whatever space the flanks leave over, and since
          the mark is wider than the actions it sat about 50px left of centre.
        */}
        <div className="order-1 flex items-center sm:flex-1">
          <AuctiqLogo inline to="/" />
        </div>

        {/*
          Below `sm` the row drops beneath the mark and scrolls sideways rather
          than wrapping: five legible labels need roughly 560px and a phone does
          not have it spare. `.auctiq-rail` hides the scrollbar and fades the
          right edge, so a half-cut label advertises that there is more to reach.
        */}
        <nav
          aria-label="Primary"
          className="auctiq-rail order-3 w-full overflow-x-auto sm:order-2 sm:mx-auto sm:w-auto"
        >
          <ul className="flex w-max items-center">
            {DESTINATIONS.map((destination, i) => {
              /*
                The room answers to two paths — `/auction` from Phase 4 and
                `/auction/live`, which is what this link and the specification
                call it. A strict equality check would leave the nav showing
                nothing as current for a visitor who arrived on the other one,
                which reads as "you are nowhere".
              */
              const current =
                pathname === destination.to ||
                (destination.to === "/auction/live" && pathname === "/auction");
              return (
                <li key={destination.to} className="flex items-center">
                  {i > 0 && (
                    <span aria-hidden className="px-1 text-white/20">
                      |
                    </span>
                  )}
                  <Link
                    to={destination.to}
                    aria-label={destination.hint}
                    /*
                      `aria-current` as well as the colour. Cyan against grey is
                      the whole signal for a sighted reader and no signal at all
                      for anyone else.
                    */
                    aria-current={current ? "page" : undefined}
                    data-testid={`nav-${destination.label.toLowerCase().replace(/\s+/g, "-")}`}
                    className={`flex min-h-[44px] items-center whitespace-nowrap px-2.5 font-tech text-[12px] font-medium uppercase tracking-[0.12em] transition-colors duration-200 sm:px-3 ${
                      current
                        ? "text-neon-cyan"
                        : "text-auctiq-dim hover:text-auctiq-text"
                    }`}
                  >
                    {destination.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="order-2 ml-auto flex shrink-0 items-center gap-1 sm:order-3 sm:ml-0 sm:flex-1 sm:justify-end sm:gap-2">
          {/*
            First three only: the header has less width to spend than the footer,
            and the reference shows a shorter row here — a slice of one list, not
            a second list. Hidden entirely below `sm`, because decoration is the
            first thing to go when the row is competing with a call to action for
            a phone's width.
          */}
          <SocialRow limit={3} className="hidden sm:flex" />

          {/*
            "Join now" goes to the auction room, which is the only thing on this
            product a visitor can actually join. There is no sign-up flow behind
            it and it does not pretend there is.
          */}
          <Link
            to="/auction/live"
            data-testid="nav-join-now"
            className="ml-1 flex min-h-[38px] items-center whitespace-nowrap rounded-[6px] border border-neon-cyan/60 px-3.5 font-tech text-[11px] font-semibold uppercase tracking-[0.14em] text-neon-cyan transition-colors duration-200 hover:border-neon-cyan hover:bg-neon-cyan/10 sm:px-4"
          >
            Join now
          </Link>
        </div>
      </div>
    </header>
  );
}
