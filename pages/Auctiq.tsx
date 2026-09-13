/**
 * Auctiq.tsx
 * The dark landing surface — Phase 1 shell.
 *
 * Built at `/auctiq` rather than replacing `/` while it is under construction.
 * The white landing at `/` works and is linked from the rest of the app; there
 * is no reason for it to be broken for the days this takes. When Phase 4 signs
 * off, promoting this to `/` is a one-line change in the route table and the
 * old one can retire.
 *
 * The `.auctiq` wrapper is what makes the dark theme safe. Every dark token
 * and glass utility is scoped to that class in styles.css, so nothing here can
 * reach the console, the Data Interface or the war room — they keep the white
 * enterprise theme from Phase 3b untouched.
 *
 * Phase 1 is the ground and the mark only: palette, type, the stadium light,
 * the fixed logo. The trophy canvas lands in Phase 2 and the player showcase
 * in Phase 3; the placeholders below are marked and sized so the layout does
 * not jump when they arrive.
 */
import { Suspense, lazy, useEffect } from "react";
import { Link } from "react-router-dom";

import AuctiqLogo, { AuctiqMark } from "../components/Global/AuctiqLogo";

/**
 * three.js + fiber + drei is ~700KB before the scene exists. Loading it lazily
 * keeps it out of the landing's first paint, so the headline and the call to
 * action are interactive while the trophy is still arriving.
 */
const TrophyCanvas = lazy(() => import("../components/3D/TrophyCanvas"));

export default function Auctiq() {
  useEffect(() => {
    document.title = "AUCTIQ · IPL 2026 Mega Auction";
  }, []);

  return (
    <div className="auctiq relative min-h-screen overflow-x-hidden">
      {/* Fixed atmospheric layers, behind everything. */}
      <div className="auctiq-stadium" aria-hidden />
      <div className="auctiq-grid" aria-hidden />

      <AuctiqLogo />

      <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl flex-col items-center justify-center px-5 py-20 text-center sm:px-8">
        <span className="font-tech text-[10px] uppercase tracking-[0.34em] text-auctiq-gold/80">
          Indian Premier League · 2026
        </span>

        {/*
          Display type is sized in `clamp` rather than by breakpoint. Russo One
          has one weight and a wide aperture, so it scales cleanly, and a fluid
          headline never lands at the one viewport width where a fixed step
          wraps badly.
        */}
        <h1 className="mt-5 font-auctiq text-[clamp(2.5rem,9vw,6.5rem)] leading-[0.95] tracking-[0.02em] text-auctiq-text text-glow-soft">
          THE MEGA
          <br />
          <span className="text-auctiq-gold text-glow-gold">AUCTION</span>
        </h1>

        <p className="mt-6 max-w-xl font-tech text-[15px] leading-relaxed text-auctiq-dim">
          284 players. Ten franchises. ₹1,200 crore on the table. Scouted on real
          numbers, bid in real time, settled before anyone leaves the room.
        </p>

        {/*
          The trophy. Sized in `vh` so it scales with the viewport rather than
          the text column, and floored at 220px so it never collapses to a
          sliver on a short laptop screen.

          The Suspense fallback is the flat SVG mark rather than a spinner: the
          chunk usually arrives within a frame or two, and a spinner that
          flashes for 80ms reads as a fault. The same mark is the WebGL
          fallback, so a machine without it still gets a centrepiece.
        */}
        <div className="relative mt-10 h-[clamp(220px,38vh,400px)] w-full max-w-2xl">
          <Suspense fallback={<TrophyFallback />}>
            <TrophyCanvas className="h-full w-full" fallback={<TrophyFallback />} />
          </Suspense>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/auction"
            className="inline-flex min-h-[44px] items-center rounded-full bg-auctiq-gold px-7 font-tech text-[12px] font-600 uppercase tracking-[0.16em] text-auctiq-void shadow-gold-glow transition-transform duration-200 hover:scale-[1.02] active:scale-[0.98]"
          >
            Enter the auction
          </Link>
          <Link
            to="/data"
            className="inline-flex min-h-[44px] items-center rounded-full border border-white/15 px-7 font-tech text-[12px] uppercase tracking-[0.16em] text-auctiq-text transition-colors duration-200 hover:border-auctiq-gold/40 hover:text-auctiq-gold"
          >
            Scout the pool
          </Link>
        </div>


      </main>
    </div>
  );
}

/**
 * Shown while the 3D chunk loads, and permanently on machines without WebGL.
 *
 * The same mark as the logo, at size. A hero that falls back to empty space
 * looks broken; one that falls back to a large gold mark just looks quieter.
 */
function TrophyFallback() {
  return (
    <div className="grid h-full w-full place-items-center">
      <AuctiqMark className="h-24 w-24 opacity-70" />
    </div>
  );
}
