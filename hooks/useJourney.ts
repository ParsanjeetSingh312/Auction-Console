/**
 * useJourney.ts
 * How far the camera has travelled into the stadium, as one number.
 *
 * The landing is a scroll-linked camera move: the arena wakes up, the camera
 * descends to the trophy, then to the turf, and the auction interface takes
 * over. Every piece of that reads the same normalised `0 -> 1` progress value.
 *
 * **Progress is deliberately NOT React state.** A scroll-linked camera updates
 * on every frame. Routing that through `useState` would re-render the tree
 * sixty times a second to move an object React does not own — three.js owns the
 * scene graph, and the rig mutates it directly inside `useFrame`. So this is a
 * plain mutable module object that the rig reads and React never hears about.
 * That is the single most important performance decision in the 3D layer.
 *
 * **Two hooks, deliberately separate.**
 *
 *   `useSmoothScroll` owns Lenis and its ticker wiring. Mount it once, high up.
 *   `useJourneyProgress` owns the ScrollTrigger. Mount it in the component that
 *   renders the scroll track, passing a real ref.
 *
 * That split is not tidiness, it is a bug that has already been paid for once.
 * The prototype's first version created the trigger in the shell, targeting the
 * track by CSS selector. GSAP could not resolve an element a child route owned,
 * so progress stayed pinned at zero and the camera never moved while the page
 * scrolled — with no error anywhere. **Whoever owns the element owns its
 * trigger**, and a ref proves the element exists at the moment the trigger is
 * built in a way a selector never can.
 *
 * **Why Lenis rather than native scroll.** Two reasons, and only one is feel.
 *
 *   The feel: a long, shallow easing curve keeps the page gliding after the
 *   wheel stops, which is what makes a camera move read as a camera move rather
 *   than a series of steps.
 *
 *   The structural one: once Lenis is installed it *owns* the scroll position.
 *   Progress becomes `lenis.scroll / lenis.limit`, not `window.scrollY`, and
 *   driving `window.scrollTo` desynchronises the two. Measured on the
 *   prototype: seeking to native 1382px rendered a black frame while 1920px
 *   rendered the pitch — non-monotonic, and baffling until you know which clock
 *   is authoritative. Anything that needs to move the page programmatically
 *   must go through `getLenis()`.
 */
import { useEffect, type RefObject } from "react";

import Lenis from "lenis";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/**
 * The shared progress value. Mutable on purpose — see the note above.
 *
 * Read it inside `useFrame`; never put it in a dependency array, because
 * mutating it does not notify React and never will.
 */
export const journey = { progress: 0 };

/**
 * Where each act of the landing ends, as a fraction of the scroll track.
 *
 * Measured against the running prototype rather than chosen: seeking to each
 * of these values lands exactly on the frame the act is named for.
 *
 *   0.00 - 0.15  HERO     floodlights ramp on, haze thickens, the logo recedes
 *   0.15 - 0.32  TROPHY   the camera descends and orbits the trophy
 *   0.32 - 0.48  PITCH    down to turf level, the console panels assemble
 *   0.48 - 1.00  HANDOFF  the 3D journey is over; routes take over
 *
 * Note how early it finishes. The entire 3D sequence is the first 48% of the
 * track — roughly 1,380px of a 2,880px range at a 900px viewport. Spreading it
 * across the full range would halve its pace and is the most likely way for a
 * port of this to feel wrong while every individual beat looks right.
 */
export const BEATS = {
  heroEnd: 0.15,
  trophyEnd: 0.32,
  pitchEnd: 0.48,
} as const;

/**
 * Map global progress onto one beat's local `0 -> 1`, clamped at both ends.
 *
 * Every animated element works in its own beat's local time, so a beat can be
 * retimed in `BEATS` without touching the thing it animates.
 */
export function beat(progress: number, start: number, end: number): number {
  if (end <= start) return 0;
  return Math.min(1, Math.max(0, (progress - start) / (end - start)));
}

let lenis: Lenis | null = null;

/**
 * The live Lenis instance, or null when smooth scroll is not mounted.
 *
 * Use this for any programmatic scroll on a page running the journey:
 * `getLenis()?.scrollTo(y)`. A bare `window.scrollTo` will move the page
 * without moving progress.
 */
export function getLenis(): Lenis | null {
  return lenis;
}

/**
 * App-level smooth scrolling. Mount once, from the page that owns the journey.
 *
 * Pass `enabled: false` for reduced motion or a tier-1 device — the page then
 * scrolls natively, which is the correct outcome rather than a degraded one.
 */
export function useSmoothScroll(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    lenis = new Lenis({
      duration: 1.1,
      // Long, shallow curve: the page keeps gliding after the wheel stops.
      easing: (t: number) => Math.min(1, 1.001 - 2 ** (-10 * t)),
      wheelMultiplier: 0.9,
      touchMultiplier: 1.4,
    });

    const onScroll = () => ScrollTrigger.update();
    lenis.on("scroll", onScroll);

    // Drive Lenis from GSAP's ticker rather than its own requestAnimationFrame,
    // so scroll position and every timeline advance on the same frame. Two RAF
    // loops means the camera is reading last frame's scroll: it tears.
    const tick = (time: number) => lenis?.raf(time * 1000);
    gsap.ticker.add(tick);
    // GSAP pauses its ticker after a long frame to avoid a catch-up jump. That
    // is right for a timeline and wrong for a scroll driver, which would stall.
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(tick);
      lenis?.destroy();
      lenis = null;
    };
  }, [enabled]);
}

/**
 * Bind a scroll track element to the shared progress value.
 *
 * Call this from the component that renders the track, with its own ref. The
 * track is an ordinary tall element; its height is what sets the pace of the
 * whole journey.
 */
export function useJourneyProgress(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) {
      journey.progress = 0;
      return;
    }

    const trigger = ScrollTrigger.create({
      trigger: element,
      start: "top top",
      end: "bottom bottom",
      scrub: true,
      onUpdate: (self) => {
        journey.progress = self.progress;
      },
    });

    // Fonts and the canvas settle after first paint, which changes the measured
    // track length. Without this the journey is timed against a layout that no
    // longer exists and the last beat never quite arrives.
    ScrollTrigger.refresh();

    return () => {
      trigger.kill();
      journey.progress = 0;
    };
  }, [ref, enabled]);
}
