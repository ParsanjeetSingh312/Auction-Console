/**
 * aiLook.tsx
 * Shared pieces of the AI auctioneer's look: its emblem, the typewriter that
 * speaks each new call onto the screen (GSAP), and the colour of a verdict.
 */
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useReducedMotion } from "framer-motion";

import type { AuctioneerCall } from "../../../hooks/useAuctionSocket";

gsap.registerPlugin(useGSAP);

/** The room's ruling, as a colour and a label. */
export const VERDICT: Record<string, { tone: string; label: string }> = {
  steal: { tone: "#34D399", label: "Steal" },
  "good bid": { tone: "#22D3EE", label: "Good bid" },
  "fair price": { tone: "#F6C45A", label: "Fair price" },
  "paid over": { tone: "#FB923C", label: "Paid over" },
};

export const KIND_LABEL: Record<AuctioneerCall["kind"], string> = {
  announce: "On the block",
  sold: "Sold",
  unsold: "Unsold",
  summary: "The close",
};

/**
 * `text`, typed out a few characters at a time when it changes -- the latest
 * call arriving as if spoken. Reduced motion shows it whole at once.
 */
export function useTypewriter(text: string, key: string | number): string {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(text);
  const first = useRef(true);
  useEffect(() => {
    if (reduce || first.current) {
      // The first call on screen is history, not news: show it whole.
      first.current = false;
      setShown(text);
      return;
    }
    const counter = { n: 0 };
    const duration = Math.min(2.4, 0.4 + text.length * 0.018);
    const tween = gsap.to(counter, {
      n: text.length,
      duration,
      ease: "none",
      onUpdate: () => setShown(text.slice(0, Math.round(counter.n))),
    });
    // GSAP runs on animation frames, which a background tab does not get:
    // make sure the whole line is there regardless.
    const settle = window.setTimeout(() => setShown(text), duration * 1000 + 250);
    return () => {
      tween.kill();
      window.clearTimeout(settle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reduce]);
  return shown;
}

/**
 * The AI auctioneer's emblem: a gavel inside a ring. The ring breathes while
 * it presides and spins while it thinks over a call (GSAP).
 */
export function AiEmblem({ status, paused, size = 44 }: { status: string; paused: boolean; size?: number }) {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        if (paused) return;
        if (status === "thinking") {
          gsap.to(".ai-ring", { rotation: 360, duration: 1.4, ease: "none", repeat: -1, transformOrigin: "50% 50%" });
        } else {
          gsap.to(".ai-ring", { scale: 1.08, opacity: 0.55, duration: 1.6, ease: "sine.inOut", yoyo: true, repeat: -1, transformOrigin: "50% 50%" });
        }
      });
    },
    { scope: root, dependencies: [status, paused], revertOnUpdate: true },
  );
  const tone = paused ? "#94A3B8" : status === "thinking" ? "#22D3EE" : "#F6C45A";
  return (
    <div ref={root} className="relative shrink-0" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 48 48" className="h-full w-full overflow-visible">
        <circle className="ai-ring" cx="24" cy="24" r="21" fill="none" stroke={tone} strokeWidth="2"
          strokeDasharray={status === "thinking" && !paused ? "30 12" : undefined} />
        <circle cx="24" cy="24" r="16" fill={`${tone}22`} />
        <g transform="translate(24 24) rotate(-35)" fill={tone}>
          <rect x="-9" y="-5" width="13" height="7" rx="1.5" />
          <rect x="2" y="-2.2" width="10" height="2.6" rx="1.2" />
        </g>
        <rect x="14" y="31" width="16" height="3" rx="1.5" fill={tone} opacity="0.8" />
      </svg>
    </div>
  );
}
