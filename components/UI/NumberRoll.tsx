/**
 * NumberRoll.tsx
 * A number that counts to its new value instead of snapping to it.
 *
 * **It costs zero React renders.** The tween writes straight into
 * `textContent` through a ref, so a bid climbing ₹4.00 Cr to ₹8.40 Cr never
 * re-enters React. The prototype's note on why that matters is exact:
 * "rendering 30 frames of a number through React during a bidding war would
 * drop frames on exactly the screen that must not drop them."
 *
 * **`format` receives the raw interpolated value each frame**, so the caller
 * owns units — lakh in, "₹8.40 CR" out — and this component never learns what
 * money is. That is what lets the same component roll a purse, a bid, a squad
 * count and a percentage.
 *
 * framer-motion's `animate` rather than the prototype's GSAP tween. The rule
 * for this project is GSAP for timeline choreography and framer-motion for
 * component state motion; a single value easing to a new value is squarely the
 * second, and it keeps this out of the dependency graph of anything that does
 * not already use GSAP.
 *
 * **Reduced motion snaps.** A figure that animates is telling you it changed;
 * a reader who has asked for less motion still needs to know it changed, and
 * gets the new number immediately instead.
 */
import { useEffect, useRef } from "react";

import { animate, useReducedMotion } from "framer-motion";

export interface NumberRollProps {
  value: number;
  /** Raw interpolated value in, display string out. */
  format?: (n: number) => string;
  /** Seconds. Short by default: this is feedback, not a performance. */
  duration?: number;
  className?: string;
}

const identity = (n: number) => String(Math.round(n));

export default function NumberRoll({
  value,
  format = identity,
  duration = 0.55,
  className = "",
}: NumberRollProps) {
  const node = useRef<HTMLSpanElement>(null);
  /** What is currently on screen, so an interrupted tween resumes from it. */
  const shown = useRef(value);
  const reduced = useReducedMotion() ?? false;

  /*
    `format` is held in a ref rather than listed as a dependency.

    Callers almost always pass an inline arrow — `(n) => crore(n)` — which is a
    new function identity on every render. In the dependency array that
    restarts the tween on every parent render, so during a bidding war the
    number would begin again from wherever it had reached and never arrive.
  */
  const formatRef = useRef(format);
  formatRef.current = format;

  useEffect(() => {
    const el = node.current;
    if (!el) return;

    if (reduced || shown.current === value) {
      shown.current = value;
      el.textContent = formatRef.current(value);
      return;
    }

    const controls = animate(shown.current, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (n) => {
        shown.current = n;
        el.textContent = formatRef.current(n);
      },
      onComplete: () => {
        shown.current = value;
        el.textContent = formatRef.current(value);
      },
    });

    // Stopping mid-flight leaves `shown` wherever it reached, so the next tween
    // starts from the figure actually on screen rather than jumping back.
    return () => controls.stop();
  }, [value, duration, reduced]);

  return (
    <span ref={node} className={`tabular-nums ${className}`.trim()}>
      {format(value)}
    </span>
  );
}
