/**
 * IntroGate.tsx
 * The black screen before the film: the AUCTONIQ wordmark and the button that
 * starts it. Nothing else.
 *
 * Kept black on purpose — the film opens by bringing the floodlights up from
 * darkness, so the gate is the dark it comes up from.
 *
 * One short GSAP entrance: the letters rise in, then the button. Reduced
 * motion gets both in place with nothing moving.
 */
import { useLayoutEffect, useRef } from "react";

import gsap from "gsap";

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

    const ctx = gsap.context(() => {
      const q = gsap.utils.selector(el);
      gsap
        .timeline({ defaults: { ease: "expo.out" } })
        .from(q(".gate-char"), { yPercent: 105, rotateX: -75, autoAlpha: 0, duration: 1, stagger: 0.05 }, 0.2)
        .from(q(".gate-word"), { letterSpacing: "0.3em", duration: 1.4 }, 0.2)
        .from(q(".gate-cta"), { y: 20, autoAlpha: 0, duration: 0.9 }, 0.8);
    }, el);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={root} className="intro-gate-card flex h-full w-full flex-col items-center justify-center bg-[#02040b] px-5">
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

      <button
        type="button"
        onClick={onEnter}
        disabled={!armed}
        autoFocus
        className="gate-cta intro-button intro-button--primary intro-button--gate mt-10"
      >
        {armed ? "Enter the auction" : "Setting up the ground"}
      </button>
    </div>
  );
}
