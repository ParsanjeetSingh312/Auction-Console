/**
 * RunSheet.tsx
 * How the room is being run right now, in the auctioneer's live pane.
 *
 * Three controls that work together, which is the point of putting them in
 * one card:
 *
 *   The chair     AI or Manual, switchable at any moment. The AI brings
 *                 players up by itself, following the auction flow; in Manual
 *                 the auctioneer brings each one up -- a named player from the
 *                 pool, or the next one with a single press here.
 *   The flow      the tiers in the order set in Auction Setup, with how many
 *                 players each still has to come.
 *   A lot         "we have had enough batters": pick a role, randomise, and
 *                 only that role comes up next, in the flow's order. Works in
 *                 either chair.
 *
 * And the break: pause the auction for everyone, and resume it.
 *
 * Every button sends an intent; the room decides and its next broadcast is
 * what changes this card. GSAP runs the entrance and the lot shuffle.
 */
import { useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Bot, Coffee, Play, Shuffle, SkipForward, UserRound, X } from "lucide-react";

import type { AuctionSocket } from "../../../hooks/useAuctionSocket";
import { TIER_TONE } from "./AuctionSetupForm";

gsap.registerPlugin(useGSAP);

const LOT_SIZES = [4, 6, 10] as const;

export default function RunSheet({ socket }: { socket: AuctionSocket }) {
  const state = socket.state;
  const root = useRef<HTMLDivElement>(null);
  const [category, setCategory] = useState("BOWL");
  const [size, setSize] = useState<number>(6);
  const [note, setNote] = useState("");
  const [askingBreak, setAskingBreak] = useState(false);

  useGSAP(
    () => {
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(root.current, { y: 10, opacity: 0, duration: 0.35, ease: "power2.out" });
      });
    },
    { scope: root },
  );

  if (!state || state.rules.mode === "offline") return null;
  // A server that predates this card sends none of what it shows.
  if (!state.supports?.includes("draw_next")) return null;

  const live = state.phase === "live";
  const ai = state.rules.auctioneer === "ai";
  const onBreak = !!state.break;
  const plan = state.lot_plan ?? null;
  const tiers = state.flow ?? [];
  const categories = state.setup_options?.lot_categories ?? [];
  const lot = state.lot;
  const canDraw = live && !ai && !lot && !onBreak;

  const shuffle = () => {
    socket.generateLot(category, size);
    gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(
        root.current?.querySelectorAll(".lot-chip") ?? [],
        { rotation: -6, y: -3 },
        { rotation: 0, y: 0, duration: 0.45, ease: "back.out(3)", stagger: 0.04 },
      );
    });
  };

  const seg = (active: boolean) =>
    `flex items-center gap-1.5 rounded-md px-3 py-1.5 font-ui text-[10.5px] font-bold uppercase tracking-[0.1em] transition-colors ${
      active ? "bg-[#22D3EE] text-[#020617]" : "text-slate-muted hover:text-slate-ink"
    }`;
  const quiet =
    "inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <section
      ref={root}
      className="rounded-xl border border-line bg-surface-card p-4 shadow-soft"
      aria-label="How the room is run"
      data-testid="run-sheet"
    >
      {/* ---------------------------------------------------- the chair */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-ui text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-faint">
            Who brings players up
          </div>
          <div className="mt-0.5 font-ui text-[12px] leading-snug text-slate-body">
            {ai
              ? "The AI auctioneer, following the auction flow. Take over whenever you want to steer."
              : "You do: put a player up from the pool, or press Next player. Hand back to the AI at any time."}
          </div>
        </div>
        <div
          className="flex items-center gap-1 rounded-lg border border-line bg-surface-sunken p-1"
          role="radiogroup"
          aria-label="Who brings players up"
          data-testid="chair-switch"
        >
          <button
            type="button"
            role="radio"
            aria-checked={ai}
            onClick={() => !ai && socket.aiControl("hand_back")}
            className={seg(ai)}
            title="The AI auctioneer brings players up by itself and calls each result"
          >
            <Bot size={13} /> AI
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!ai}
            onClick={() => ai && socket.aiControl("take_over")}
            className={seg(!ai)}
            title="You bring each player up yourself"
          >
            <UserRound size={13} /> Manual
          </button>
        </div>
      </div>

      {/* --------------------------------------------- manual: next player */}
      {!ai && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!canDraw}
            onClick={socket.drawNext}
            data-testid="draw-next"
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#F6C45A] px-3.5 py-2 font-ui text-[11px] font-bold uppercase tracking-[0.1em] text-[#020617] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SkipForward size={13} />
            {plan ? `Next of the ${plan.label} lot` : "Next player"}
          </button>
          <span className="font-ui text-[11px] text-slate-muted">
            {!live
              ? "Available once the auction starts."
              : onBreak
                ? "Paused for a break."
                : lot
                  ? "Settle the player on the block first."
                  : plan
                    ? `${plan.left} of ${plan.total} still to come in this lot.`
                    : "Picks the next player by the auction flow."}
          </span>
        </div>
      )}

      {/* ------------------------------------------------------- the flow */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="font-ui text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-faint">
            Auction flow
          </span>
          {lot?.tier && (
            <span className="font-ui text-[10px] uppercase tracking-[0.1em] text-slate-muted">
              on the block:{" "}
              <b style={{ color: TIER_TONE[lot.tier] ?? undefined }}>
                {tiers.find((tier) => tier.key === lot.tier)?.label ?? lot.tier}
              </b>
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" data-testid="flow-strip">
          {tiers.map((tier, index) => {
            const tone = TIER_TONE[tier.key] ?? "#94A3B8";
            const done = tier.total ? 1 - tier.left / tier.total : 0;
            return (
              <div
                key={tier.key}
                className="rounded-lg border border-line bg-surface-sunken px-2.5 py-2"
                style={lot?.tier === tier.key ? { borderColor: tone } : undefined}
                title={tier.blurb}
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="font-num text-[13px] font-bold text-slate-faint">{index + 1}</span>
                  <span className="font-head text-[11.5px] font-bold uppercase tracking-[0.08em]" style={{ color: tone }}>
                    {tier.label}
                  </span>
                  <span className="ml-auto font-num text-[12px] font-semibold text-slate-body">
                    {tier.left}
                    <span className="text-slate-faint">/{tier.total}</span>
                  </span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full" style={{ width: `${done * 100}%`, backgroundColor: tone }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* --------------------------------------------------- generate a lot */}
      <div className="mt-4 rounded-lg border border-dashed border-line p-3" data-testid="lot-generator">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-ui text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-faint">
            Generate a lot
          </span>
          {plan && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#F6C45A]/15 px-2.5 py-0.5 font-ui text-[10.5px] font-bold uppercase tracking-[0.08em] text-[#F6C45A]">
              {plan.label} lot running · {plan.left} of {plan.total} left
              <button type="button" onClick={socket.clearLot} aria-label="Clear the lot" title="Clear the lot and return to the auction flow">
                <X size={12} />
              </button>
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {categories.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={category === option.key}
              onClick={() => setCategory(option.key)}
              className={`lot-chip rounded-full border px-2.5 py-1 font-ui text-[11px] font-semibold transition-colors ${
                category === option.key
                  ? "border-[#22D3EE] text-[#22D3EE]"
                  : "border-line text-slate-body hover:text-slate-ink"
              }`}
            >
              {option.label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />
          {LOT_SIZES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={size === value}
              onClick={() => setSize(value)}
              className={`rounded-md border px-2 py-1 font-num text-[12px] font-bold transition-colors ${
                size === value ? "border-[#22D3EE] text-[#22D3EE]" : "border-line text-slate-muted hover:text-slate-ink"
              }`}
              title={`A lot of ${value} players`}
            >
              {value}
            </button>
          ))}
          <button type="button" disabled={!live} onClick={shuffle} data-testid="lot-randomise" className={`${quiet} ml-auto`}>
            <Shuffle size={13} /> Randomise lot
          </button>
        </div>
        <p className="mt-1.5 font-ui text-[10.5px] leading-snug text-slate-faint">
          Only that role comes to the block next, picked at random in the auction flow's order
          {ai ? ". The AI auctioneer runs the lot, then returns to the flow." : ". Bring each one up with Next player."}
        </p>
      </div>

      {/* --------------------------------------------------------- the break */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {onBreak ? (
          <button
            type="button"
            onClick={socket.endBreak}
            data-testid="break-resume"
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#34D399] px-3.5 py-2 font-ui text-[11px] font-bold uppercase tracking-[0.1em] text-[#020617] hover:opacity-90"
          >
            <Play size={13} /> Resume the auction
          </button>
        ) : askingBreak ? (
          <>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={80}
              placeholder="Note for the room (optional), e.g. Back in 10 minutes"
              className="min-w-[220px] flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 font-ui text-[12px] text-slate-ink outline-none"
            />
            <button
              type="button"
              onClick={() => {
                socket.takeBreak(note);
                setAskingBreak(false);
                setNote("");
              }}
              data-testid="break-confirm"
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#F6C45A] px-3 py-1.5 font-ui text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#020617]"
            >
              <Coffee size={13} /> Pause now
            </button>
            <button type="button" onClick={() => setAskingBreak(false)} className={quiet}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" disabled={!live} onClick={() => setAskingBreak(true)} data-testid="break-start" className={quiet}>
            <Coffee size={13} /> Pause for a break
          </button>
        )}
        {!askingBreak && (
          <span className="font-ui text-[10.5px] text-slate-faint">
            {onBreak
              ? "The clock is stopped and every screen shows the break."
              : "Stops the clock and tells every franchise. Nothing on the block is lost."}
          </span>
        )}
      </div>
    </section>
  );
}
