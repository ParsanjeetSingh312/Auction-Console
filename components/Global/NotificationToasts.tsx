/**
 * NotificationToasts.tsx
 * The popup: a notification sliding in at the top right the moment it
 * arrives, on every page, so a pass or a room opening is noticed without
 * anyone having to check the bell.
 *
 * Mounted once, in App, beside SCOUT. It shows the store's `fresh` queue
 * (ecosystemStore.ts) one popup at a time: the next waits until this one is
 * dismissed, claimed or times out, so they never pile up over the page.
 *
 *   Framer Motion  presence -- a spring in from the right, out to the right
 *                  as the next one comes in, swipe right to dismiss
 *   GSAP           what happens inside one -- the countdown bar (it pauses
 *                  while hovered), a light sweep over the card as it lands,
 *                  a pulse ring round the icon, and the pass's own intro
 *
 * A gift can be claimed right here; anything with a link can be opened.
 */
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ArrowRight, X } from "lucide-react";

import { dismissFresh, markRead, useEcosystem } from "../../console/ecosystemStore";
import type { Notice } from "../../console/ecosystemStore";
import AuctionPass from "../Passes/AuctionPass";
import { claimWithBurst } from "../Passes/claimBurst";
import { lookOf } from "./noticeStyle";

gsap.registerPlugin(useGSAP);


export default function NotificationToasts() {
  const { fresh } = useEcosystem();
  // Oldest first, so a burst of arrivals reads in the order it happened.
  const current = fresh[fresh.length - 1];
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-3 top-[140px] z-[80] flex w-[min(380px,calc(100vw-24px))] flex-col sm:right-6 sm:top-[76px]"
    >
      <AnimatePresence initial={false} mode="wait">
        {current && <Toast key={current.id} notice={current} waiting={fresh.length - 1} />}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

function Toast({ notice, waiting }: { notice: Notice; waiting: number }) {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<gsap.core.Tween | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const look = lookOf(notice);
  const Icon = look.icon;
  const gift = notice.gift?.status === "pending" ? notice.gift : null;
  const dismiss = () => dismissFresh(notice.id);

  useGSAP(
    () => {
      // Gifts wait longer: there is something to do.
      timer.current = gsap.fromTo(
        ".toast-timer",
        { scaleX: 1 },
        { scaleX: 0, duration: gift ? 14 : 8, ease: "none", transformOrigin: "left center", onComplete: dismiss },
      );
      if (reduce) return;
      gsap.fromTo(".toast-sweep", { xPercent: -120 }, { xPercent: 320, duration: 1.1, ease: "power2.inOut", delay: 0.25 });
      gsap.fromTo(
        ".toast-ring",
        { scale: 0.7, autoAlpha: 0.8 },
        { scale: 1.9, autoAlpha: 0, duration: 1.3, ease: "power2.out", repeat: 2, repeatDelay: 0.4, delay: 0.3 },
      );
    },
    { scope: root },
  );

  return (
    <motion.div
      ref={root}
      initial={reduce ? { opacity: 0 } : { opacity: 0, x: 140, scale: 0.92, rotate: 3 }}
      animate={{ opacity: 1, x: 0, scale: 1, rotate: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: 160, scale: 0.94, transition: { duration: 0.22 } }}
      transition={{ type: "spring", stiffness: 380, damping: 26, mass: 0.9 }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.05, right: 0.9 }}
      onDragEnd={(_, info) => {
        if (info.offset.x > 90 || info.velocity.x > 600) dismiss();
      }}
      onHoverStart={() => timer.current?.pause()}
      onHoverEnd={() => timer.current?.resume()}
      role="status"
      data-testid="toast"
      className="pointer-events-auto relative cursor-grab overflow-hidden rounded-[12px] border bg-[#0a0f1f]/95 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)] backdrop-blur-xl active:cursor-grabbing"
      style={{ borderColor: `${look.tone}66`, boxShadow: `0 0 0 1px ${look.tone}22, 0 0 28px -8px ${look.tone}88, 0 18px 50px -12px rgba(0,0,0,0.8)` }}
    >
      {/* The light that crosses the card as it lands. */}
      <span
        aria-hidden
        className="toast-sweep pointer-events-none absolute inset-y-0 left-0 w-1/3 -skew-x-12"
        style={{ background: `linear-gradient(90deg, transparent, ${look.tone}33, transparent)` }}
      />

      <div className="relative flex gap-3 p-3.5 pr-9">
        {gift ? (
          <div className="pt-0.5">
            <AuctionPass kind={gift.kind} size="sm" count={gift.quantity} intro tilt={false} />
          </div>
        ) : (
          <span className="relative mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full" style={{ color: look.tone }}>
            <span aria-hidden className="toast-ring absolute inset-0 rounded-full border-2" style={{ borderColor: look.tone }} />
            <span
              className="absolute inset-0 rounded-full"
              style={{ background: `${look.tone}22`, boxShadow: `inset 0 0 0 1px ${look.tone}66` }}
            />
            <Icon size={18} strokeWidth={2} className="relative" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="font-tech text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: look.tone }}>
            {look.eyebrow}
          </div>
          <p className="mt-0.5 font-ui text-[13.5px] font-medium leading-snug text-auctiq-text">{notice.title}</p>
          {notice.body && <p className="mt-0.5 line-clamp-2 font-ui text-[12px] leading-snug text-auctiq-dim">{notice.body}</p>}

          {(gift || notice.link) && (
            <div className="mt-2.5 flex items-center gap-2">
              {gift && (
                <button
                  type="button"
                  disabled={busy}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={async (event) => {
                    setBusy(true);
                    const refusal = await claimWithBurst(event.currentTarget, notice);
                    setBusy(false);
                    setError(refusal);
                    if (!refusal) setTimeout(dismiss, 450);
                  }}
                  className="rounded-[6px] px-3.5 py-1.5 font-tech text-[11px] font-bold uppercase tracking-[0.16em] text-auctiq-void transition-transform active:scale-95 disabled:opacity-60"
                  style={{
                    background: gift.kind === "A" ? "linear-gradient(180deg,#ffe7a3,#e3b23c)" : "linear-gradient(180deg,#cfe2ff,#4d8df6)",
                  }}
                >
                  {busy ? "Claiming…" : `Claim ${gift.quantity > 1 ? `×${gift.quantity}` : ""}`.trim()}
                </button>
              )}
              {notice.link && (
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    if (notice.id > 0) void markRead(notice.id);
                    dismiss();
                    navigate(notice.link!);
                  }}
                  className="flex items-center gap-1 rounded-[6px] border border-white/15 px-3 py-1.5 font-tech text-[11px] font-semibold uppercase tracking-[0.14em] text-auctiq-text transition-colors hover:border-white/40"
                >
                  Open <ArrowRight size={12} />
                </button>
              )}
            </div>
          )}
          {error && <p className="mt-1.5 font-ui text-[11.5px] text-auctiq-out">{error}</p>}
        </div>
      </div>

      <button
        type="button"
        aria-label="Dismiss"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={dismiss}
        className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full text-auctiq-dim transition-colors hover:bg-white/10 hover:text-auctiq-text"
      >
        <X size={14} />
      </button>

      {waiting > 0 && (
        <span className="absolute bottom-2 right-3 rounded-full bg-white/10 px-2 py-0.5 font-tech text-[9.5px] font-semibold uppercase tracking-[0.12em] text-auctiq-dim">
          +{waiting} more
        </span>
      )}

      {/* Time left before it tucks itself away. */}
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-white/[0.06]">
        <span className="toast-timer block h-full w-full" style={{ background: look.tone }} />
      </span>
    </motion.div>
  );
}
