/**
 * LightSweep.tsx
 * One pass of light across a card as it arrives -- the seat picker's chair
 * sweep (console.css `.seat-chair__sweep`), for any card that wants it.
 *
 * Drop it as the first child of a `relative overflow-hidden` card. GSAP moves
 * it once from off the left edge to off the right; under reduced motion it
 * stays parked out of sight.
 */
import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import gsap from "gsap";

export default function LightSweep({ delay = 0.35, duration = 1.6 }: { delay?: number; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;
    const tween = gsap.fromTo(el, { xPercent: -120 }, { xPercent: 220, duration, ease: "power2.inOut", delay });
    return () => {
      tween.kill();
    };
  }, [reduced, delay, duration]);

  return <span aria-hidden ref={ref} className="seat-chair__sweep" />;
}
