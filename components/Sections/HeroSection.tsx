/**
 * HeroSection.tsx
 * The landing view: headline, trophy, and the two ways in.
 *
 * Extracted from the page so `Auctiq.tsx` is a list of sections rather than a
 * thousand lines of markup — which is what makes reordering the page a matter
 * of moving one line.
 *
 * The entrance is staggered from `utils/animations`: eyebrow, headline, copy,
 * trophy, actions, figures. The order matters more than the timing. The
 * headline arrives before the trophy on purpose, because the trophy is the more
 * arresting object and would otherwise pull the eye away from the words before
 * they have been read.
 */
import { Suspense, lazy } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";

import { AuctiqMark } from "../Global/AuctiqLogo";
import MagneticButton from "../UI/MagneticButton";
import { fadeUp, fadeUpLarge, staggerContainer } from "../../utils/animations";

/**
 * three + fiber + drei is ~860KB as its own chunk. Loaded lazily so the
 * headline and the call to action are interactive while it is still arriving —
 * and a visitor who never scrolls past the fold on a metered connection is not
 * charged for a 3D scene they did not ask for.
 */
const TrophyCanvas = lazy(() => import("../3D/TrophyCanvas"));

export default function HeroSection() {
  const reduced = useReducedMotion();

  return (
    <motion.section
      variants={staggerContainer}
      initial={reduced ? false : "initial"}
      animate="animate"
      className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl flex-col items-center justify-center px-5 py-24 text-center sm:px-8"
    >
      <motion.span
        variants={fadeUp}
        className="font-tech text-[10px] uppercase tracking-[0.34em] text-auctiq-gold/80"
      >
        Indian Premier League · 2026
      </motion.span>

      {/*
        Sized in `clamp` rather than by breakpoint. Russo One has one weight and
        a wide aperture so it scales cleanly, and a fluid headline never lands at
        the one viewport width where a fixed step wraps badly.
      */}
      <motion.h1
        variants={fadeUpLarge}
        className="mt-5 font-auctiq text-[clamp(2.5rem,9vw,6.5rem)] leading-[0.95] tracking-[0.02em] text-auctiq-text text-glow-soft"
      >
        THE MEGA
        <br />
        <span className="text-auctiq-gold text-glow-gold">AUCTION</span>
      </motion.h1>

      <motion.p
        variants={fadeUp}
        className="mt-6 max-w-xl font-tech text-[15px] leading-relaxed text-auctiq-dim"
      >
        284 players. Ten franchises. ₹1,200 crore on the table. Scouted on real
        numbers, bid in real time, settled before anyone leaves the room.
      </motion.p>

      <motion.div
        variants={fadeUp}
        className="relative mt-8 h-[clamp(230px,40vh,420px)] w-full max-w-2xl"
      >
        <Suspense fallback={<TrophyFallback />}>
          <TrophyCanvas className="h-full w-full" fallback={<TrophyFallback />} />
        </Suspense>
      </motion.div>

      <motion.div
        variants={fadeUp}
        className="mt-8 flex flex-wrap items-center justify-center gap-3"
      >
        <MagneticButton to="/auction" tone="gold">
          Enter the auction
        </MagneticButton>
        <MagneticButton to="/data" tone="ghost">
          Scout the pool
        </MagneticButton>
      </motion.div>

      <motion.div
        variants={fadeUp}
        className="mt-10 flex flex-wrap items-center justify-center gap-x-8 gap-y-3"
      >
        <Figure value="284" label="players" />
        <Figure value="10" label="franchises" />
        <Figure value="₹120 Cr" label="a purse" />
        <Figure value="25" label="squad cap" />
      </motion.div>
    </motion.section>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <b className="font-num text-[17px] font-bold tabular-nums text-auctiq-text">
        {value}
      </b>
      <span className="font-tech text-[10px] uppercase tracking-[0.14em] text-auctiq-dim">
        {label}
      </span>
    </span>
  );
}

/**
 * Shown while the 3D chunk loads, and permanently without WebGL.
 *
 * The logo mark at size, not a spinner. The chunk usually arrives within a
 * frame or two and a spinner that flashes for 80ms reads as a fault; a hero
 * that degrades to a large gold mark just looks quieter than one that degrades
 * to empty space.
 */
function TrophyFallback() {
  return (
    <div className="grid h-full w-full place-items-center">
      <AuctiqMark className="h-24 w-24 opacity-70" />
    </div>
  );
}
