/**
 * BreakBanner.tsx
 * "The auction is paused", on every screen in the room.
 *
 * Shown while the room reports a break (`state.break`). It sits over the top
 * of the screen and does not cover it: a break is when people look at the
 * leaderboard, their squad and what is left in the pool, so the screen behind
 * stays fully usable. What it must do is make it impossible to miss that the
 * clock is stopped -- for a franchise wondering why the bid button is dead as
 * much as for the auctioneer.
 *
 * The auctioneer's copy carries the Resume button. Everyone else's does not;
 * the room would refuse it anyway.
 *
 * Portalled to the body so it is not clipped or re-stacked by whichever
 * screen mounted it, and it carries `.console-dark` itself for the same
 * reason the setup form does.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Coffee, Play } from "lucide-react";

import type { AuctionSocket } from "../../../hooks/useAuctionSocket";

gsap.registerPlugin(useGSAP);

function elapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

export default function BreakBanner({ socket }: { socket: AuctionSocket }) {
  const pause = socket.state?.break ?? null;
  const root = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    if (!pause) return;
    setNow(Date.now() / 1000);
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [pause]);

  useGSAP(
    () => {
      if (!pause) return;
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(root.current, { y: -40, opacity: 0, duration: 0.5, ease: "back.out(1.6)" });
        gsap.to(".break-cup", { rotation: 8, duration: 1.1, ease: "sine.inOut", yoyo: true, repeat: -1 });
      });
    },
    { scope: root, dependencies: [!!pause] },
  );

  if (!pause) return null;
  const isAuctioneer = socket.seat?.role === "auctioneer";

  return createPortal(
    <div
      /* The auctioneer's panel has room at the top. A franchise's block puts the
         player's name there, so its banner sits low, over the bid controls a
         break has switched off anyway. */
      className={`console-dark pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-3 ${
        isAuctioneer ? "top-3" : "bottom-[132px]"
      }`}
    >
      <div
        ref={root}
        role="status"
        aria-live="assertive"
        data-testid="break-banner"
        style={{ backgroundColor: "#1A1405" }}
        className="pointer-events-auto flex w-full max-w-[760px] items-center gap-4 rounded-2xl border-2 border-[#F6C45A] px-5 py-3.5 shadow-2xl"
      >
        <span className="break-cup grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#F6C45A] text-[#020617]">
          <Coffee size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-head text-[17px] font-extrabold uppercase tracking-[0.1em] text-[#F6C45A]">
            Auction paused · break
          </div>
          <div className="mt-0.5 font-ui text-[12.5px] leading-snug text-slate-body">
            {pause.note ? `${pause.note.replace(/[.!?]+$/, "")}.` : "The auctioneer has paused the auction."} The clock is stopped and bidding reopens when the
            auction resumes.
          </div>
        </div>
        <div className="text-right">
          <div className="font-num text-[24px] font-bold leading-none text-slate-ink">{elapsed(now - pause.since)}</div>
          <div className="mt-0.5 font-ui text-[9.5px] uppercase tracking-[0.12em] text-slate-faint">on break</div>
        </div>
        {isAuctioneer && (
          <button
            type="button"
            onClick={socket.endBreak}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#34D399] px-3.5 py-2 font-ui text-[11px] font-bold uppercase tracking-[0.1em] text-[#020617] hover:opacity-90"
          >
            <Play size={13} /> Resume
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
