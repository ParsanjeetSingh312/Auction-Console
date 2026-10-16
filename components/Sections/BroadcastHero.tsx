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
import { Fragment, Suspense, lazy, useLayoutEffect, useRef } from "react";

import { createTimeline, stagger, utils } from "animejs";
import gsap from "gsap";

import { AuctiqMark } from "../Global/AuctiqLogo";
import { useHandoffPhase } from "../Intro/ballHandoff";
// Superseded in place by the war-room trigger. `LiveBiddingCard` is kept on
// disk and unmounted; restoring it is this import and the line below.
import WarRoomTrigger from "../WarRoom/WarRoomTrigger";
// Trending Players was removed so the war room can take the whole column.
// `TrendingPlayersCard` is kept on disk and unmounted; restoring it is its
// import and a line in the panel stack below.
// Removed from the hero after deployment. `UpcomingAuctionsCard` is kept on
// disk and unmounted; restoring it is its import and a line in the panel stack.

/**
 * Lazy for the same reason the previous hero loads it lazily: three + fiber +
 * drei is ~880KB as its own chunk, and the headline and the panels have no
 * business waiting on a 3D scene to become readable.
 */
// The AUCTONIQ trophy (ball, cradle and gavel) in place of the chalice.
// `TrophyCanvas` is kept on disk: swapping back is this import and the JSX below.
const AuctoniqTrophy = lazy(() => import("../3D/AuctoniqTrophy"));

const WORD = "AUCTONIQ".split("");
const TAGLINE = ["Where", "intelligence", "meets", "patience"];

/**
 * The wordmark's flash, and the tagline answering it.
 *
 * One pass of light crosses AUCTONIQ; as it leaves the last letter a second
 * pass runs along the tagline, the gold under it brightens and the rules
 * either side stretch out and settle. Then the pair rests for a few seconds
 * and does it again, so the line under the name is never a static caption.
 * Returns the timeline so the caller can kill it.
 */
function flashLoop(root: HTMLElement, delay: number): gsap.core.Timeline | null {
  const band = root.querySelector<HTMLElement>(".wordmark-sheen");
  const sheen = root.querySelector<HTMLElement>(".hero-tagline-sheen");
  const line = root.querySelector<HTMLElement>(".hero-tagline");
  const rules = root.querySelectorAll<HTMLElement>(".hero-tagline-rule");
  if (!band || !sheen || !line) return null;
  const rest = "drop-shadow(0 0 1px rgba(0,0,0,0.9)) drop-shadow(0 0 10px rgba(246,196,90,0.28))";
  const lit = "drop-shadow(0 0 1px rgba(0,0,0,0.9)) drop-shadow(0 0 18px rgba(255,214,120,0.75))";
  return gsap
    .timeline({ repeat: -1, repeatDelay: 5.2, delay })
    .fromTo(band, { backgroundPosition: "150% 0%" }, { backgroundPosition: "-50% 0%", duration: 1.1, ease: "sine.inOut" }, 0)
    .fromTo(sheen, { backgroundPosition: "150% 0%" }, { backgroundPosition: "-50% 0%", duration: 1.0, ease: "sine.inOut" }, 0.7)
    .fromTo(line, { filter: rest }, { filter: lit, duration: 0.45, ease: "power2.out", yoyo: true, repeat: 1 }, 0.75)
    .fromTo(line, { letterSpacing: "0.24em" }, { letterSpacing: "0.27em", duration: 0.45, ease: "power2.out", yoyo: true, repeat: 1 }, 0.75)
    .fromTo(rules, { scaleX: 1, opacity: 0.85 }, { scaleX: 1.45, opacity: 1, duration: 0.45, ease: "power3.out", yoyo: true, repeat: 1 }, 0.75);
}

export default function BroadcastHero() {
  /*
    The delivery opening ends by dropping its match ball into this trophy's
    cradle. Until it lands the wordmark and tagline are held back, so the
    ball falls through clear sky; then they come in, the letters rising the
    way they do on the gate. With no opening pending (a returning visitor,
    the strike opening) the phase never holds and nothing here changes.
  */
  const phase = useHandoffPhase();
  const holding = phase === "awaiting" || phase === "falling";
  const columnRef = useRef<HTMLDivElement>(null);
  const wordRef = useRef<HTMLHeadingElement>(null);
  const taglineRef = useRef<HTMLDivElement>(null);
  const wasHolding = useRef(holding);
  useLayoutEffect(() => {
    if (holding) {
      wasHolding.current = true;
      return;
    }
    // Reduced motion: the readable final state, at once, and no loop.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const column = columnRef.current;
    if (!column || !wordRef.current || !taglineRef.current) return;
    if (!wasHolding.current) {
      // No opening to wait for (a returning visitor): the flash starts soon
      // after the page settles, then repeats.
      const loop = flashLoop(column, 1.6);
      return () => {
        loop?.kill();
      };
    }
    wasHolding.current = false;
    const letters = wordRef.current.querySelectorAll(".hero-letter");
    const band = wordRef.current.parentElement?.querySelector(".wordmark-sheen");
    const words = taglineRef.current.querySelectorAll(".hero-tagline > .hero-tagline-word");
    const rules = taglineRef.current.querySelectorAll(".hero-tagline-rule");
    const sheen = taglineRef.current.querySelector(".hero-tagline-sheen");
    // Hidden from the first paint, not from whenever each tween starts.
    utils.set(letters, { opacity: 0 });
    utils.set(words, { opacity: 0 });
    utils.set(rules, { scaleX: 0 });
    // One thing at a time: the ball settles into the cradle first (about half
    // a second), then the name rises over it from the middle out, coming into
    // focus; one pass of light crosses it; then the line under it, word by
    // word.
    const tl = createTimeline({ defaults: { ease: "outExpo" } })
      .add(
        letters,
        {
          translateY: ["105%", "0%"],
          rotateX: [-80, 0],
          opacity: [0, 1],
          filter: ["blur(10px)", "blur(0px)"],
          duration: 1050,
          delay: stagger(50, { from: "center" }),
        },
        550,
      )
      .add(wordRef.current, { letterSpacing: ["0.3em", "0.06em"], duration: 1400 }, 550)
      .add(
        words,
        { translateY: [14, 0], opacity: [0, 1], filter: ["blur(6px)", "blur(0px)"], duration: 800, ease: "outQuart", delay: stagger(90) },
        1300,
      )
      .add(rules, { scaleX: [0, 1], duration: 900, ease: "outExpo" }, 1500);
    // After every letter has landed, so the copy lines up with the word; the
    // tagline catches the same light as it leaves the last letter.
    if (band) tl.add(band, { backgroundPosition: ["150% 0%", "-50% 0%"], duration: 1100, ease: "inOutSine" }, 2050);
    if (sheen) tl.add(sheen, { backgroundPosition: ["150% 0%", "-50% 0%"], duration: 1000, ease: "inOutSine" }, 2750);
    // Then the same flash on a loop, the first repeat a few seconds later.
    const loop = flashLoop(column, 9);
    return () => {
      tl.complete();
      loop?.kill();
    };
  }, [holding]);

  return (
    <section
      aria-label="IPL Auction 2026"
      className="relative z-10 mx-auto flex min-h-[100svh] w-full max-w-[1400px] flex-col gap-8 px-5 pb-10 pt-[150px] sm:px-8 sm:pt-[120px] lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(400px,42%)] lg:items-center lg:gap-12"
    >
      {/*
        Left column — the wordmark, and the trophy beneath it.

        One piece of type and one object. With the headline and the caption both
        gone the column has no competing focal points left, so the trophy takes
        the height it was previously sharing and the word above it does the
        naming. Centred rather than left-aligned because a single word over a
        centred object reads as a mark; ranged left it reads as a stray label.
      */}
      <div ref={columnRef} className="auctiq-stagger flex min-w-0 flex-col items-center justify-center">
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
        <div className="relative">
          <h1
            ref={wordRef}
            aria-label="AUCTONIQ"
            className="font-auctiq text-[clamp(2.75rem,7.5vw,6rem)] uppercase leading-none tracking-[0.06em] text-neon-orange text-glow-orange [perspective:700px]"
            style={holding ? { visibility: "hidden" } : undefined}
          >
            {WORD.map((ch, i) => (
              <span key={i} aria-hidden className="hero-letter inline-block origin-bottom">
                {ch}
              </span>
            ))}
          </h1>
          {/* A pass of light across the word as it lands (stadiumIntro.css). */}
          <span
            aria-hidden
            className="wordmark-sheen font-auctiq text-[clamp(2.75rem,7.5vw,6rem)] uppercase leading-none tracking-[0.06em]"
          >
            AUCTONIQ
          </span>
        </div>

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
          <AuctoniqTrophy
            className="trophy-stage--hero auctiq-no-lift"
            fallback={<TrophyFallback />}
            receivesBall
          />
        </Suspense>

        {/*
          The tagline, answering the wordmark.

          Gold rather than the cyan it used to be: the gold of the trophy it
          now sits under, graded from champagne at the cap height to amber at
          the baseline, so it reads as struck metal next to the orange neon of
          the name. Rajdhani Bold — squared, condensed, sporty — in place of
          Chakra Petch, larger and tracked a little tighter so it holds as one
          bold line instead of a whisper of letters.

          Pulled up under the plinth with a negative top margin: the trophy's
          canvas leaves a band of empty scene below the model, which is what
          left the line stranded at the foot of the hero.

          The words are spans of their own so they can rise in one at a time,
          and the gradient sits on each word (it is vertical, so every word
          gets the identical grade). A copy on top carries the moving band of
          light, the same trick as the wordmark's sheen. Screen readers get one
          plain sentence from the sr-only span.
        */}
        <div
          ref={taglineRef}
          className="relative z-10 -mt-[clamp(3rem,8.5vh,5.75rem)] mb-[clamp(3rem,8.5vh,5.75rem)] flex items-center justify-center gap-4 sm:gap-5"
          style={holding ? { visibility: "hidden" } : undefined}
        >
          <span aria-hidden className="hero-tagline-rule hero-tagline-rule--l hidden sm:block" />
          <p className="hero-tagline relative">
            <span className="sr-only">Where intelligence meets patience</span>
            {TAGLINE.map((word, i) => (
              <Fragment key={word}>
                {i > 0 && " "}
                <span aria-hidden className="hero-tagline-word">
                  {word}
                </span>
              </Fragment>
            ))}
            {/* One run of plain text, so the band clips to every glyph at once. */}
            <span aria-hidden className="hero-tagline-sheen">
              {TAGLINE.join(" ")}
            </span>
          </p>
          <span aria-hidden className="hero-tagline-rule hero-tagline-rule--r hidden sm:block" />
        </div>
      </div>

      {/* Right column — the panel stack, and nothing else. */}
      {/*
        The panels arrive after the left column rather than alongside it. The
        wordmark and the trophy are what the page is; the panels are what it is
        currently doing, and a reader who meets all six at once has no idea which
        to look at first.
      */}
      <div className="auctiq-stagger flex flex-col [&>*:nth-child(1)]:[animation-delay:0.30s]">
        <WarRoomTrigger />
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
