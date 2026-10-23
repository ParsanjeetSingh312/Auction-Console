/**
 * AiAuctioneerCard.tsx
 * The AI auctioneer, in the chair's live pane: what it is doing, its latest
 * call spoken onto the screen, the calls before it, and the controls the
 * human in the chair keeps -- pause, resume, take over.
 *
 * Shown only in an online room whose chair is AI (`state.ai.active`).
 * Framer Motion settles the list as calls arrive; GSAP types the newest one
 * and animates the emblem (aiLook.tsx).
 */
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Pause, Play, UserRound } from "lucide-react";

import type { AuctionSocket } from "../../../hooks/useAuctionSocket";
import { AiEmblem, KIND_LABEL, VERDICT, useTypewriter } from "./aiLook";

export default function AiAuctioneerCard({ socket }: { socket: AuctionSocket }) {
  const state = socket.state;
  const reduce = useReducedMotion();
  const [confirming, setConfirming] = useState(false);
  const ai = state?.ai;
  const feed = state?.auctioneer_feed ?? [];
  const latest = feed[feed.length - 1];
  const typed = useTypewriter(latest?.text ?? "", latest?.id ?? 0);

  if (!state || !ai?.active) return null;
  const status = ai.paused ? "Paused" : ai.status === "thinking" ? "Thinking over the call" : "Presiding";
  const verdict = latest?.verdict ? VERDICT[latest.verdict] : null;
  const earlier = feed.slice(-5, -1).reverse();

  return (
    <motion.section
      layout
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-xl border border-[#F6C45A]/35 bg-surface-card p-4 shadow-soft"
      aria-label="AI auctioneer"
      data-testid="ai-auctioneer-card"
    >
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_60%_at_0%_0%,rgba(246,196,90,0.10),transparent_70%)]" />

      <header className="relative flex items-center gap-3">
        <AiEmblem status={ai.status} paused={ai.paused} />
        <div className="min-w-0 flex-1">
          <div className="font-head text-[13px] font-bold tracking-[0.12em] text-slate-ink">AI AUCTIONEER</div>
          <div className="mt-0.5 font-ui text-[10.5px] uppercase tracking-[0.12em] text-slate-faint" aria-live="polite">
            {status}
          </div>
        </div>
        <button
          type="button"
          onClick={() => socket.aiControl(ai.paused ? "resume" : "pause")}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body hover:text-slate-ink"
          title={ai.paused ? "Let the AI auctioneer call the room again" : "Silence the AI auctioneer for now; the room runs on"}
        >
          {ai.paused ? <Play size={12} /> : <Pause size={12} />}
          {ai.paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              window.setTimeout(() => setConfirming(false), 4000);
              return;
            }
            socket.aiControl("take_over");
          }}
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] ${
            confirming ? "border-[#FB923C] text-[#FB923C]" : "border-line text-slate-body hover:text-slate-ink"
          }`}
          title="Run the rest of this auction yourself. The AI does not come back mid-auction."
        >
          <UserRound size={12} />
          {confirming ? "Press again" : "Take over"}
        </button>
      </header>

      <div className="relative mt-4 min-h-[76px]">
        {latest ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-ui text-[10px] font-semibold uppercase tracking-[0.16em] text-[#F6C45A]">
                {KIND_LABEL[latest.kind]}
                {latest.player && latest.kind !== "summary" ? ` · ${latest.player}` : ""}
              </span>
              {verdict && (
                <motion.span
                  key={`v-${latest.id}`}
                  initial={reduce ? false : { scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 22, delay: 0.4 }}
                  className="rounded-full px-2 py-0.5 font-ui text-[10px] font-bold uppercase tracking-[0.12em] text-[#020617]"
                  style={{ background: verdict.tone }}
                  data-testid="ai-verdict"
                >
                  {verdict.label}
                </motion.span>
              )}
            </div>
            <p className="mt-1.5 font-head text-[16px] font-semibold leading-snug text-slate-ink" data-testid="ai-latest">
              “{typed}
              {typed.length < latest.text.length && <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-[#F6C45A] align-middle" />}”
            </p>
            {latest.sources && latest.sources.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {latest.sources.map((source) => (
                  <span key={source} className="rounded border border-line px-1.5 py-0.5 font-ui text-[9.5px] uppercase tracking-[0.1em] text-slate-faint">
                    {source}
                  </span>
                ))}
                {latest.source === "template" && (
                  <span className="rounded border border-line px-1.5 py-0.5 font-ui text-[9.5px] uppercase tracking-[0.1em] text-slate-faint" title="No model answered in time; the room's own words">
                    standard call
                  </span>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="font-ui text-[12.5px] leading-relaxed text-slate-muted">
            The AI auctioneer will announce every player as he is drawn, call every result with the room's verdict, and
            close the auction with a summary.
          </p>
        )}
      </div>

      {earlier.length > 0 && (
        <ul className="relative mt-3 space-y-1.5 border-t border-line pt-3">
          <AnimatePresence initial={false} mode="popLayout">
            {earlier.map((call) => (
              <motion.li
                key={call.id}
                layout
                initial={reduce ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0 }}
                className="flex gap-2 font-ui text-[11.5px] leading-snug text-slate-muted"
              >
                <span className="w-[62px] shrink-0 font-semibold uppercase tracking-[0.08em] text-slate-faint">
                  {KIND_LABEL[call.kind]}
                </span>
                <span className="min-w-0 flex-1">{call.text}</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </motion.section>
  );
}
