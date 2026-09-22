/**
 * Auctiq.tsx
 * The landing page: a list of sections, and the atmosphere they sit in.
 *
 * Deliberately thin. Every section owns its own markup and motion, so changing
 * the order of the page is moving one line here rather than surgery on a
 * thousand-line file.
 *
 * The `.auctiq` wrapper is what keeps two themes in one application honest.
 * Every dark token and glass utility is scoped to that class in styles.css, and
 * `body` is never touched — so nothing on this page can reach the console, the
 * Data Interface or the war room, which keep the white enterprise theme from
 * Phase 3b. The alternative, a `dark` class on <html> with `dark:` variants
 * everywhere, would mean editing thirty-odd existing components to describe a
 * theme none of them will ever be shown in.
 */
import { useEffect, useRef } from "react";

import { useReducedMotion } from "framer-motion";

import { useQuality } from "../components/3D/rig/quality";
import { useJourneyProgress } from "../hooks/useJourney";
import CricketCursor from "../components/UI/CricketCursor";
import AuctiqFooter from "../components/Global/AuctiqFooter";
import AuctiqNav from "../components/Global/AuctiqNav";
import BroadcastHero from "../components/Sections/BroadcastHero";
import StadiumBackdrop from "../components/Sections/StadiumBackdrop";
import PlayerShowcase from "../components/Sections/PlayerShowcase";

export default function Auctiq() {
  const page = useRef<HTMLDivElement>(null);
  const quality = useQuality();
  const reduced = useReducedMotion() ?? false;

  /*
    The journey runs off this page's own scroll rather than a dedicated track.

    The landing already scrolls a long way, so adding a separate tall element to
    drive the camera would double the page height. Binding the trigger to the
    page root instead means the arena's beats play out across the sections that
    are already there — the arena wakes up over the hero, the camera descends
    through the showcase.

    **No Lenis here, deliberately.** Smooth scroll is what gives the prototype
    its gliding camera, and it was the plan — but Lenis takes ownership of the
    page by transforming its wrapper, and this landing is built on `position:
    fixed` atmospheric layers plus a `position: sticky` showcase stage. Enabling
    it pushed the whole page down behind an empty band and detached the nav.
    That is a visible regression on a page that is supposed to be untouched, to
    buy an easing curve.

    ScrollTrigger does not need it. `self.progress` is computed from the
    element's own position in the viewport, so the journey runs identically on
    native scroll; only the easing feel is lost. `useSmoothScroll` is still
    exported and still correct — it belongs on a page built for it, not
    retrofitted under one that is not.
  */
  const journeyOn = quality.canvas && !reduced;
  useJourneyProgress(page, journeyOn);

  useEffect(() => {
    document.title = "AUCTIQ · IPL 2026 Mega Auction";
  }, []);

  /*
    `overflow-x-clip` below, NOT `overflow-x-hidden`.

    Both stop the scattered showcase cards causing a horizontal scrollbar, but
    `hidden` makes this element a scroll container — and `position: sticky`
    anchors to its nearest scroll container, not the viewport. With `hidden`
    here the showcase's sticky stage scrolled away with its section and the
    cards rendered 600px above the fold, which looked like an empty page.
    `clip` clips without establishing a scroll container, so sticky keeps
    working.
  */
  return (
    <div ref={page} className="auctiq relative min-h-screen overflow-x-clip">
      {/*
        Fixed atmospheric layers, behind everything and ignoring the pointer.
        Fixed rather than scrolled so they read as the room the content is in,
        not as a texture printed on it.
      */}
      {/* The photograph goes underneath the gradient pools, not instead of
          them: the pools are what tie the page's blue and gold to the arc's
          own light, and they still do that job over a picture. */}
      <StadiumBackdrop live3d />
      <div className="auctiq-stadium" aria-hidden />
      <div className="auctiq-grid" aria-hidden />

      {/* The mark is part of the header bar now — AuctiqNav renders it with
          `inline`, so mounting it separately here would put two of them on the
          page, one in the bar and one floating in the opposite corner. */}
      {/* The pointer, as a cricket ball. Landing only — a ball bouncing over
          a live auction grid during bidding would be a distraction. */}
      <CricketCursor />

      <AuctiqNav />

      {/*
        The mockup's front page.

        `HeroSection` used to sit directly below this one and is now unmounted —
        unmounted, not deleted. It carries a revolving trophy and a headline of
        its own, so with BroadcastHero above it the landing ran the same trophy
        animation twice: once centre-left where the mockup puts it, and again a
        screen further down. Two WebGL canvases showing the same object is not a
        second section, it is the same section twice.

        The file is untouched at components/Sections/HeroSection.tsx and nothing
        else in the app imports it, so bringing it back is this import and one
        line. Its copy — the 284/10/₹120Cr figures — has no home on this page;
        its two calls to action are covered by the JOIN NOW controls in the
        header and the footer, both of which reach the auction room.
      */}
      <BroadcastHero />
      <PlayerShowcase />

      <AuctiqFooter />
    </div>
  );
}
