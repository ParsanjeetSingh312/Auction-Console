/**
 * DrawIndicator.tsx
 * Online, between lots: the room is about to draw the next player at random.
 *
 * Shown in the auctioneer's live pane while the block is empty and a draw is
 * due (`next_draw_at`). A small deck shuffles (GSAP) and the seconds count
 * down, so the pause after a sale reads as the room working, not as stalled.
 */
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Shuffle } from "lucide-react";

import type { AuctionSocket } from "../../../hooks/useAuctionSocket";

gsap.registerPlugin(useGSAP);

export default function DrawIndicator({ socket }: { socket: AuctionSocket }) {
  const state = socket.state;
  const due = state?.next_draw_at ?? null;
  const showing = !!state && state.draw === "random" && state.phase === "live" && !state.lot;
  const [now, setNow] = useState(() => Date.now() / 1000);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showing) return;
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 250);
    return () => window.clearInterval(timer);
  }, [showing]);

  useGSAP(
    () => {
      if (!showing) return;
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        gsap.to(".draw-card", {
          x: (i: number) => [-14, 0, 14][i],
          rotation: (i: number) => [-10, 0, 10][i],
          duration: 0.28,
          ease: "power2.inOut",
          yoyo: true,
          repeat: -1,
          stagger: 0.09,
        });
      });
    },
    { scope: root, dependencies: [showing] },
  );

  if (!showing) return null;
  const left = due ? Math.max(0, Math.ceil(due - now)) : null;

  return (
    <div
      ref={root}
      className="flex items-center gap-4 rounded-xl border border-line bg-surface-card px-4 py-3 shadow-soft"
      role="status"
      data-testid="draw-indicator"
    >
      <div className="relative h-10 w-12" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="draw-card absolute left-3 top-0 h-10 w-7 rounded-[4px] border border-[#22D3EE]/60 bg-gradient-to-br from-[#0a2e78] to-[#1d4fbf] shadow"
          />
        ))}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 font-ui text-[11px] font-semibold uppercase tracking-[0.14em] text-[#22D3EE]">
          <Shuffle size={13} /> Drawing at random
        </div>
        <div className="mt-0.5 font-ui text-[12.5px] text-slate-body">
          {left === null ? "Next player shortly" : left > 0 ? `Next player in ${left}s` : "Next player now"}
        </div>
      </div>
    </div>
  );
}
