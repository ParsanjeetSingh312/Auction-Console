/**
 * AiCallStrip.tsx
 * The AI auctioneer's latest call, on every bidder's screen: a strip under
 * the block's header, in the page's flow so it never covers the lot or the
 * clock (BlockView's `banner`). The line is typed out as it arrives (GSAP),
 * the verdict on a sale beside it; it slides in and out with Framer Motion.
 *
 * Only in a room the AI auctioneer is running, and only while it is not
 * paused: a paused auctioneer says nothing, so the strip goes.
 */
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import type { AuctionSocket } from "../../../hooks/useAuctionSocket";
import { AiEmblem, KIND_LABEL, VERDICT, useTypewriter } from "./aiLook";

export default function AiCallStrip({ socket }: { socket: AuctionSocket }) {
  const state = socket.state;
  const reduce = useReducedMotion();
  const feed = state?.auctioneer_feed ?? [];
  const latest = feed[feed.length - 1];
  const typed = useTypewriter(latest?.text ?? "", latest?.id ?? 0);
  const show = !!state?.ai?.active && !state.ai.paused && !!latest;
  const verdict = latest?.verdict ? VERDICT[latest.verdict] : null;

  return (
    <AnimatePresence>
      {show && latest && (
        <motion.div
          key="ai-strip"
          initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0, y: -8 }}
          animate={{ opacity: 1, height: "auto", y: 0 }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ type: "spring", stiffness: 360, damping: 32 }}
          className="mx-auto flex max-w-3xl items-center gap-3 overflow-hidden rounded-xl border border-[#F6C45A]/40 bg-[#0a0f1f]/92 px-3 py-2.5"
          role="status"
          aria-live="polite"
          data-testid="ai-call-strip"
        >
          <AiEmblem status={state?.ai?.status ?? "presiding"} paused={false} size={34} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[#F6C45A]">
              AI auctioneer · {KIND_LABEL[latest.kind]}
              {verdict && (
                <span className="rounded-full px-1.5 py-px font-bold tracking-[0.12em] text-[#020617]" style={{ background: verdict.tone }}>
                  {verdict.label}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[13px] text-white sm:whitespace-normal sm:[overflow-wrap:anywhere]">{typed}</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
