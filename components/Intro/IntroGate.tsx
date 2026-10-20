/**
 * IntroGate.tsx
 * The black screen before the film: the AUCTONIQ wordmark and the button that
 * starts it. Nothing else.
 *
 * Kept black on purpose — the film opens by bringing the floodlights up from
 * darkness, so the gate is the dark it comes up from.
 *
 * One short entrance, in anime.js: the letters rise out of a mask from the
 * middle outwards, tilting up into place and coming into focus; one sheen of
 * light crosses the word as it settles; the button springs in under it.
 * Reduced motion gets everything in place with nothing moving.
 */
import { useLayoutEffect, useRef } from "react";

import { createTimeline, spring, stagger, utils } from "animejs";

const WORD = "AUCTONIQ".split("");

export interface IntroGateProps {
  /** The film is built and can start. */
  armed: boolean;
  onEnter: () => void;
}

export default function IntroGate({ armed, onEnter }: IntroGateProps) {
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const chars = el.querySelectorAll(".gate-char");
    const word = el.querySelector(".gate-word");
    const band = el.querySelector(".wordmark-sheen");
    const cta = el.querySelector(".gate-cta");
    if (!word || !band || !cta) return;
    // Hidden from the first paint, not from whenever each tween starts.
    utils.set(chars, { opacity: 0 });
    utils.set(cta, { opacity: 0 });

    const tl = createTimeline({ defaults: { ease: "outExpo" } })
      .add(
        chars,
        {
          translateY: ["110%", "0%"],
          rotateX: [-85, 0],
          opacity: [0, 1],
          filter: ["blur(10px)", "blur(0px)"],
          duration: 1150,
          delay: stagger(55, { from: "center" }),
        },
        150,
      )
      .add(word, { letterSpacing: ["0.3em", "0.06em"], duration: 1500 }, 150)
      // One pass of light across the settled word.
      .add(band, { backgroundPosition: ["150% 0%", "-50% 0%"], duration: 1100, ease: "inOutSine" }, 1500)
      .add(
        cta,
        { translateY: [22, 0], scale: [0.94, 1], opacity: [0, 1], duration: 1000, ease: spring({ stiffness: 150, damping: 14 }) },
        850,
      );

    return () => {
      tl.revert();
    };
  }, []);

  return (
    <div ref={root} className="intro-gate-card flex h-full w-full flex-col items-center justify-center bg-[#02040b] px-5">
      <div className="gate-mark relative">
        <h2
          aria-label="AUCTONIQ"
          className="gate-word font-auctiq text-[clamp(2.8rem,10vw,7rem)] uppercase leading-none tracking-[0.06em] text-neon-orange text-glow-orange"
        >
          {WORD.map((ch, i) => (
            <span key={i} aria-hidden className="gate-char inline-block">
              {ch}
            </span>
          ))}
        </h2>
        <span
          aria-hidden
          className="wordmark-sheen font-auctiq text-[clamp(2.8rem,10vw,7rem)] uppercase leading-none tracking-[0.06em]"
        >
          AUCTONIQ
        </span>
      </div>

      <button
        type="button"
        onClick={onEnter}
        disabled={!armed}
        autoFocus
        className="gate-cta intro-button intro-button--primary intro-button--gate mt-10"
      >
        {armed ? "Enter the auction" : "Setting up the ground"}
      </button>

      {/*
        What AUCTONIQ is and the policy links, on the very first screen, so a
        first visit -- Google's OAuth reviewer included -- finds them without
        playing the film. Plain links: they leave the gate for their page.
      */}
      <p className="mt-8 max-w-md text-center font-tech text-[12px] leading-relaxed text-white/55">
        A virtual cricket auction simulator: research players, run live auction rooms and build your XI.
      </p>
      <nav aria-label="Legal" className="mt-3 flex gap-5 font-tech text-[11px] uppercase tracking-[0.16em]">
        <a href="/about" className="text-white/50 underline-offset-4 hover:text-white hover:underline">About</a>
        <a href="/privacy" className="text-white/50 underline-offset-4 hover:text-white hover:underline">Privacy</a>
        <a href="/terms" className="text-white/50 underline-offset-4 hover:text-white hover:underline">Terms</a>
      </nav>
    </div>
  );
}
