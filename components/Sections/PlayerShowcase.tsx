/**
 * PlayerShowcase.tsx
 * Six cards, clustered in a deck, scattered by scroll.
 *
 * The mechanism is the 21st.dev StackSpread component, rebuilt around player
 * cards rather than its demo photographs. Three things changed and each was
 * deliberate.
 *
 * **The import.** The original pulls from `motion/react` — the standalone
 * `motion` package. This project already has `framer-motion@13`, which exports
 * every hook it uses. Installing both would ship two copies of the same library
 * with two separate contexts, and components from one would not see providers
 * from the other. One import line is a far smaller cost than that class of bug.
 *
 * **The images.** Its cards point at a demo bucket. These are `PlayerCard`s,
 * so the showcase carries the tilt, the sheen and the franchise colour rather
 * than a flat photo.
 *
 * **The layout on touch.** The original branches on `(pointer: coarse)` rather
 * than width, which is the right call and is kept: a narrow *mouse* window — a
 * split editor, a docked devtools pane — should still get the scatter, because
 * the pointer parallax it enables works there. Only genuine touch devices drop
 * to the stacked column.
 *
 * How the scroll works. The section is 300vh tall with a sticky viewport-height
 * stage inside it. Scrolling moves `scrollYProgress` 0→1 across that height,
 * and the cards interpolate from their clustered offsets to their scattered
 * targets. The hold at either end (`SCATTER_START`, `SCATTER_END`) means the
 * deck sits still for a moment before it breaks and after it lands, rather than
 * being in motion the entire time the section is on screen.
 */
import { useEffect, useRef, useState } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from "framer-motion";

import PlayerCard from "../UI/PlayerCard";
import { parallaxDepth } from "../../utils/animations";
import { SHOWCASE_PLAYERS, type ShowcasePlayer } from "../../utils/players";

/** Scroll progress at which the deck starts breaking, and finishes landing. */
const SCATTER_START = 0.14;
const SCATTER_END = 0.88;

const PARALLAX_X = 2.4;
const PARALLAX_Y = 2.0;
const PARALLAX_SPRING = { stiffness: 90, damping: 22, mass: 0.6 };

interface Slot {
  /** Offset while clustered, in vw/vh. */
  stack: { x: number; y: number };
  /** Angle while clustered. */
  stackRotate: number;
  /** Final resting place on a pointer device. */
  target: { x: number; y: number; rotate: number };
  /** Final resting place on touch — a two-column grid. */
  targetSm: { x: number; y: number };
  /** Paint order, higher in front. */
  z: number;
}

/**
 * Six slots, authored back to front.
 *
 * The targets are hand-placed rather than generated: an even ring reads as a
 * diagram, where an uneven scatter with the heaviest cards low and outward
 * reads as a hand of cards thrown down.
 */
const SLOTS: Slot[] = [
  { stack: { x: -7, y: -8 }, stackRotate: -16, target: { x: -30, y: -20, rotate: -7 }, targetSm: { x: -22, y: -32 }, z: 2 },
  { stack: { x: 9, y: -9 }, stackRotate: 17, target: { x: 30, y: -22, rotate: 8 }, targetSm: { x: 22, y: -32 }, z: 3 },
  { stack: { x: -13, y: 1 }, stackRotate: -5, target: { x: -37, y: 14, rotate: -4 }, targetSm: { x: -22, y: 0 }, z: 4 },
  { stack: { x: 12, y: 2 }, stackRotate: 6, target: { x: 37, y: 12, rotate: 5 }, targetSm: { x: 22, y: 0 }, z: 5 },
  { stack: { x: -3, y: 9 }, stackRotate: -3, target: { x: -11, y: 26, rotate: 3 }, targetSm: { x: -22, y: 32 }, z: 6 },
  { stack: { x: 5, y: 10 }, stackRotate: 4, target: { x: 12, y: 27, rotate: -5 }, targetSm: { x: 22, y: 32 }, z: 7 },
];

function useCoarsePointer() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const read = () => setCoarse(mq.matches);
    read();
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);
  return coarse;
}

/** Pointer position, -1…1 on each axis, sprung. Inert when disabled. */
function usePointerParallax(enabled: boolean) {
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const x = useSpring(rawX, PARALLAX_SPRING);
  const y = useSpring(rawY, PARALLAX_SPRING);

  useEffect(() => {
    if (!enabled) {
      rawX.set(0);
      rawY.set(0);
      return;
    }
    const onMove = (event: PointerEvent) => {
      rawX.set((event.clientX / window.innerWidth) * 2 - 1);
      rawY.set((event.clientY / window.innerHeight) * 2 - 1);
    };
    const onLeave = () => {
      rawX.set(0);
      rawY.set(0);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, [enabled, rawX, rawY]);

  return { x, y };
}

export default function PlayerShowcase() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const coarse = useCoarsePointer();

  const { scrollYProgress } = useScroll({
    target: wrapRef,
    offset: ["start start", "end end"],
  });

  // Hold, scatter, hold.
  const progress = useTransform(
    scrollYProgress,
    [0, SCATTER_START, SCATTER_END, 1],
    [0, 0, 1, 1],
  );

  const parallaxOn = !reduced && !coarse;
  const pointer = usePointerParallax(parallaxOn);

  const copyOpacity = useTransform(progress, [0.28, 0.62], [0, 1]);
  const hintOpacity = useTransform(progress, [0, SCATTER_START], [1, 0]);

  return (
    <section
      ref={wrapRef}
      aria-label="Star players"
      className="relative w-full"
      style={{ height: reduced ? "auto" : "300vh" }}
    >
      <div
        className={
          reduced
            ? "relative w-full py-20"
            : "sticky top-0 h-screen w-full overflow-hidden"
        }
      >
        {/*
          Reduced motion gets a plain grid. Not a frozen version of the scatter
          — a static overlap would just look like a broken layout — but the same
          six players in a readable arrangement, which is the content the
          animation was decorating.
        */}
        {reduced ? (
          <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-4 px-5 sm:grid-cols-3 sm:px-8">
            {SHOWCASE_PLAYERS.map((player) => (
              <PlayerCard key={player.id} player={player} className="h-[300px]" />
            ))}
          </div>
        ) : (
          <>
            {/* Centre copy, fading in as the deck clears the middle. */}
            <motion.div
              style={{ opacity: copyOpacity }}
              className="pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center px-8 text-center"
            >
              <span className="font-tech text-[10px] uppercase tracking-[0.32em] text-auctiq-gold/80">
                On the block
              </span>
              <h2 className="mt-4 font-auctiq text-[clamp(2rem,6vw,4.5rem)] leading-[0.95] tracking-[0.02em] text-auctiq-text">
                EVERY NAME
                <br />
                <span className="text-auctiq-gold text-glow-gold">HAS A PRICE</span>
              </h2>
              <p className="mt-4 max-w-md font-tech text-[13.5px] leading-relaxed text-auctiq-dim">
                Two hundred and eighty-four of them, scouted on seventeen metrics
                apiece. The bidding decides the rest.
              </p>
            </motion.div>

            <div className="absolute inset-0 z-10">
              {SHOWCASE_PLAYERS.map((player, i) => (
                <Card
                  key={player.id}
                  player={player}
                  slot={SLOTS[i] ?? SLOTS[SLOTS.length - 1]}
                  progress={progress}
                  coarse={coarse}
                  pointer={pointer}
                  depth={parallaxOn ? parallaxDepth(i, SHOWCASE_PLAYERS.length) : 0}
                />
              ))}
            </div>

            {/* Scroll hint, gone by the time the deck breaks. */}
            <motion.div
              style={{ opacity: hintOpacity }}
              className="pointer-events-none absolute inset-x-0 bottom-8 z-20 flex flex-col items-center gap-1.5"
            >
              <span className="font-tech text-[9.5px] uppercase tracking-[0.28em] text-auctiq-dim">
                Scroll
              </span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="animate-bounce text-auctiq-gold"
                aria-hidden
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </motion.div>
          </>
        )}
      </div>
    </section>
  );
}

function Card({
  player,
  slot,
  progress,
  coarse,
  pointer,
  depth,
}: {
  player: ShowcasePlayer;
  slot: Slot;
  progress: MotionValue<number>;
  coarse: boolean;
  pointer: { x: MotionValue<number>; y: MotionValue<number> };
  depth: number;
}) {
  const end = coarse ? slot.targetSm : slot.target;
  const endRotate = coarse ? 0 : slot.target.rotate;

  /**
   * Position, as a `translate` string in viewport units.
   *
   * The `-50%` keeps each card centred on its own anchor, so the offsets above
   * describe where the card's middle goes rather than its top-left corner —
   * which is what makes the scatter values readable as a layout.
   */
  const translate = useTransform(
    [progress, pointer.x, pointer.y],
    ([p, mx, my]: number[]) => {
      const tx = slot.stack.x + (end.x - slot.stack.x) * p;
      const ty = slot.stack.y + (end.y - slot.stack.y) * p;
      // Parallax scales with progress, so the deck does not drift while it is
      // still stacked — only the scattered cards respond to the pointer.
      const drift = depth * p;
      return `calc(-50% + ${tx - mx * PARALLAX_X * drift}vw) calc(-50% + ${
        ty - my * PARALLAX_Y * drift
      }vh)`;
    },
  );

  const rotate = useTransform(progress, [0, 1], [slot.stackRotate, endRotate]);
  const scale = useTransform(progress, [0, 1], [0.84, 1]);

  return (
    <motion.div
      className="absolute left-1/2 top-1/2 will-change-transform"
      style={{
        width: coarse ? "38vw" : "15vw",
        height: coarse ? "26vh" : "34vh",
        minWidth: 132,
        minHeight: 186,
        zIndex: slot.z,
        translate,
        rotate,
        scale,
      }}
    >
      <PlayerCard player={player} className="h-full w-full" />
    </motion.div>
  );
}
