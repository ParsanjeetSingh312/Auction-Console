/**
 * ModeSwitch.tsx
 * How the room runs, chosen by its auctioneer before the auction starts:
 *
 *   Online   franchises bid on their screens, on the clock, and the room
 *            draws every player at random
 *   Offline  franchises raise placards in the room; no clock, and the
 *            auctioneer logs each sale
 *
 * and, online, who holds the chair: a person, or the AI auctioneer.
 *
 * Editable only in the lobby and the waiting room (the server refuses it
 * after the start); from then on it is a badge saying what the room is.
 * Framer Motion slides the selection between options.
 */
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { Bot, Hand, Radio, UserRound } from "lucide-react";

import type { AuctionSocket, AuctioneerKind, RoomMode } from "../../../hooks/useAuctionSocket";

/** The AI auctioneer is offered for online rooms. */
export const AI_AUCTIONEER_READY = true;

export default function ModeSwitch({ socket, compact = false }: { socket: AuctionSocket; compact?: boolean }) {
  const state = socket.state;
  const reduce = useReducedMotion();
  if (!state) return null;

  const mode: RoomMode = state.rules.mode ?? "online";
  const chair: AuctioneerKind = state.rules.auctioneer ?? "manual";
  const editable =
    socket.seat?.role === "auctioneer" &&
    (state.phase === "lobby" || state.phase === "waiting") &&
    (state.supports?.includes("set_mode") ?? false);

  if (!editable) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-sunken px-2.5 py-1 font-ui text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-body"
        title={mode === "offline" ? "Placards in the room; the auctioneer logs each sale" : "Bids on screen; players drawn at random"}
        data-testid="mode-badge"
      >
        {mode === "offline" ? <Hand size={12} /> : <Radio size={12} />}
        {mode === "offline" ? "Offline" : "Online"}
        {mode === "online" && (
          <span className="text-slate-faint">· {chair === "ai" ? "AI auctioneer" : "manual"}</span>
        )}
      </span>
    );
  }

  const option = (active: boolean) =>
    `relative z-0 flex items-center gap-1.5 rounded-md px-2.5 py-1 font-ui text-[10.5px] font-semibold uppercase tracking-[0.1em] transition-colors ${
      active ? "text-white" : "text-slate-muted hover:text-slate-ink"
    }`;
  const pill = (id: string) => (
    <motion.span
      layoutId={id}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 36 }}
      className="absolute inset-0 -z-10 rounded-md bg-slate-ink"
    />
  );

  return (
    <LayoutGroup id="mode-switch">
      <div className={`flex flex-wrap items-center gap-2 ${compact ? "" : ""}`} data-testid="mode-switch">
        <div className="flex items-center gap-1 rounded-lg border border-line bg-surface-sunken p-1" role="radiogroup" aria-label="How the room runs">
          {(["online", "offline"] as RoomMode[]).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => socket.setMode(value, value === "offline" ? "manual" : chair)}
              className={option(mode === value)}
              title={
                value === "online"
                  ? "Bids on screen, on the clock. Players are drawn at random."
                  : "Placards in the room. No clock: you log each sale."
              }
            >
              {mode === value && pill("mode-pill")}
              {value === "online" ? <Radio size={12} /> : <Hand size={12} />}
              {value}
            </button>
          ))}
        </div>
        {mode === "online" && (
          <div className="flex items-center gap-1 rounded-lg border border-line bg-surface-sunken p-1" role="radiogroup" aria-label="Who runs the room">
            {(["manual", "ai"] as AuctioneerKind[]).map((value) => {
              const disabled = value === "ai" && !AI_AUCTIONEER_READY;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={chair === value}
                  disabled={disabled}
                  onClick={() => socket.setMode("online", value)}
                  className={`${option(chair === value)} disabled:cursor-not-allowed disabled:opacity-40`}
                  title={disabled ? "The AI auctioneer arrives in the next step" : value === "ai" ? "The AI auctioneer judges the room" : "You judge the room"}
                >
                  {chair === value && pill("chair-pill")}
                  {value === "ai" ? <Bot size={12} /> : <UserRound size={12} />}
                  {value === "ai" ? "AI" : "Manual"}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </LayoutGroup>
  );
}
