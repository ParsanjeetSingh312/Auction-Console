/**
 * BidTicker.tsx
 * The standing bid, counted up rather than swapped.
 *
 * A figure that simply replaces itself gives no sense of direction: ₹2.00 Cr
 * becoming ₹2.20 Cr looks the same as it becoming ₹1.80 Cr. Rolling the value
 * makes the movement itself the signal, and the accompanying pop separates a
 * raise from a re-render.
 *
 * The count runs on a Framer Motion value rather than React state. A spring
 * settling over ~400ms would otherwise push twenty-odd renders of the whole
 * panel through the reconciler; here only this one text node is written to.
 */
import { useEffect, useRef } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "framer-motion";

import { EASE } from "../../console/motion";

export interface BidTickerProps {
  /** ₹ lakh. */
  value: number;
  /** Formats the animated figure. Receives ₹ lakh. */
  format: (lakh: number) => string;
  className?: string;
}

export default function BidTicker({ value, format, className = "" }: BidTickerProps) {
  const reduced = useReducedMotion();
  const count = useMotionValue(value);
  const text = useTransform(count, (latest) => format(latest));

  // The pop is driven separately so the scale can settle faster than the count,
  // which keeps the figure readable while it is still moving.
  const pop = useMotionValue(1);
  const previous = useRef(value);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;

    if (reduced || from === value) {
      count.set(value);
      return;
    }

    const counting = animate(count, value, { duration: 0.45, ease: EASE });

    // Only a raise gets the punch. A correction downward is a different event
    // and should not celebrate itself.
    if (value > from) {
      pop.set(1.14);
      animate(pop, 1, { type: "spring", stiffness: 420, damping: 18, mass: 0.6 });
    }

    return () => counting.stop();
  }, [value, reduced, count, pop]);

  return (
    <motion.span
      style={{ scale: pop }}
      className={`inline-block origin-left tabular-nums ${className}`}
    >
      <motion.span>{text}</motion.span>
    </motion.span>
  );
}
