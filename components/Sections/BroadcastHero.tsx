/**
 * BroadcastHero.tsx
 * The landing's front page, laid out from the reference mockup.
 *
 * Two columns on a wide screen and one on a narrow one. The panels occupy
 * roughly the right third, as the mockup has them, and are right-hand only —
 * nothing in that column ever crosses into the left.
 *
 * The left column carries the AUCTIQ wordmark and the trophy beneath it, both
 * centred. It previously also held the mockup's two-line headline and a caption
 * under the trophy; both were removed at Parsanjeet's direction, and the trophy
 * grew into the room they left. That is the whole reason it is now sized in
 * 52vh rather than 28vh — with three things stacked in this column it could not
 * have that height without pushing the wordmark off a short viewport.
 *
 * `min-h-[100svh]` rather than `100vh`. On mobile browsers `vh` is measured
 * against the viewport with the address bar hidden, so a `100vh` hero is taller
 * than the screen on first paint and the bottom of the headline sits under the
 * chrome until you scroll. `svh` is the small viewport height — what is
 * actually visible — which is the correct unit for a hero that must fit.
 *
 * **On running a second trophy.** The previous hero lives on below this one and
 * has a trophy of its own, so the page now mounts two WebGL canvases. That is
 * safe here only because `TrophyCanvas` already guards it: an
 * IntersectionObserver flips `frameloop` to "never" whenever a canvas leaves
 * the viewport, so the one that is off screen costs nothing per frame. The
 * three.js bundle is a single shared chunk, so it is also downloaded once.
 *
 * All three panels are real components now — the placeholder shell and its
 * slot markers are gone. The container and its `gap-3` are the same ones the
 * shell established, so nothing moved when the contents landed.
 */
import { Suspense, lazy } from "react";

import { AuctiqMark } from "../Global/AuctiqLogo";
// Superseded in place by the war-room trigger. `LiveBiddingCard` is kept on
// disk and unmounted; restoring it is this import and the line below.
import WarRoomTrigger from "../WarRoom/WarRoomTrigger";
import TrendingPlayersCard from "../UI/TrendingPlayersCard";
import UpcomingAuctionsCard from "../UI/UpcomingAuctionsCard";

/**
 * Lazy for the same reason the previous hero loads it lazily: three + fiber +
 * drei is ~880KB as its own chunk, and the headline and the panels have no
 * business waiting on a 3D scene to become readable.
 */
const TrophyCanvas = lazy(() => import("../3D/TrophyCanvas"));

export default function BroadcastHero() {
  return (
    <section
      aria-label="IPL Auction 2026"
      className="relative z-10 mx-auto flex min-h-[100svh] w-full max-w-[1400px] flex-col gap-8 px-5 pb-10 pt-[150px] sm:px-8 sm:pt-[120px] lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,34%)] lg:items-stretch lg:gap-10"
    >
      {/*
        Left column — the wordmark, and the trophy beneath it.

        One piece of type and one object. With the headline and the caption both
        gone the column has no competing focal points left, so the trophy takes
        the height it was previously sharing and the word above it does the
        naming. Centred rather than left-aligned because a single word over a
        centred object reads as a mark; ranged left it reads as a stray label.
      */}
      <div className="auctiq-stagger flex min-w-0 flex-col items-center justify-center">
        {/*
          Russo One, the same face the showcase sets "EVERY NAME HAS A PRICE"
          in, so the landing has one display voice rather than a different one
          per section.

          No weight class. Russo One ships a single cut at 400, so `font-bold`
          would not select a bolder face — it would ask the browser to
          synthesise one by smearing the outlines, which on a squared geometric
          face at 96px is plainly visible. Its 0.06em tracking is looser than
          the showcase heading's 0.02em because this is one word standing alone
          rather than a line of them.
        */}
        <h1 className="font-auctiq text-[clamp(2.75rem,7.5vw,6rem)] uppercase leading-none tracking-[0.06em] text-neon-orange text-glow-orange">
          AUCTIQ
        </h1>

        {/*
          A negative TOP margin only.

          The rendered trophy does not fill its canvas: the camera leaves a band
          of empty scene above the model, so spacing the wordmark off the box
          leaves it visibly detached from the object it names. Pulling the box up
          closes that gap.

          The first attempt used `-my`, which also pulled the bottom in — and the
          model sits low in frame, close to the canvas floor, so the tagline
          landed on top of the plinth. There is empty scene above the trophy to
          reclaim and almost none below it, which is why the correction is
          asymmetric rather than a smaller symmetric value.
        */}
        <Suspense fallback={<TrophyFallback />}>
          <TrophyCanvas
            className="auctiq-no-lift -mt-8 h-[clamp(340px,60vh,700px)] w-full max-w-[640px] sm:-mt-12"
            fallback={<TrophyFallback />}
          />
        </Suspense>

        {/*
          Cyan against the orange above it and the navy behind it. On the
          #020617 ground it measures 11.16:1 — the highest-contrast token on
          this surface — and it is the complement of the wordmark's orange, so
          the pair reads as deliberate rather than as two accent colours that
          happened to land together.

          Set in Chakra Petch, which is Russo One's companion everywhere else on
          this page: the showcase runs exactly this pairing under its own
          heading. A display face carrying its own caption reads as a logo with
          a subtitle welded on.

          `uppercase` as a class rather than capitals in the string, so a screen
          reader gets a sentence instead of six initialisms.
        */}
        <p className="mt-1 text-center font-tech text-[clamp(0.7rem,1.5vw,0.95rem)] font-medium uppercase tracking-[0.34em] text-neon-cyan">
          Where intelligence meets patience
        </p>
      </div>

      {/* Right column — the panel stack, and nothing else. */}
      {/*
        The panels arrive after the left column rather than alongside it. The
        wordmark and the trophy are what the page is; the panels are what it is
        currently doing, and a reader who meets all six at once has no idea which
        to look at first.
      */}
      <div className="auctiq-stagger flex flex-col gap-3 [&>*:nth-child(1)]:[animation-delay:0.30s] [&>*:nth-child(2)]:[animation-delay:0.41s] [&>*:nth-child(3)]:[animation-delay:0.52s]">
        <WarRoomTrigger />
        <TrendingPlayersCard />
        <UpcomingAuctionsCard />
      </div>
    </section>
  );
}

/**
 * Shown while the 3D chunk is in flight, and permanently on a machine without
 * WebGL. The logo mark at size rather than a spinner — the chunk usually
 * arrives within a frame or two, and a spinner that flashes for 80ms reads as a
 * fault where a large gold mark just reads as quieter.
 */
function TrophyFallback() {
  return (
    <div className="grid h-[clamp(300px,52vh,620px)] w-full place-items-center">
      <AuctiqMark className="h-28 w-28 opacity-70" />
    </div>
  );
}
