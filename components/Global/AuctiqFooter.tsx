/**
 * AuctiqFooter.tsx
 * The bar at the foot of the landing.
 *
 * Laid out from the reference: attribution and copyright on the left, social
 * glyphs and a call to action on the right. Two things are here that the
 * reference does not show, and both are deliberate.
 *
 * **Back to top stays.** It was in the previous footer and the reference has no
 * equivalent, but the reference is a picture of one screen and this page is four
 * viewports tall. Dropping it would leave the only route back to the navigation
 * a manual scroll through the whole showcase. It has moved into this file rather
 * than being rewritten — the fallback logic below is the original, including its
 * reason for existing.
 *
 * **The disclaimer.** The reference's copyright line is generated nonsense
 * ("© 2022 Pexdioizon Auctions, Bladiann, Inc."), so it needed replacing with
 * something true either way. What replaces it says plainly that this is an
 * independent project, because the page uses the league's name, its franchises
 * and real players' names throughout. That line is a judgement call rather than
 * a requirement — delete it if you would rather it were not there.
 */
import { Link } from "react-router-dom";
import { useReducedMotion } from "framer-motion";

import SocialRow from "./SocialRow";

export default function AuctiqFooter() {
  return (
    <footer className="relative z-10 border-t border-white/[0.07] bg-auctiq-void/70 px-5 py-6 sm:px-8">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-tech text-[12px] text-auctiq-dim">
            powered by{" "}
            <span className="font-auctiq tracking-[0.12em] text-neon-cyan">
              AUCTIQ
            </span>
          </p>
          <p className="mt-1 max-w-[46ch] font-tech text-[10px] leading-relaxed text-auctiq-dim/60">
            © 2026 AUCTIQ. An independent project — not affiliated with the BCCI
            or the Indian Premier League.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SocialRow />

          {/*
            Outlined in white here rather than the header's cyan. The header's
            control is the page's primary action and should be the brightest
            thing in that row; a second identical button four viewports down
            competing at the same strength just makes the first one quieter.
          */}
          <Link
            to="/auction"
            className="flex min-h-[38px] items-center whitespace-nowrap rounded-[6px] border border-white/25 px-4 font-tech text-[11px] font-semibold uppercase tracking-[0.14em] text-auctiq-text transition-colors duration-200 hover:border-white/50 hover:bg-white/[0.06]"
          >
            Join now
          </Link>

          <BackToTop />
        </div>
      </div>
    </footer>
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
      className="group flex min-h-[38px] items-center gap-2 rounded-[6px] px-3 font-tech text-[11px] uppercase tracking-[0.14em] text-auctiq-dim transition-colors duration-200 hover:text-auctiq-gold"
    >
      Top
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
