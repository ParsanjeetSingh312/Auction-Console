/**
 * ScoutQuotaMeter.tsx
 * The free tier's SCOUT allowance, under the drawer's header: ten segments,
 * one per request in the window, and when the oldest frees up again.
 *
 * Shown only to the limited -- Free accounts and signed-out visitors
 * (console/scoutQuota.ts). GSAP pops a segment out as it is spent, so using
 * SCOUT visibly costs something; at zero the bar turns red and says when
 * the next request comes back.
 */
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import { refreshScoutQuota, untilReset, useScoutQuota } from "../../console/scoutQuota";

gsap.registerPlugin(useGSAP);

export default function ScoutQuotaMeter({ open }: { open: boolean }) {
  const quota = useScoutQuota();
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef<number | null>(null);
  const [, tick] = useState(0);

  // Read again whenever SCOUT opens; keep "resets in" current while it is.
  useEffect(() => {
    if (!open) return;
    void refreshScoutQuota();
    const timer = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const remaining = quota?.remaining ?? null;
  useGSAP(
    () => {
      if (remaining === null) return;
      const before = previous.current;
      previous.current = remaining;
      if (before === null || before === remaining) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      if (remaining < before) {
        // The segments just spent pop and fade.
        gsap.fromTo(
          `.quota-seg[data-i="${remaining}"]`,
          { scaleY: 1.9, opacity: 1 },
          { scaleY: 1, opacity: 1, duration: 0.5, ease: "back.out(3)", clearProps: "transform,opacity" },
        );
      } else {
        gsap.from(".quota-seg[data-on='true']", { scaleY: 0.2, stagger: 0.04, duration: 0.35, ease: "power2.out" });
      }
    },
    { scope: root, dependencies: [remaining] },
  );

  if (!quota?.limited || quota.limit === null || remaining === null) return null;

  const out = remaining === 0;
  const tone = out ? "#F87171" : remaining <= 3 ? "#FB923C" : "#22D3EE";

  return (
    <div ref={root} className="relative z-20 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-white/[0.08] bg-black/20 px-4 py-2 sm:px-5" data-testid="scout-quota">
      <span className="font-tech text-[10px] font-semibold uppercase tracking-[0.16em] text-auctiq-dim">Free tier</span>
      <div className="flex items-center gap-[3px]" aria-hidden>
        {Array.from({ length: quota.limit }, (_, i) => {
          const on = i < remaining;
          return (
            <span
              key={i}
              data-i={i}
              data-on={on}
              className="quota-seg h-[10px] w-[7px] rounded-[2px] transition-colors duration-300"
              style={{ background: on ? tone : "rgba(255,255,255,0.12)", boxShadow: on ? `0 0 6px ${tone}88` : "none" }}
            />
          );
        })}
      </div>
      <span className="font-ui text-[11.5px]" style={{ color: out ? tone : undefined }}>
        {out ? (
          <>Out of requests · more in {untilReset(quota.resets_at)}</>
        ) : (
          <>
            <b className="text-auctiq-text">{remaining}</b>
            <span className="text-auctiq-dim">
              {" "}
              of {quota.limit} left{quota.resets_at ? ` · next back in ${untilReset(quota.resets_at)}` : " · every 2 hours"}
            </span>
          </>
        )}
      </span>
      <span className="ml-auto hidden font-tech text-[10px] uppercase tracking-[0.14em] text-auctiq-dim sm:inline">
        Unlimited on Delegate and Auctioneer accounts
      </span>
    </div>
  );
}
