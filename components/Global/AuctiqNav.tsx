/**
 * AuctiqNav.tsx
 * The site's header bar: destinations across the middle, social and the call
 * to action on the right. Mounted on every AUCTONIQ page — floating over the
 * landing, About and AUCTEAM, and as an opaque `placement="static"` bar above
 * the Data Interface and the live room — so no page is a dead end.
 *
 * The mark that used to sit on the left was removed: it was small, and the
 * HOME link already does what clicking it did.
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
 *
 * **On the rebrand.** The product is AUCTONIQ in every string a visitor reads.
 * It is still `auctiq-*` in every Tailwind token, CSS class, component name and
 * route, and those are deliberately untouched: `text-auctiq-dim` and
 * `.auctiq-rail` are identifiers that happen to contain the old name, not
 * copy. Renaming them would mean renaming them in `tailwind.config.js` and
 * `styles.css` in the same breath or the bar loses its styling silently, and it
 * would buy nothing a visitor can see.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";

import SocialRow from "./SocialRow";
import AccountChip from "./AccountChip";
import { can, useAccount } from "../../console/accountStore";
import NotificationBell from "./NotificationBell";

/**
 * The legal notice, verbatim.
 *
 * Exported because the footer carries the same words. Two hand-copied versions
 * of a legal disclaimer drift, and a disclaimer that says something slightly
 * different in two places is worse than one that appears once.
 */
export const LEGAL_DISCLAIMER =
  "Disclaimer: AUCTONIQ is a virtual cricket auction simulation platform " +
  "designed strictly for entertainment, strategic analysis, and educational " +
  "purposes. This platform does not promote, facilitate, or engage in any " +
  "form of real-money betting, gambling, or wagering. AUCTONIQ is not " +
  "affiliated with or endorsed by any commercial gambling site or official " +
  "sports governing body. Terms & Conditions Apply.";

interface Destination {
  to: string;
  label: string;
  /** Read out to assistive tech; the labels alone are ambiguous out of context. */
  hint: string;
  /**
   * Kept in this list, kept out of the bar.
   *
   * The Console and Classic views are being taken off the header without being
   * taken out of the product: both routes still resolve, both screens still
   * work, and anyone holding a link to either still lands on it. Deleting the
   * entries would have removed the route contract along with the button, and
   * restoring it later would mean remembering what the labels and hints were.
   * A flag makes re-enabling a one-word edit.
   */
  hidden?: boolean;
}

const DESTINATIONS: Destination[] = [
  { to: "/", label: "Home", hint: "Home — the AUCTONIQ landing" },
  { to: "/data", label: "Data Interface", hint: "Data Interface — read-only scouting and analytics" },
  {
    to: "/auction/live",
    label: "Live Bidding",
    hint: "Live Bidding — join the auction room",
  },
  { to: "/aucteam", label: "AUCTEAM", hint: "AUCTEAM — build a playing XI and get a SCOUT report" },
  { to: "/about", label: "About", hint: "About — what AUCTONIQ is and how it works" },
  // Hidden from the bar, live everywhere else. See `Destination.hidden`.
  { to: "/console", label: "Console", hint: "Console — the offline auction console", hidden: true },
  { to: "/classic", label: "Classic", hint: "Classic — the original welcome screen", hidden: true },
];

/**
 * The three steps and the four problems, as data.
 *
 * Out here rather than inline in the dialog so the markup below stays readable
 * as markup, and so changing a sentence does not mean editing inside JSX.
 * Exported because the About page (pages/About.tsx) carries the same words.
 */
export const HOW_IT_WORKS: { step: string; title: string; body: string }[] = [
  {
    step: "01",
    title: "Build the room",
    body: "Load the player pool, seat each franchise, and every team starts with the same purse and the same squad rules.",
  },
  {
    step: "02",
    title: "Bid on the clock",
    body: "A player goes on the block and a seven-second timer runs. Any bid restarts it. When it expires the lot is sold, and the hammer falls the same way for everyone in the room.",
  },
  {
    step: "03",
    title: "Track it live",
    body: "Purses, squad counts and overseas limits update the moment a lot closes. Nobody adds anything up, and nobody disagrees about what a team can still afford.",
  },
];

export const PROBLEMS_SOLVED: { title: string; body: string }[] = [
  {
    title: "No more spreadsheet errors",
    body: "A shared sheet has one person typing and everyone else trusting them. Here the room holds the state, so a mistyped bid is not a silent mistake that surfaces three lots later.",
  },
  {
    title: "No manual purse maths",
    body: "Remaining purse, maximum legal bid and squad slots are computed from the rules, not worked out by hand while everyone waits.",
  },
  {
    title: "No waiting between lots",
    body: "The timer runs in the room and every screen sees the same clock, so the auction moves at the pace of the bidding rather than the pace of the bookkeeping.",
  },
  {
    title: "Instant answers on any player",
    body: "The Scout Assistant reads the pool and recent form and answers questions about a player while the lot is still open, instead of someone opening a stats site mid-auction.",
  },
];

/**
 * The About dialog.
 *
 * Superseded by the /about page and unmounted: the nav's About entry is a link
 * now. Kept on disk rather than deleted, like `LiveBiddingCard`; restoring it
 * is an `aboutOpen` state, a button in the bar and the render line at the
 * bottom of `AuctiqNav`.
 *
 * Deliberately in this file rather than its own. It has exactly one trigger,
 * the button beside it, and splitting the two would mean shipping a nav with a
 * button that does nothing until a second file lands — which reads as a broken
 * button, not as work in progress.
 */
function AboutDialog({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Escape closes. Registered on the document because focus may be anywhere
    // inside the panel, and removed on unmount -- a listener left behind would
    // survive navigation and keep firing against a closed dialog.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    // Lock the page behind the overlay. Without this the landing scrolls under
    // the dialog on a trackpad, which on a fixed overlay looks like the dialog
    // itself is broken. The previous value is restored rather than assumed to
    // be "" -- something else may have set it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    panel.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  /*
    Portalled to `document.body`, and this is not stylistic.

    Rendered in place, the overlay is a child of `<header>`, which carries the
    `.auctiq-drop-in` entrance — and an ancestor with a transform becomes the
    containing block for `position: fixed` descendants. So `inset-0` resolved
    against the 78px-tall header instead of the viewport: measured in the
    browser, the overlay came back 1024x80. The dialog rendered, the backdrop
    covered the header strip only, and the landing showed straight through it.

    Raising the z-index would not have helped -- the header also establishes a
    stacking context at `z-40`, so a `z-50` child is confined to it regardless.
    A portal leaves both problems behind by leaving the subtree.
  */
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-auctiq-void/85 px-4 py-10 backdrop-blur-sm"
      // A click on the backdrop closes; a click inside must not. The target
      // check is what distinguishes them -- without it, every click in the
      // panel bubbles up here and shuts the dialog.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-auctoniq-title"
        tabIndex={-1}
        data-testid="about-dialog"
        className="w-full max-w-[860px] rounded-[10px] border border-white/12 bg-auctiq-card/95 p-6 shadow-2xl outline-none sm:p-8"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="about-auctoniq-title"
              className="font-tech text-[18px] font-semibold uppercase tracking-[0.14em] text-auctiq-text"
            >
              About AUCTONIQ
            </h2>
            <p className="mt-1 font-tech text-[11.5px] uppercase tracking-[0.1em] text-auctiq-dim">
              A virtual cricket auction, run properly
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the About dialog"
            data-testid="about-close"
            className="flex min-h-[38px] shrink-0 items-center rounded-[6px] border border-white/15 px-3 font-tech text-[11px] uppercase tracking-[0.14em] text-auctiq-dim transition-colors duration-200 hover:border-white/35 hover:text-auctiq-text"
          >
            Close
          </button>
        </div>

        <p className="mt-5 text-[13.5px] leading-relaxed text-auctiq-text/85">
          AUCTONIQ runs a cricket player auction the way a real one works — a
          shared room, a live clock, and a purse that everyone can see. It
          replaces the spreadsheet and the person shouting numbers across a
          table.
        </p>

        <section className="mt-7">
          <h3 className="font-tech text-[12px] font-semibold uppercase tracking-[0.14em] text-neon-cyan">
            How it works
          </h3>
          <ol className="mt-3 grid gap-3 sm:grid-cols-3">
            {HOW_IT_WORKS.map((item) => (
              <li
                key={item.step}
                className="rounded-[8px] border border-white/10 bg-white/[0.03] p-4"
              >
                <span className="font-tech text-[11px] tracking-[0.16em] text-auctiq-gold">
                  {item.step}
                </span>
                <h4 className="mt-1.5 font-tech text-[12.5px] font-semibold uppercase tracking-[0.08em] text-auctiq-text">
                  {item.title}
                </h4>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-auctiq-dim">
                  {item.body}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-7">
          <h3 className="font-tech text-[12px] font-semibold uppercase tracking-[0.14em] text-neon-cyan">
            What it fixes
          </h3>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {PROBLEMS_SOLVED.map((item) => (
              <li
                key={item.title}
                className="rounded-[8px] border border-white/10 bg-white/[0.03] p-4"
              >
                <h4 className="font-tech text-[12.5px] font-semibold uppercase tracking-[0.08em] text-auctiq-text">
                  {item.title}
                </h4>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-auctiq-dim">
                  {item.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <p
          data-testid="about-disclaimer"
          className="mt-7 rounded-[8px] border border-auctiq-gold/25 bg-auctiq-gold/[0.06] p-4 text-[12px] italic leading-relaxed text-auctiq-dim"
        >
          {LEGAL_DISCLAIMER}
        </p>
      </div>
    </div>,
    document.body,
  );
}

export interface AuctiqNavProps {
  /**
   * `fixed`  — floats over the page on a fading scrim. The landing, About and
   *            AUCTEAM, whose heroes are laid out to sit under it.
   * `static` — an opaque bar in normal flow. The Data Interface and the live
   *            room fill the viewport themselves, and a fixed bar would sit on
   *            top of their own headers.
   */
  placement?: "fixed" | "static";
}

export default function AuctiqNav({ placement = "fixed" }: AuctiqNavProps = {}) {
  const { pathname } = useLocation();

  /*
    Filtered here, before anything is rendered, and this ordering is the bug it
    exists to avoid. The separator below is drawn for every entry after the
    first, so filtering inside the map -- with the index from the unfiltered
    array -- would leave a leading "|" floating at the start of the bar as soon
    as a hidden entry sorted first.
  */
  // Delegates do not get the Data Interface (console/accountStore.ts, ACCESS),
  // so its link is not offered to them either.
  const { account } = useAccount();
  const visible = DESTINATIONS.filter(
    (destination) => !destination.hidden && (destination.to !== "/data" || can(account, "data")),
  );

  return (
    <header
      className={
        placement === "fixed"
          ? "auctiq-drop-in fixed inset-x-0 top-0 z-40 bg-gradient-to-b from-auctiq-void/92 via-auctiq-void/55 to-transparent"
          : "relative z-40 border-b border-white/10 bg-auctiq-void/90 backdrop-blur-md"
      }
    >
      <div
        className={`mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-x-3 gap-y-2 px-4 sm:flex-nowrap sm:px-8 ${
          placement === "fixed" ? "py-3 sm:py-4" : "py-1.5 sm:py-2"
        }`}
      >
        {/*
          The left flank, now empty. The mark that sat here was small and went
          nowhere useful, so it was taken off the bar; the flank stays as a
          `flex-1` spacer so the links keep the viewport's centre line against
          the actions on the right.
        */}
        <div aria-hidden className="order-1 hidden sm:block sm:flex-1" />

        {/*
          Below `sm` the row drops beneath the mark and scrolls sideways rather
          than wrapping: the labels need more width than a phone has spare.
          `.auctiq-rail` hides the scrollbar and fades the right edge, so a
          half-cut label advertises that there is more to reach.
        */}
        <nav
          aria-label="Primary"
          className="auctiq-rail order-3 w-full overflow-x-auto sm:order-2 sm:mx-auto sm:w-auto"
        >
          <ul className="flex w-max items-center">
            {visible.map((destination, i) => {
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
                    /*
                      13.5px semibold: these five are the product's main
                      functions, so they read as controls rather than captions.
                    */
                    className={`flex min-h-[44px] items-center whitespace-nowrap px-2.5 font-tech text-[13.5px] font-semibold uppercase tracking-[0.12em] transition-colors duration-200 sm:px-3 ${
                      current
                        ? "text-neon-cyan"
                        : "text-auctiq-text/80 hover:text-auctiq-text"
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

            On a dark plate rather than a bare outline. The bar's scrim is
            transparent at its lower edge, and over the About page's floodlit
            sky a cyan outline with no fill all but vanished. The plate carries
            its own contrast, so the button reads the same over any page.
          */}
          <NotificationBell />
          <AccountChip />

          <Link
            to="/auction/live"
            data-testid="nav-join-now"
            className="ml-1 flex min-h-[38px] items-center whitespace-nowrap rounded-[6px] border border-neon-cyan bg-auctiq-void/85 px-3.5 font-tech text-[11px] font-semibold uppercase tracking-[0.14em] text-neon-cyan shadow-neon-cyan backdrop-blur-sm transition-colors duration-200 hover:bg-neon-cyan hover:text-auctiq-void sm:px-4"
          >
            Join now
          </Link>
        </div>
      </div>
    </header>
  );
}
