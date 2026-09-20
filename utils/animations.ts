/**
 * animations.ts
 * One motion vocabulary for the AUCTIQ landing.
 *
 * Companion to `console/motion.ts`, which serves the white console. They are
 * deliberately separate: the console's motion is 0.18–0.32s and almost
 * invisible, because it is an instrument someone operates under time pressure.
 * A landing is the opposite — it is a performance, and the timings below are
 * two to three times longer on purpose.
 *
 * Everything is declared here rather than inline so the whole page can be
 * retimed from one file, and so two sections cannot drift into using slightly
 * different easings — which reads as jitter rather than as variety.
 */
import type { Transition, Variants } from "framer-motion";

/**
 * The house curve: a hard start that decelerates a long way out.
 *
 * `expo.out` in GSAP terms, which is what the design database returns for
 * complex-tier stagger and page transitions. It is what makes an entrance feel
 * like something arriving rather than something fading up.
 */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** For things that leave. Exits are faster than entrances, always. */
export const EASE_IN = [0.7, 0, 0.84, 0] as const;

export const SPRING: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 28,
  mass: 0.8,
};

/** Softer spring for anything tracking a pointer, where stiffness reads as jitter. */
export const POINTER_SPRING: Transition = {
  type: "spring",
  stiffness: 120,
  damping: 20,
  mass: 0.6,
};

/* ------------------------------------------------------------------ *
 * Entrances
 * ------------------------------------------------------------------ */

/**
 * Parent of a staggered group.
 *
 * `staggerChildren` is kept at 0.08: below ~0.05 the children read as one
 * simultaneous move and the stagger is wasted; above ~0.12 the last child
 * arrives late enough that the group feels slow.
 */
export const staggerContainer: Variants = {
  initial: {},
  animate: {
    transition: { staggerChildren: 0.08, delayChildren: 0.1 },
  },
};

export const fadeUp: Variants = {
  initial: { opacity: 0, y: 28 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: EASE_OUT },
  },
  exit: { opacity: 0, y: -12, transition: { duration: 0.3, ease: EASE_IN } },
};

/** For headlines, which want a touch more travel than body copy. */
export const fadeUpLarge: Variants = {
  initial: { opacity: 0, y: 44 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.85, ease: EASE_OUT },
  },
};

export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.6, ease: EASE_OUT } },
};

/** Cards arriving into a grid: rise, and settle from slightly small. */
export const riseIn: Variants = {
  initial: { opacity: 0, y: 36, scale: 0.96 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.6, ease: EASE_OUT },
  },
};

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

/**
 * Primary actions. Scale is small deliberately: 1.03 reads as responsive,
 * anything larger visibly shifts the label the user is reading.
 */
export const pressable = {
  whileHover: { scale: 1.03 },
  whileTap: { scale: 0.97 },
  transition: SPRING,
} as const;

/**
 * Magnetic pull toward the cursor, in pixels.
 *
 * Deliberately small. A button that chases the pointer across the screen is a
 * novelty; one that leans a few pixels reads as weight, and still lands under
 * the cursor where the user aimed — which a large offset does not.
 */
export const MAGNET_STRENGTH = 6;

/* ------------------------------------------------------------------ *
 * Scroll
 * ------------------------------------------------------------------ */

/**
 * When a scroll-triggered section should fire.
 *
 * `amount: 0.25` rather than `"some"`, so a tall section starts animating once
 * a quarter of it is showing instead of the instant its top edge appears —
 * which on a full-height section means animating entirely off screen.
 *
 * `once: true` because a section that re-animates every time it scrolls back
 * into view is the single most irritating thing a landing page does.
 */
export const inView = { once: true, amount: 0.25 } as const;

/**
 * Depth factor for parallax layers, indexed front to back.
 *
 * Kept inside 0.55–1.3: the database's guidance is a small delta (5–15%) so
 * foreground and background never visibly desync, and anything stronger reads
 * as the layers sliding apart.
 */
export function parallaxDepth(index: number, total: number): number {
  if (total <= 1) return 1;
  return 0.55 + (index / (total - 1)) * 0.75;
}

/** Nothing moves. Spread into a transition when a caller must flatten one. */
export const NO_MOTION: Transition = { duration: 0 };
