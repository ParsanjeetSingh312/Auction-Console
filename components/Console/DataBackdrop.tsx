/**
 * DataBackdrop.tsx
 * The Data Interface's background: calm, branded, and out of the data's way.
 *
 * It replaces the stadium photograph on /data. The photo, brightened and
 * blurred with a lens flare running through it, was the loudest thing on a
 * page whose job is reading numbers, and it is what made the page feel
 * generated rather than designed.
 *
 * Four quiet layers, back to front:
 *   1. Brand navy, lit from the top like a floodlit night ground.
 *   2. Two soft glows, cyan and gold (the product's two accents), drifting
 *      very slowly so the page feels alive without anything to watch.
 *   3. A cricket ground seen from above: the boundary oval, the 30-yard
 *      circle and the pitch strip, drawn in hairlines at a few percent.
 *   4. A faint grid, faded out toward the edges, so panels have something
 *      to sit on.
 *
 * All of it is decoration: fixed, behind everything, and ignored by screen
 * readers and the pointer. With reduced motion asked for, the glows hold still.
 */
import { motion, useReducedMotion } from "framer-motion";

export default function DataBackdrop() {
  const reduce = useReducedMotion();

  /** A slow drift between two points, forever; still under reduced motion. */
  const drift = (x: string[], y: string[], duration: number) =>
    reduce
      ? {}
      : {
          animate: { x, y },
          transition: { duration, repeat: Infinity, repeatType: "mirror" as const, ease: "easeInOut" as const },
        };

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {/* 1. The ground colour. */}
      <div className="absolute inset-0 bg-[radial-gradient(140%_90%_at_50%_-10%,#123162_0%,#0a1934_38%,#060d1d_70%,#040914_100%)]" />

      {/* 2. Two glows in the brand accents. */}
      <motion.div
        className="absolute -left-[12%] -top-[18%] h-[60vh] w-[60vh] rounded-full bg-cyan-400/[0.10] blur-[110px]"
        {...drift(["0vw", "6vw"], ["0vh", "4vh"], 26)}
      />
      <motion.div
        className="absolute -bottom-[22%] -right-[10%] h-[70vh] w-[70vh] rounded-full bg-amber-300/[0.08] blur-[120px]"
        {...drift(["0vw", "-5vw"], ["0vh", "-6vh"], 32)}
      />

      {/* 3. The ground from above, centred low, hairlines only. */}
      <svg
        className="absolute left-1/2 top-[58%] h-[150vh] w-[150vh] -translate-x-1/2 -translate-y-1/2 opacity-[0.07]"
        viewBox="0 0 100 100"
        fill="none"
        stroke="#e2e8f0"
        strokeWidth="0.12"
      >
        <ellipse cx="50" cy="50" rx="46" ry="42" />
        <ellipse cx="50" cy="50" rx="24" ry="22" strokeDasharray="0.6 0.9" />
        <rect x="48.6" y="44" width="2.8" height="12" rx="0.3" />
        <line x1="47.6" y1="45.2" x2="52.4" y2="45.2" />
        <line x1="47.6" y1="54.8" x2="52.4" y2="54.8" />
      </svg>

      {/* 4. A faint grid, faded toward the edges. */}
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "linear-gradient(to right, #e2e8f0 1px, transparent 1px), linear-gradient(to bottom, #e2e8f0 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse 70% 60% at 50% 40%, #000 30%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(ellipse 70% 60% at 50% 40%, #000 30%, transparent 80%)",
        }}
      />

      {/* Seat the page: a little weight at the very bottom. */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[#030712]/70 to-transparent" />
    </div>
  );
}
