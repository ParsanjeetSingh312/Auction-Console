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

/**
 * Respect the platform setting. Framer Motion honours `useReducedMotion` at the
 * component level; this is the value to spread into a transition when a caller
 * needs to flatten one explicitly.
 */
export const NO_MOTION: Transition = { duration: 0 };
