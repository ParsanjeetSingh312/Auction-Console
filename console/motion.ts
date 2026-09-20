/**
 * motion.ts
 * One motion vocabulary for the whole console.
 *
 * Variants live here rather than inline so that every panel enters the same
 * way and every button answers the pointer with the same weight. Motion that
 * differs slightly from view to view reads as jitter; motion that is identical
 * everywhere stops being noticed at all, which is the goal — this is a working
 * instrument, not a showreel.
 *
 * Durations are deliberately short. A dashboard someone operates under time
 * pressure should feel answered, not performed: 0.18–0.32s is enough to show
 * causality and short enough that nobody waits on it.
 */
import type { Transition, Variants } from "framer-motion";

/** The house easing: quick out of the gate, settled at the end. */
export const EASE = [0.22, 1, 0.36, 1] as const;

export const SPRING: Transition = {
  type: "spring",
  stiffness: 380,
  damping: 30,
  mass: 0.7,
};

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

/**
 * Tab and view changes: a short lift and fade.
 *
 * The exit distance is smaller than the entrance so a switch reads as the new
 * view arriving rather than the old one being thrown away.
 */
export const viewVariants: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.28, ease: EASE, when: "beforeChildren", staggerChildren: 0.035 },
  },
  exit: { opacity: 0, y: -6, transition: { duration: 0.16, ease: EASE } },
};

/** A panel inside a view. Inherits the parent's stagger. */
export const panelVariants: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

/**
 * Primary actions. The scale is small on purpose: 1.02 reads as responsive,
 * anything larger reads as a toy and, on a wide button, visibly shifts the
 * label the user is reading.
 */
export const pressable = {
  whileHover: { scale: 1.02 },
  whileTap: { scale: 0.98 },
  transition: SPRING,
} as const;

/** Chips and small toggles, which sit closer together and need less travel. */
export const chippable = {
  whileHover: { scale: 1.04 },
  whileTap: { scale: 0.96 },
  transition: SPRING,
} as const;

/* ------------------------------------------------------------------ *
 * Lists
 * ------------------------------------------------------------------ */

/**
 * Rows that reorder in place — the budget grid, ranked results.
 *
 * `layout` on the child plus these variants is what makes a franchise slide to
 * its new rank instead of teleporting, which is the whole point of sorting the
 * grid live.
 */
export const rowVariants: Variants = {
  initial: { opacity: 0, y: 8, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.24, ease: EASE } },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.14 } },
};

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

/**
 * The masthead and its furniture, arriving once on mount.
 *
 * Header items come *down* (`y: -6`) while view content comes *up* (`y: 10`).
 * The two meeting in the middle reads as the screen opening; everything
 * travelling the same direction reads as the page having been scrolled.
 */
export const shellVariants: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.045, delayChildren: 0.02 } },
};

export const shellItem: Variants = {
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.26, ease: EASE } },
};

/* ------------------------------------------------------------------ *
 * Grids
 * ------------------------------------------------------------------ */

/**
 * A grid of cards — franchises, result groups, squad slots.
 *
 * 0.03s per child, and that number is not arbitrary: past roughly 0.04s a list
 * of more than ten items takes longer to finish arriving than a reader takes to
 * start looking for a specific one, and the animation becomes something to wait
 * through. `delayChildren` is zero because this grid is usually already on
 * screen when it mounts.
 */
export const gridVariants: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.03 } },
};

export const cardVariants: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.14, ease: EASE } },
};

/**
 * Hover feedback for a card or a row.
 *
 * Two pixels. The reference this is drawn from is explicit that displacement
 * over about 2px stops reading as feedback and starts reading as motion, and on
 * a grid of franchise cards the difference is whether the screen answers you or
 * fidgets at you. No scale: scaling a card with a number in it resamples the
 * text, and on a dashboard the numbers are the point.
 */
export const liftable = {
  whileHover: { y: -2 },
  whileTap: { y: 0 },
  transition: { duration: 0.16, ease: EASE },
} as const;

/* ------------------------------------------------------------------ *
 * Overlays
 * ------------------------------------------------------------------ */

/** The dimmer behind a drawer. Fades, never moves. */
export const scrimVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.18, ease: EASE } },
  exit: { opacity: 0, transition: { duration: 0.14, ease: EASE } },
};

/**
 * A drawer or detail card.
 *
 * The exit is faster than the entrance — 0.16s against 0.26s. Asymmetry is what
 * makes dismissing feel immediate while opening still feels deliberate; equal
 * timings make closing feel like the screen is arguing with you.
 */
export const drawerVariants: Variants = {
  initial: { opacity: 0, y: 14, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.26, ease: EASE } },
  exit: { opacity: 0, y: 8, scale: 0.99, transition: { duration: 0.16, ease: EASE } },
};

/** Toasts, which stack from the bottom and must never block a click. */
export const toastVariants: Variants = {
  initial: { opacity: 0, y: 10, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.2, ease: EASE } },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.14, ease: EASE } },
};

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

/**
 * A Scout turn arriving in the log.
 *
 * The horizontal offset encodes who is speaking — a question slides in from the
 * reader's side, an answer from the other. Ten pixels is enough to register as
 * a direction and small enough that it never looks like the bubble flew in.
 */
export const bubbleFromUser: Variants = {
  initial: { opacity: 0, y: 8, x: 10 },
  animate: { opacity: 1, y: 0, x: 0, transition: { duration: 0.26, ease: EASE } },
};

export const bubbleFromBot: Variants = {
  initial: { opacity: 0, y: 8, x: -10 },
  animate: { opacity: 1, y: 0, x: 0, transition: { duration: 0.26, ease: EASE } },
};

/* ------------------------------------------------------------------ *
 * Figures
 * ------------------------------------------------------------------ */

/**
 * A number that has changed: the old value leaves upward, the new arrives from
 * below. Used by keying the element on its own value.
 *
 * Deliberately *not* a count-up. A tween through 281, 282, 283 puts numbers on
 * a read-only analytics screen that were never true, and for the one-step
 * changes this dashboard actually sees ("sold" going from 46 to 47) a roll
 * would be theatre. This says "that changed" without ever printing a wrong
 * figure.
 */
export const figureVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.16, ease: EASE } },
};

/**
 * Respect the platform setting. Framer Motion honours `useReducedMotion` at the
 * component level; this is the value to spread into a transition when a caller
 * needs to flatten one explicitly.
 */
export const NO_MOTION: Transition = { duration: 0 };
