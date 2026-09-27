/**
 * StadiumBackdrop.tsx
 * The photographed stadium, behind everything on the landing.
 *
 * Fixed rather than scrolled, and fixed by position rather than by
 * `background-attachment: fixed`. The CSS property is the obvious way to do
 * this and the wrong one: iOS Safari has never implemented it against the
 * visual viewport, so it stutters or detaches entirely during momentum
 * scrolling, and on other engines it forces a repaint of the whole layer on
 * every frame. A `position: fixed` element is composited once and costs
 * nothing to scroll past. It is also what `.auctiq-stadium` already does, so
 * the two layers behave identically.
 *
 * **On the source image.** It is 384x672 and 21KB — small. A 1920px viewport
 * asks it to scale five times, which no amount of care makes sharp. So the
 * blur is not a stylistic flourish, it is the honest treatment of the asset:
 * an upscale under a deliberate blur reads as depth of field, where the same
 * upscale rendered crisply reads as a broken image. The reference's own
 * background is out of focus behind its cards, so this is also what the design
 * asks for.
 *
 * The blur therefore scales with the crime. A phone viewport is roughly the
 * image's native width and gets 1px, barely more than the resampling already
 * does; a desktop is asking for five times the pixels that exist and gets 3px.
 *
 * `scale-110` exists because `filter: blur()` samples transparency beyond the
 * element's edges, leaving a soft translucent border a few pixels wide. Growing
 * the layer past the viewport pushes that artefact off-screen.
 *
 * **On the crop.** `object-position` is biased above centre. The source is
 * portrait and the viewport is landscape, so `cover` scales to fill the width
 * and discards most of the height — and the window that survives is only about
 * 43% of the source, which is not enough to hold both the roof and the pitch.
 *
 * So the roof wins, pushed left and high: 22% on the horizontal anchors the
 * arc against the left edge the way the reference does, which leaves the right
 * half as plain dark sky — exactly where the card column lands. Centred, the
 * arc sweeps through the middle of the page and fights the headline for it.
 *
 * **On the scrim.** Three stacked gradients rather than one flat tint, because
 * the hero asks different things of different corners: the headline sits
 * bottom-left over what would otherwise be the brightest part of the pitch, the
 * card column needs a calmer ground on the right, and the whole photograph
 * needs pulling toward #020617 so it belongs to the same page as the sections
 * below it. A single uniform overlay dark enough for the headline would flatten
 * the arc into nothing.
 *
 * Purely decorative: `aria-hidden`, empty `alt`, and no pointer events. A
 * screen reader should hear the headline, not a photograph of a stadium.
 */
import { Suspense, lazy, useEffect, useRef } from "react";

import { useReducedMotion } from "framer-motion";

import { useQuality } from "../3D/rig/quality";
import { BEATS, beat, journey } from "../../hooks/useJourney";

// three.js is ~800KB. Behind a lazy boundary so the landing's first paint
// never waits on it, and a tier-1 device never fetches it at all.
const StadiumScene = lazy(() => import("../3D/StadiumScene"));

export interface StadiumBackdropProps {
  /**
   * `hero` — the landing. A heavy scrim, because large display type sits
   *          directly on the photograph with nothing between them.
   * `console` — /data and /auction. A much lighter scrim and a brightness lift,
   *          because the dense material on those pages sits inside panels that
   *          carry their own ground, so the photograph never has to hold text.
   *          The floodlights along the arc are then free to be the brightest
   *          thing behind the UI and do the contrasting, which is the point of
   *          keeping a photograph back there at all.
   */
  variant?: "hero" | "console";
  /**
   * Render the 3D arena behind the photograph and cross-fade to it as the
   * journey starts. Off by default: only the landing drives the journey, and
   * every other surface wants the cheap static backdrop.
   */
  live3d?: boolean;
}

/** The scrim stacks, per surface. Ordered front to back, as CSS paints them. */
const SCRIM = {
  hero: [
    // Bottom scrim, under the headline, which sits on a lit pitch.
    "linear-gradient(to top, rgba(2,6,23,0.96) 0%, rgba(2,6,23,0.80) 26%, rgba(2,6,23,0.52) 60%, rgba(2,6,23,0.40) 100%)",
    // Right-hand weight, under the card column.
    "linear-gradient(to left, rgba(2,6,23,0.62) 0%, rgba(2,6,23,0.20) 48%, rgba(2,6,23,0) 72%)",
    // A pool of shade through the middle. The arc's lit rim runs straight
    // across the centre of this crop and the headline sits on top of it;
    // without this the white type lands on the one bright band in the picture.
    "radial-gradient(90vw 70vh at 46% 52%, rgba(2,6,23,0.66), rgba(2,6,23,0) 72%)",
    // A flat cool tint so the photograph belongs to the same page as everything
    // scrolled past it.
    "linear-gradient(rgba(2,6,23,0.38), rgba(2,6,23,0.38))",
  ],
  console: [
    // Enough weight at the very bottom to seat the page, and no centre pool at
    // all — the arc is the contrast here, not something to be suppressed.
    "linear-gradient(to top, rgba(2,6,23,0.72) 0%, rgba(2,6,23,0.34) 30%, rgba(2,6,23,0.12) 70%, rgba(2,6,23,0.10) 100%)",
    "linear-gradient(rgba(2,6,23,0.16), rgba(2,6,23,0.16))",
  ],
  /*
    The arena's own stack, much lighter than the photograph's.

    The hero scrim exists because a 21KB upscaled JPEG is busy everywhere at
    once, so large display type needs a near-opaque floor under it — 0.96 at the
    bottom. The rendered arena is not that picture: it is mostly dark by
    construction, with its brightness concentrated in the lamp faces and the lit
    pitch, and it already paints its own near-black background. Reusing the
    photograph's scrim over it hides the thing entirely, which is what happened.

    So: keep a real floor at the bottom where the tracker card sits, keep a
    little weight on the right under the card column, and let the middle of the
    frame — the pitch, the towers, the boundary ring — come through.
  */
  arena: [
    "linear-gradient(to top, rgba(2,6,23,0.92) 0%, rgba(2,6,23,0.58) 22%, rgba(2,6,23,0.14) 52%, rgba(2,6,23,0.05) 100%)",
    "linear-gradient(to left, rgba(2,6,23,0.42) 0%, rgba(2,6,23,0.12) 46%, rgba(2,6,23,0) 70%)",
    "linear-gradient(rgba(2,6,23,0.10), rgba(2,6,23,0.10))",
  ],
} as const;

export default function StadiumBackdrop({
  variant = "hero",
  live3d = false,
}: StadiumBackdropProps) {
  const console_ = variant === "console";
  const quality = useQuality();
  const reduced = useReducedMotion() ?? false;
  const photo = useRef<HTMLImageElement>(null);
  const photoScrim = useRef<HTMLDivElement>(null);
  const arenaScrim = useRef<HTMLDivElement>(null);

  // The 3D arena replaces the photograph only on the hero, only where the
  // device can afford a canvas, and only when the page asks for it.
  const arena = live3d && !console_ && quality.canvas && !reduced;

  /*
    The handoff. The photograph holds the opening frame and dissolves as the
    journey starts, so the first thing painted is the image that has always
    been there rather than a WebGL context still warming up — and a visitor who
    never scrolls never sees a swap at all.

    Written straight to the DOM node on an animation frame. Progress changes
    every frame, so putting it in React state would re-render the landing sixty
    times a second to set one opacity.
  */
  useEffect(() => {
    if (!arena) return;
    let frame = requestAnimationFrame(function loop() {
      const t = beat(journey.progress, 0, BEATS.heroEnd * 0.8);
      // The photograph and its heavy scrim leave together; the arena's lighter
      // scrim arrives in their place. Crossing them rather than simply dropping
      // the photo matters — the hero scrim alone over the arena is what made it
      // invisible in the first place.
      if (photo.current) photo.current.style.opacity = String(1 - t);
      if (photoScrim.current) photoScrim.current.style.opacity = String(1 - t);
      if (arenaScrim.current) arenaScrim.current.style.opacity = String(t);
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [arena]);

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
      {arena && (
        <Suspense fallback={null}>
          <StadiumScene quality={quality} animate />
        </Suspense>
      )}

      <img
        ref={photo}
        src="/stadium-portrait.jpg"
        alt=""
        draggable={false}
        decoding="async"
        /*
          The console variant lifts brightness and saturation rather than simply
          removing scrim. Taking the scrim off alone gives a pale, washed
          photograph; the lift puts the energy back into the floodlights
          specifically, because they are the brightest pixels in the frame and a
          multiplicative filter moves them furthest. The result is an arc of warm
          light behind a cool interface, which is the contrast that was asked
          for — and it stays out of the way, because everything it sits behind
          paints its own ground.
        */
        className={`h-full w-full scale-110 object-cover object-[22%_30%] blur-[1px] sm:blur-[2px] lg:blur-[3px] ${
          console_ ? "brightness-[1.45] saturate-[1.25] contrast-[1.08]" : ""
        }`}
      />

      <div
        ref={photoScrim}
        className="absolute inset-0"
        style={{ background: SCRIM[variant].join(", ") }}
      />

      {arena && (
        <div
          ref={arenaScrim}
          className="absolute inset-0"
          style={{ background: SCRIM.arena.join(", "), opacity: 0 }}
        />
      )}
    </div>
  );
}
