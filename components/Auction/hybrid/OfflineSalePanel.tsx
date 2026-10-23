/**
 * OfflineSalePanel.tsx
 * The offline auctioneer's block: the player in the room, and the sale the
 * room just made by placard -- which franchise, at what price -- logged with
 * one press of the hammer.
 *
 * Nothing moves on until this is pressed (or the player is passed unsold):
 * an offline room has no clock. The room checks the sale exactly as it would
 * a bid (auction/room.py record_sale) and answers a refusal with the reason;
 * the hints here only say in advance what it will say.
 *
 * Framer Motion handles the franchise selection and the panel's entrances;
 * GSAP swings the hammer icon on the strike.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Gavel, Hand, Undo2 } from "lucide-react";

import { franchiseByCode } from "../../../console/franchises";
import type { AuctionSocket } from "../../../hooks/useAuctionSocket";
import { crore } from "../blockTypes";

gsap.registerPlugin(useGSAP);

const STEPS = [25, 100, 500];

export default function OfflineSalePanel({ socket }: { socket: AuctionSocket }) {
  const state = socket.state;
  const lot = state?.lot ?? null;
  const reduce = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  const [teamId, setTeamId] = useState<number | null>(null);
  const [price, setPrice] = useState(0);
  // What is in the box while it is being typed in; otherwise it shows `price`.
  const [editing, setEditing] = useState<string | null>(null);

  // A new player on the block starts a fresh sale at his base price.
  useEffect(() => {
    setTeamId(null);
    setPrice(lot?.base ?? 0);
    setEditing(null);
  }, [lot?.player_id, lot?.base]);

  const { contextSafe } = useGSAP({ scope: root });
  const strike = contextSafe(() => {
    if (reduce) return;
    gsap
      .timeline()
      .to(".sale-gavel", { rotation: 28, duration: 0.18, ease: "power2.out", transformOrigin: "80% 80%" })
      .to(".sale-gavel", { rotation: -35, duration: 0.12, ease: "power3.in" })
      .to(".sale-gavel", { rotation: 0, duration: 0.35, ease: "bounce.out" });
  });

  const teams = state?.teams ?? [];
  const rules = state?.rules;
  const chosen = teams.find((t) => t.id === teamId) ?? null;

  /** What the room will say about this sale, before it is asked. */
  const problem = useMemo(() => {
    if (!lot || !rules) return null;
    if (price < lot.base) return `Below ${lot.player_name}'s base of ${crore(lot.base)}`;
    if (!chosen) return null;
    if (chosen.size >= rules.max_squad) return `${chosen.name}'s squad is full`;
    if (lot.overseas && chosen.overseas >= rules.max_overseas) return `${chosen.name} has no overseas places left`;
    if (price > chosen.left) return `${chosen.name} has ${crore(chosen.left)} left`;
    return null;
  }, [lot, rules, price, chosen]);

  const setFromTyped = (text: string) => {
    setEditing(text);
    const crores = Number(text);
    if (Number.isFinite(crores) && crores > 0) setPrice(Math.round(crores * 100));
  };
  // Functional, so quick presses add up instead of each starting from the
  // same stale price.
  const step = (lakh: number) => {
    const floor = lot?.base ?? 0;
    setEditing(null);
    setPrice((current) => Math.max(floor, current + lakh));
  };

  if (!state) return null;

  return (
    <motion.section
      ref={root}
      layout
      className="rounded-xl border border-line bg-surface-card p-4 shadow-soft"
      aria-label="Log the sale"
      data-testid="offline-sale-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-[#FBBF24]/15 px-2 py-0.5 font-ui text-[10px] font-semibold uppercase tracking-[0.14em] text-[#F59E0B]">
          <Hand size={12} /> Offline · placards in the room
        </span>
        <button
          type="button"
          onClick={socket.undo}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-muted hover:text-slate-ink"
          title="Undo the last action -- a sale goes back on the block"
        >
          <Undo2 size={12} /> Undo
        </button>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {!lot ? (
          <motion.p
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-4 font-ui text-[12.5px] leading-relaxed text-slate-muted"
          >
            Put a player up from the pool. There is no clock: the lot stays on the block until you log the sale or pass
            him unsold.
          </motion.p>
        ) : (
          <motion.div
            key={lot.player_id}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="mt-3">
              <div className="font-head text-[20px] font-bold leading-tight text-slate-ink">{lot.player_name}</div>
              <div className="mt-0.5 font-ui text-[11px] uppercase tracking-[0.12em] text-slate-faint">
                {lot.role}
                {lot.overseas ? " · overseas" : ""} · base {crore(lot.base)}
              </div>
            </div>

            <h3 className="mt-4 font-ui text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-muted">
              Highest placard
            </h3>
            <div className="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-4" role="radiogroup" aria-label="Franchise">
              {teams.map((team) => {
                const colours = franchiseByCode(team.code);
                const active = team.id === teamId;
                return (
                  <motion.button
                    key={team.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTeamId(team.id)}
                    whileTap={{ scale: 0.95 }}
                    className="relative overflow-hidden rounded-lg border px-2 py-2 text-left transition-colors"
                    style={{
                      borderColor: active ? colours?.primary ?? "#22D3EE" : "var(--line, rgba(148,163,184,.25))",
                      background: active ? `${colours?.primary ?? "#22D3EE"}26` : undefined,
                    }}
                    title={`${team.name} · ${crore(team.left)} left · ${team.size}/${rules?.max_squad} players`}
                  >
                    <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: colours?.primary ?? team.color }} />
                    <span className="block pl-1 font-num text-[15px] font-bold leading-none text-slate-ink">{team.code}</span>
                    <span className="mt-1 block pl-1 font-ui text-[9.5px] text-slate-faint">{crore(team.left)} left</span>
                  </motion.button>
                );
              })}
            </div>

            <h3 className="mt-4 font-ui text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-muted">
              Sold for
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="flex items-center rounded-lg border border-line bg-surface-sunken pl-3">
                <span className="font-num text-[16px] font-bold text-slate-faint">₹</span>
                <input
                  value={editing ?? (price / 100).toFixed(2)}
                  onChange={(event) => setFromTyped(event.target.value)}
                  onBlur={() => setEditing(null)}
                  inputMode="decimal"
                  aria-label="Sale price in crore"
                  className="h-10 w-20 bg-transparent px-1 font-num text-[20px] font-bold text-slate-ink outline-none"
                />
                <span className="pr-3 font-ui text-[11px] font-semibold text-slate-faint">Cr</span>
              </label>
              {STEPS.map((lakh) => (
                <button
                  key={lakh}
                  type="button"
                  onClick={() => step(lakh)}
                  className="h-10 rounded-lg border border-line px-2.5 font-ui text-[11px] font-semibold text-slate-body hover:border-slate-faint/60 hover:text-slate-ink"
                >
                  +{lakh >= 100 ? `${lakh / 100} Cr` : `${lakh} L`}
                </button>
              ))}
            </div>

            <p className="mt-2 min-h-[18px] font-ui text-[11.5px] text-[#F87171]" role="alert">
              {problem ?? ""}
            </p>

            <div className="mt-2 flex flex-wrap gap-2">
              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                disabled={!chosen || !!problem}
                onClick={() => {
                  if (!chosen) return;
                  strike();
                  socket.recordSale(chosen.id, price);
                }}
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-[#F59E0B] px-4 font-ui text-[12px] font-bold uppercase tracking-[0.12em] text-[#0B1120] transition-opacity disabled:opacity-40"
                data-testid="log-sale"
              >
                <Gavel size={16} className="sale-gavel" />
                {chosen ? `Sold to ${chosen.code} for ${crore(price)}` : "Choose the franchise"}
              </motion.button>
              <button
                type="button"
                onClick={socket.markUnsold}
                className="min-h-11 rounded-lg border border-line px-4 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-body hover:text-slate-ink"
              >
                Unsold
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
