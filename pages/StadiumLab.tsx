/**
 * StadiumLab.tsx
 * A bench for the stadium, at `/stadium`.
 *
 * The 3D landing is built over several steps — ground, floodlights, camera,
 * ball — and none of those is reviewable until something mounts it. Building
 * four steps' worth of scene and only wiring it into the landing at the end
 * would mean four handovers you cannot look at, and a feature that exists but
 * is invisible is indistinguishable from one that is broken.
 *
 * So this page mounts the scene on its own route from the first step. Nothing
 * on the landing changes until the handoff step; everything here can be scrolled
 * and judged the moment it lands. The route sits beside `/auction/demo` and
 * `/classic`, which exist for the same reason.
 *
 * It also shows the two numbers that are otherwise invisible and, when wrong,
 * fail silently: the device tier, and journey progress. A camera that does not
 * move is either a broken rig or a progress value stuck at zero, and those look
 * identical from the outside.
 */
import { Suspense, lazy, useEffect, useRef } from "react";

import { useReducedMotion } from "framer-motion";

import { useQuality } from "../components/3D/rig/quality";
import {
  BEATS,
  journey,
  useJourneyProgress,
  useSmoothScroll,
} from "../hooks/useJourney";

// three.js + fiber is ~700KB before the scene. Behind a lazy boundary so the
// route's own shell paints immediately, and so a tier-1 device never fetches it.
const StadiumScene = lazy(() => import("../components/3D/StadiumScene"));

export default function StadiumLab() {
  const quality = useQuality();
  const reduced = useReducedMotion() ?? false;
  const track = useRef<HTMLDivElement>(null);

  const animate = quality.canvas && !reduced;

  useSmoothScroll(animate);
  useJourneyProgress(track, animate);

  return (
    <div className="relative bg-[#04070f] text-white">
      {/* The scene is fixed; the track below it is what actually scrolls. */}
      <div className="fixed inset-0">
        {quality.canvas ? (
          <Suspense fallback={<StadiumFallback label="loading the arena" />}>
            <StadiumScene quality={quality} animate={animate} />
          </Suspense>
        ) : (
          // Tier 1: no WebGL context at all, by design. See rig/quality.ts.
          <StadiumFallback label="stadium rendered as a backdrop on this device" />
        )}
      </div>

      <Readout tier={quality.tier} reduced={reduced} />

      {/*
        The scroll track. Its height sets the pace of the whole journey, so it
        is stated in viewport heights rather than pixels: 420vh matches the
        prototype's measured 3,780px at a 900px viewport.
      */}
      <div ref={track} className="relative h-[420vh]" />
    </div>
  );
}

/** Shown while the scene loads, and permanently on a tier-1 device. */
function StadiumFallback({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_75%,#0d2a20_0%,#061120_45%,#04070f_100%)]">
      <p className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[11px] uppercase tracking-[0.18em] text-white/35">
        {label}
      </p>
    </div>
  );
}

/**
 * Live tier and progress.
 *
 * Progress is read on an animation frame rather than through React state, for
 * the same reason the journey itself is: it changes every frame, and putting it
 * in state would re-render this page sixty times a second to update one string.
 * The DOM node is written to directly.
 */
function Readout({ tier, reduced }: { tier: number; reduced: boolean }) {
  const value = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const beatName = useRef<HTMLSpanElement>(null);

  useRafLoop(() => {
    const p = journey.progress;
    if (value.current) value.current.textContent = p.toFixed(3);
    if (bar.current) bar.current.style.transform = `scaleX(${p})`;
    if (beatName.current) beatName.current.textContent = nameOfBeat(p);
  });

  return (
    <div className="pointer-events-none fixed left-6 top-6 z-10 w-64 rounded-lg border border-white/10 bg-black/55 p-4 font-mono text-[11px] uppercase tracking-[0.14em] text-white/70 backdrop-blur">
      <div className="flex justify-between">
        <span>tier</span>
        <span className="text-[#37d0ff]">{tier}</span>
      </div>
      <div className="mt-1 flex justify-between">
        <span>reduced motion</span>
        <span className={reduced ? "text-amber-400" : "text-white/40"}>
          {reduced ? "on" : "off"}
        </span>
      </div>
      <div className="mt-1 flex justify-between">
        <span>progress</span>
        <span ref={value} className="text-[#37d0ff]">
          0.000
        </span>
      </div>
      <div className="mt-1 flex justify-between">
        <span>beat</span>
        <span ref={beatName} className="text-white/90">
          hero
        </span>
      </div>
      <div className="mt-3 h-[2px] w-full overflow-hidden bg-white/10">
        <div
          ref={bar}
          className="h-full w-full origin-left bg-[#37d0ff]"
          style={{ transform: "scaleX(0)" }}
        />
      </div>
    </div>
  );
}

function nameOfBeat(progress: number): string {
  if (progress < BEATS.heroEnd) return "hero";
  if (progress < BEATS.trophyEnd) return "trophy";
  if (progress < BEATS.pitchEnd) return "pitch";
  return "handoff";
}

/**
 * Run a callback every animation frame for the life of the component.
 *
 * The callback is held in a ref so the loop is started exactly once: passing it
 * in a dependency array would tear down and restart the loop on every render,
 * which for a readout that renders on every frame is an infinite loop wearing a
 * hat.
 */
function useRafLoop(callback: () => void): void {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    let frame = requestAnimationFrame(function loop() {
      latest.current();
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
}
