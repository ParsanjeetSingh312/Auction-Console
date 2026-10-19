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
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import { useSmoothScroll } from "../hooks/useJourney";

// The opening runs on the refined copy of the Intro modules (detailed crowd,
// turf, boards, floodlights, depth of field and grade) built at /lab/prototype.
// The original modules are untouched in components/Intro: switching back is
// this import and the stylesheet below.
import StadiumIntro from "../components/Prototype/intro/StadiumIntro";
import AuctiqFooter from "../components/Global/AuctiqFooter";
import AuctiqNav from "../components/Global/AuctiqNav";
import BroadcastHero from "../components/Sections/BroadcastHero";
import StadiumBackdrop from "../components/Sections/StadiumBackdrop";
// The player-select showcase, in place of the scattered deck. `PlayerShowcase`
// is kept on disk and unmounted: restoring it is this import and one line below.
import PlayerSelect from "../components/UI/PlayerSelect";
import { SHOWCASE_PLAYERS } from "../utils/players";
import { PLAYER_STATS } from "../utils/playerStats";
// The landing's refined finish, scoped to `.proto` on the wrapper below.
import "../components/Prototype/protoLanding.css";

/** Set once the opening has played, so it greets a visitor once per session. */
const INTRO_SEEN = "auctoniq:intro-seen";

/** `?intro=1` always plays the opening; otherwise once per browser session. */
function introAlreadySeen(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("intro") === "1") return false;
    return window.sessionStorage.getItem(INTRO_SEEN) === "1";
  } catch {
    return false;
  }
}

/**
 * The landing's sections, memoised. They take no props, so the opening's
 * handoff (`landed` flipping in `Auctiq`) never re-renders them: before this
 * the whole page, the player showcase included, re-rendered on the very
 * frame the stadium handed over, and that frame stalled.
 */
const LandingSections = memo(function LandingSections() {
  return (
    <>
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
      <PlayerSelect players={SHOWCASE_PLAYERS} stats={PLAYER_STATS} />
      <AuctiqFooter />
    </>
  );
});

export interface AuctiqProps {
  /**
   * Which opening greets a first visit: "delivery" (the default: the ball
   * launched from the far crease, PRESENTING TO YOU, the pitch and the
   * stumps, the climb past the floodlights and the ball dropped onto the top
   * of the hero trophy) or "strike" (the earlier opening: the ball into the
   * stumps from off screen). Switching back is this default.
   */
  opening?: "strike" | "delivery";
  /** Play the opening on every visit and never mark it seen. For the lab. */
  alwaysPlay?: boolean;
}

export default function Auctiq({ opening = "delivery", alwaysPlay = false }: AuctiqProps = {}) {
  const page = useRef<HTMLDivElement>(null);

  /*
    The stadium opening, then the landing on top of the same stadium.

    A first visit this session gets the black "Enter the auction" screen and
    the film, which runs from the broken stumps straight into the site: the
    landing starts fading in while the camera is still craning out, and the
    stadium freezes into a still behind it once the camera comes to rest.
    The film lands no wordmark or trophy of its own here — the hero has them.
    A returning visitor gets that still straight away. Frozen, the stadium
    draws nothing per frame, which is why it can sit behind a scrolling page
    where the old live arena made scrolling lag.

    The landing mounts at once, invisible and inert under the black gate, so
    its start-up work (the hero trophy's WebGL context, the showcase) is done
    while the visitor is still reading the button. Mounting it at the handoff
    instead stalled the crane for half a second on a laptop GPU. The handoff
    is then only a fade.
  */
  const [seen] = useState(() => !alwaysPlay && introAlreadySeen());
  const [landed, setLanded] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  // `inert` until the handoff: hidden content must not take focus or clicks.
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    if (landed) el.removeAttribute("inert");
    else el.setAttribute("inert", "");
  }, [landed]);
  const handOff = useCallback(() => {
    try {
      if (!alwaysPlay) window.sessionStorage.setItem(INTRO_SEEN, "1");
    } catch {
      /* private mode: the opening simply plays again next time */
    }
    setLanded(true);
  }, [alwaysPlay]);

  /*
    Smooth scrolling: Lenis, driven from GSAP's ticker (see useSmoothScroll),
    so every ScrollTrigger on the page — the Trending Players deal above all —
    reads the same eased scroll position on the same frame instead of jumping
    a notch at a time with the mouse wheel. Off until the opening hands over
    (the gate is not scrollable) and off for reduced motion, where native
    scrolling is the correct behaviour rather than a degraded one.
  */
  const reduced = useReducedMotion() ?? false;
  useSmoothScroll(landed && !reduced);
  useEffect(() => {
    // The page grows to its real height at the handoff; re-measure the triggers.
    if (landed) ScrollTrigger.refresh();
  }, [landed]);

  /*
    No scroll journey on this page any more. The 3D arena that took over from
    the photograph as the page scrolled -- its camera descent and the ball's
    delivery -- made scrolling lag, so the landing keeps the hero's stadium
    lights as a still, fixed backdrop the whole way down. The arena itself is
    untouched and still runs on /stadium; restoring it here is `live3d` on the
    backdrop below plus `useJourneyProgress(page, quality.canvas && !reduced)`.
  */

  useEffect(() => {
    document.title = "AUCTONIQ · IPL 2026 Mega Auction";
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
    <div ref={page} className="auctiq proto relative min-h-screen overflow-x-clip">
      {/*
        Fixed atmospheric layers, behind everything and ignoring the pointer.
        Fixed rather than scrolled so they read as the room the content is in,
        not as a texture printed on it.
      */}
      {/* The photograph goes underneath the gradient pools, not instead of
          them: the pools are what tie the page's blue and gold to the arc's
          own light, and they still do that job over a picture. Static: no
          `live3d`, so it never hands over to the 3D arena (see above). */}
      <StadiumBackdrop />
      {/* The rendered stadium over the photograph, which stays underneath as
          the fallback for a machine without WebGL. Above everything while the
          opening plays; behind everything, frozen, once the landing is up. */}
      <StadiumIntro
        instant={seen}
        backdrop={landed}
        mark={false}
        opening={opening}
        onComplete={handOff}
        className={landed ? "!fixed inset-0 z-0 pointer-events-none" : "!fixed inset-0 z-[200]"}
      />
      <div className="auctiq-stadium" aria-hidden />
      <div className="auctiq-grid" aria-hidden />
      {/* Film grain over the whole page, so the landing is shot on the same
          stock as the film it comes out of. */}
      <div className="proto-grain" aria-hidden />

      <div
        ref={content}
        aria-hidden={!landed || undefined}
        style={{ opacity: landed ? 1 : 0.001, willChange: "opacity", transition: "opacity 1.1s cubic-bezier(0.22, 1, 0.36, 1)" }}
      >

      {/* The mark is part of the header bar now — AuctiqNav renders it with
          `inline`, so mounting it separately here would put two of them on the
          page, one in the bar and one floating in the opposite corner. */}
          {/* The red-ball pointer is mounted once for the whole app in App.tsx. */}

          <LandingSections />

      </div>
    </div>
  );
}
