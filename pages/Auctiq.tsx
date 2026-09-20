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
import { useEffect } from "react";
import { useReducedMotion } from "framer-motion";

import AuctiqLogo from "../components/Global/AuctiqLogo";
import AuctiqNav from "../components/Global/AuctiqNav";
import HeroSection from "../components/Sections/HeroSection";
import PlayerShowcase from "../components/Sections/PlayerShowcase";

export default function Auctiq() {
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
    <div className="auctiq relative min-h-screen overflow-x-clip">
      {/*
        Fixed atmospheric layers, behind everything and ignoring the pointer.
        Fixed rather than scrolled so they read as the room the content is in,
        not as a texture printed on it.
      */}
      <div className="auctiq-stadium" aria-hidden />
      <div className="auctiq-grid" aria-hidden />

      <AuctiqLogo to="/" />
      <AuctiqNav />

      <HeroSection />
      <PlayerShowcase />

      {/*
        The four destinations used to live here. They are the top nav now, and
        that nav is fixed — so it is still on screen at this point in the page
        and repeating it below would be four links to nowhere new. What the
        bottom of a 400vh page actually needs is a way back up.
      */}
      <footer className="relative z-10 border-t border-white/[0.07] px-5 py-8 sm:px-8">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4">
          <span className="font-tech text-[10px] uppercase tracking-[0.2em] text-auctiq-dim">
            AUCTIQ · IPL 2026
          </span>
          <BackToTop />
        </div>
      </footer>
    </div>
  );
}

/**
 * Scrolls home. A button rather than an `<a href="#top">`, because the anchor
 * would leave `#top` in the address bar and a reload would then land mid-page.
 *
 * `behavior` is read from the platform setting rather than hard-coded to
 * "smooth": smooth-scrolling four viewports is precisely the motion that
 * triggers vestibular symptoms, and an instant jump is the correct answer
 * there, not a slower animation.
 */
function BackToTop() {
  const reduced = useReducedMotion();

  const goTop = () => {
    if (reduced) {
      window.scrollTo({ top: 0, behavior: "auto" });
      return;
    }

    const from = window.scrollY;
    window.scrollTo({ top: 0, behavior: "smooth" });

    /*
      Some engines accept `behavior: "smooth"` and then quietly do nothing —
      embedded and headless Chrome among them, and anything with scroll
      animations disabled. `"scrollBehavior" in style` is true on all of them,
      so there is no feature test; the only reliable check is whether the page
      actually moved. A real smooth scroll is underway within a frame, so if
      the offset is untouched a beat later it never started, and a control
      whose entire job is to scroll has to fall back rather than sit dead.
    */
    window.setTimeout(() => {
      if (window.scrollY === from && from > 0) {
        window.scrollTo({ top: 0, behavior: "auto" });
      }
    }, 400);
  };

  return (
    <button
      type="button"
      onClick={goTop}
      className="group flex min-h-[44px] items-center gap-2 rounded-full px-3 font-tech text-[11px] uppercase tracking-[0.16em] text-auctiq-dim transition-colors duration-200 hover:text-auctiq-gold"
    >
      Back to top
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="transition-transform duration-200 group-hover:-translate-y-0.5"
        aria-hidden
      >
        <path d="m18 15-6-6-6 6" />
      </svg>
    </button>
  );
}
