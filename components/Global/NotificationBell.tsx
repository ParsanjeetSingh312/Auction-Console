/**
 * NotificationBell.tsx
 * The bell at the top right, beside the account.
 *
 * Signed in only. The badge counts what is unread; the panel lists it, newest
 * first, with gifts drawn as the pass they carry and a Claim button that
 * moves it into the wallet. The two passes at the top of the panel are the
 * wallet itself.
 *
 * Motion is split by job. Framer Motion owns presence and layout -- the panel
 * opening, the badge popping, rows settling as a claim changes them. GSAP
 * owns the bell itself: it rings when the unread count goes up and when a
 * claimed pass lands in it (claimBurst.ts's WALLET_PULSE).
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Bell } from "lucide-react";

import { useAccount } from "../../console/accountStore";
import { markAllRead, markRead, useEcosystem } from "../../console/ecosystemStore";
import type { Notice } from "../../console/ecosystemStore";
import AuctionPass from "../Passes/AuctionPass";
import { WALLET_PULSE, claimWithBurst } from "../Passes/claimBurst";
import { ago, expiresIn, lookOf } from "./noticeStyle";

gsap.registerPlugin(useGSAP);

export default function NotificationBell() {
  const { account } = useAccount();
  const { ready, items, unread, balances } = useEcosystem();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const bell = useRef<HTMLSpanElement>(null);
  const previous = useRef(unread);
  const reduce = useReducedMotion();

  const { contextSafe } = useGSAP({ scope: root });

  const ring = contextSafe(() => {
    if (reduce || !bell.current) return;
    gsap
      .timeline()
      .to(bell.current, {
        keyframes: { rotation: [0, -22, 18, -12, 8, -4, 0] },
        transformOrigin: "50% 8%",
        duration: 0.9,
        ease: "power1.inOut",
      })
      .fromTo(
        ".bell-wave",
        { scale: 0.6, autoAlpha: 0.7 },
        { scale: 2.1, autoAlpha: 0, duration: 0.8, ease: "power2.out", stagger: 0.18 },
        0,
      );
  });

  // Ring when something new arrives (not on the first load).
  useEffect(() => {
    if (ready && unread > previous.current) ring();
    previous.current = unread;
  }, [ready, unread, ring]);

  // ...and when a claimed pass lands in the bell.
  useEffect(() => {
    const onPulse = () => ring();
    window.addEventListener(WALLET_PULSE, onPulse);
    return () => window.removeEventListener(WALLET_PULSE, onPulse);
  }, [ring]);

  // Close on a click elsewhere, and on Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!account) return null;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-testid="nav-bell"
        data-wallet-target
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="relative grid h-[38px] w-[38px] place-items-center rounded-[8px] border border-white/15 bg-auctiq-void/70 text-auctiq-text backdrop-blur-sm transition-colors duration-200 hover:border-white/35"
      >
        <span aria-hidden className="bell-wave pointer-events-none absolute inset-1 rounded-full border border-auctiq-gold/70 opacity-0" />
        <span aria-hidden className="bell-wave pointer-events-none absolute inset-1 rounded-full border border-auctiq-gold/50 opacity-0" />
        <span ref={bell} className="grid place-items-center">
          <Bell size={17} strokeWidth={1.8} />
        </span>
        <AnimatePresence>
          {unread > 0 && (
            <motion.span
              key={unread}
              initial={reduce ? false : { scale: 0.2, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.2, opacity: 0 }}
              transition={{ type: "spring", stiffness: 520, damping: 18 }}
              className="absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[#ef4444] px-1 font-num text-[11px] font-bold leading-none text-white shadow-[0_0_0_2px_#020617,0_0_12px_rgba(239,68,68,0.7)]"
            >
              {unread > 99 ? "99+" : unread}
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Notifications"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            style={{ transformOrigin: "top right" }}
            className="fixed inset-x-3 top-[64px] z-50 overflow-hidden rounded-[12px] border border-white/12 bg-[#0a0f1f]/95 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] backdrop-blur-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+8px)] sm:w-[400px]"
          >
            <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <h2 className="font-tech text-[12px] font-semibold uppercase tracking-[0.16em] text-auctiq-text">
                Notifications
              </h2>
              <button
                type="button"
                onClick={() => void markAllRead()}
                disabled={unread === 0}
                className="font-tech text-[11px] uppercase tracking-[0.12em] text-neon-cyan transition-opacity disabled:opacity-35"
              >
                Mark all read
              </button>
            </header>

            {/* The wallet. */}
            <div className="flex items-center gap-4 border-b border-white/10 bg-white/[0.02] px-4 py-3">
              <AuctionPass kind="A" size="xs" count={balances.A} tilt={false} />
              <AuctionPass kind="D" size="xs" count={balances.D} tilt={false} />
              <div className="ml-1 min-w-0">
                <div className="font-tech text-[10.5px] uppercase tracking-[0.16em] text-auctiq-dim">Your wallet</div>
                <div className="font-ui text-[12.5px] text-auctiq-text">
                  <span className="text-auctiq-gold">{balances.A} gold</span> ·{" "}
                  <span className="text-[#93BBFF]">{balances.D} blue</span>
                </div>
              </div>
            </div>

            <motion.ul
              className="max-h-[min(62vh,520px)] overflow-y-auto overscroll-contain"
              initial="hidden"
              animate="show"
              variants={{ show: { transition: { staggerChildren: reduce ? 0 : 0.04 } } }}
            >
              {items.length === 0 && (
                <li className="px-4 py-10 text-center font-ui text-[13px] text-auctiq-dim">
                  Nothing yet. Passes, rooms and news land here.
                </li>
              )}
              {items.map((notice) => (
                <Row key={notice.id} notice={notice} onOpen={() => setOpen(false)} />
              ))}
            </motion.ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Row({ notice, onOpen }: { notice: Notice; onOpen: () => void }) {
  const navigate = useNavigate();
  const look = lookOf(notice);
  const Icon = look.icon;
  const gift = notice.gift;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const claimable = gift?.status === "pending";

  const follow = () => {
    void markRead(notice.id);
    if (notice.link) {
      onOpen();
      navigate(notice.link);
    }
  };

  return (
    <motion.li
      layout
      variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }}
      className="relative border-b border-white/[0.06] last:border-b-0"
    >
      {!notice.read && (
        <span aria-hidden className="absolute left-0 top-0 h-full w-[3px]" style={{ background: look.tone }} />
      )}
      <div
        role={notice.link ? "link" : undefined}
        tabIndex={notice.link ? 0 : undefined}
        onClick={follow}
        onKeyDown={(event) => event.key === "Enter" && follow()}
        className={`flex gap-3 px-4 py-3 transition-colors ${notice.link ? "cursor-pointer hover:bg-white/[0.04]" : ""}`}
      >
        <span
          className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full"
          style={{ background: `${look.tone}1f`, color: look.tone, boxShadow: `inset 0 0 0 1px ${look.tone}55` }}
        >
          <Icon size={15} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-tech text-[10px] uppercase tracking-[0.16em]" style={{ color: look.tone }}>
              {look.eyebrow}
            </span>
            <span className="shrink-0 font-ui text-[10.5px] text-auctiq-dim">{ago(notice.created_at)}</span>
          </div>
          <p className={`mt-0.5 font-ui text-[13px] leading-snug ${notice.read ? "text-auctiq-text/75" : "text-auctiq-text"}`}>
            {notice.title}
          </p>
          {notice.body && <p className="mt-0.5 font-ui text-[12px] leading-snug text-auctiq-dim">{notice.body}</p>}

          {gift && (
            <div className="mt-2.5 flex items-center gap-3">
              <AuctionPass kind={gift.kind} size="sm" count={gift.quantity} tilt={false} />
              <div className="flex min-w-0 flex-col items-start gap-1">
                {claimable ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async (event) => {
                        event.stopPropagation();
                        setBusy(true);
                        setError(await claimWithBurst(event.currentTarget, notice));
                        setBusy(false);
                      }}
                      className="rounded-[6px] px-3.5 py-1.5 font-tech text-[11px] font-bold uppercase tracking-[0.16em] text-auctiq-void transition-transform active:scale-95 disabled:opacity-60"
                      style={{ background: gift.kind === "A" ? "linear-gradient(180deg,#ffe7a3,#e3b23c)" : "linear-gradient(180deg,#cfe2ff,#4d8df6)" }}
                    >
                      {busy ? "Claiming…" : "Claim"}
                    </button>
                    <span className="font-ui text-[10.5px] text-auctiq-dim">{expiresIn(gift.expires_at)}</span>
                  </>
                ) : (
                  <span className="font-tech text-[11px] uppercase tracking-[0.14em] text-auctiq-dim">
                    {gift.status === "claimed" ? "✓ In your wallet" : "Returned to sender"}
                  </span>
                )}
                {error && <span className="font-ui text-[11px] text-auctiq-out">{error}</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.li>
  );
}
