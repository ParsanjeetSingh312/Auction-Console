/**
 * LiveAuction.tsx
 * The `/auction` route: pick a seat, then take it.
 *
 * The room has two kinds of occupant and they need different screens, so this
 * page's first job is to find out which one you are. Until the FastAPI room
 * exists, the choice is made here and held in component state; when the server
 * arrives, this is the component that will hold the socket and the identity it
 * hands back, and the panes below it will not have to change — they already
 * take everything they need as props.
 *
 * Role separation is therefore structural from the start, even though nothing
 * is enforced yet. The auctioneer screen is the only one that can put a player
 * up; the franchise screen bids for exactly one team and cannot start anything.
 * That is the shape the RBAC rules will lock down rather than a shape they will
 * have to impose.
 *
 * The engine lives here rather than inside either screen, so both seats read
 * one auction. Today that means a single browser; once the room is server-owned
 * it will mean one auction across every browser in it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";

import { money } from "../console/format";
import { EASE, pressable } from "../console/motion";
import { useAuctionEngine } from "../console/useAuctionEngine";
import { useScout } from "../console/useScout";

import AdminSplitScreen from "../components/Auction/AdminSplitScreen";
import LiveBlock from "../components/Auction/LiveBlock";

import "../console/console.css";

type Seat =
  | { role: "none" }
  | { role: "auctioneer" }
  | { role: "franchise"; teamId: number };

interface Toast {
  id: number;
  message: string;
  kind?: "err";
}

export default function LiveAuction() {
  const engine = useAuctionEngine();
  const scout = useScout();

  const [seat, setSeat] = useState<Seat>({ role: "none" });
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toastId = useRef(1);
  const toastTimers = useRef<number[]>([]);

  const notify = useCallback((message: string, kind?: "err") => {
    const id = toastId.current++;
    setToasts((prev) => [...prev, { id, message, kind }]);
    const timer = window.setTimeout(
      () => setToasts((prev) => prev.filter((toast) => toast.id !== id)),
      kind === "err" ? 4200 : 2600,
    );
    toastTimers.current.push(timer);
  }, []);

  useEffect(
    () => () => {
      for (const timer of toastTimers.current) window.clearTimeout(timer);
    },
    [],
  );

  useEffect(() => {
    document.title = "AUCTIQ · Live Bidding";
  }, []);

  const { isLoadingRoster, rosterError } = engine;
  const { checkHealth } = scout;
  useEffect(() => {
    if (isLoadingRoster || rosterError) return;
    checkHealth();
  }, [isLoadingRoster, rosterError, checkHealth]);

  const toastLayer = (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast${toast.kind === "err" ? " err" : ""}`}>
          {toast.message}
        </div>
      ))}
    </div>
  );

  if (seat.role === "auctioneer") {
    return (
      <>
        <AdminSplitScreen engine={engine} scout={scout} onNotice={notify} />
        {toastLayer}
      </>
    );
  }

  if (seat.role === "franchise") {
    return (
      <>
        <LiveBlock
          engine={engine}
          teamId={seat.teamId}
          onNotice={notify}
          corner={
            <button
              type="button"
              onClick={() => setSeat({ role: "none" })}
              className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
            >
              ← leave seat
            </button>
          }
        />
        {toastLayer}
      </>
    );
  }

  return (
    <>
      <SeatPicker engine={engine} onTake={setSeat} />
      {toastLayer}
    </>
  );
}

/**
 * The lobby.
 *
 * One chair and ten seats. The asymmetry is deliberate and visible: the
 * auctioneer's card is wide and sits alone above the franchise grid, because
 * there is exactly one of them and they can do things nobody else can.
 */
function SeatPicker({
  engine,
  onTake,
}: {
  engine: ReturnType<typeof useAuctionEngine>;
  onTake: (seat: Seat) => void;
}) {
  return (
    <div className="min-h-screen bg-surface bg-dots px-5 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-7 flex items-start justify-between gap-4">
          <div>
            <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
              Live bidding interface
            </span>
            <h1 className="mt-1 font-head text-[28px] font-bold leading-tight text-slate-ink">
              Take your seat
            </h1>
            <p className="mt-1.5 max-w-md font-ui text-[12.5px] leading-relaxed text-slate-muted">
              {engine.isLoadingRoster
                ? "Loading the player pool…"
                : `${engine.players.length} players · ${money(engine.rules.purse)} a franchise · squad cap ${engine.rules.maxSquad}`}
            </p>
          </div>
          <Link
            to="/"
            className="shrink-0 rounded-lg border border-line bg-surface-card px-3 py-1.5 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
          >
            ← AUCTIQ
          </Link>
        </header>

        <motion.button
          {...pressable}
          type="button"
          onClick={() => onTake({ role: "auctioneer" })}
          className="group relative mb-6 block w-full overflow-hidden rounded-xl border border-line bg-surface-card p-5 text-left shadow-soft transition-shadow hover:shadow-soft-lg"
        >
          <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-slate-ink" />
          <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
            One seat
          </span>
          <span className="mt-1.5 block font-head text-[20px] font-bold leading-tight text-slate-ink">
            Auctioneer
          </span>
          <span className="mt-1.5 block max-w-lg font-ui text-[12.5px] leading-relaxed text-slate-muted">
            Split-screen control. Run the lots, read the data, and watch the bidding
            without choosing between them.
          </span>
          <span className="mt-3.5 flex items-center gap-1.5 font-ui text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-ink">
            Take the chair
            <span className="transition-transform duration-200 group-hover:translate-x-1">→</span>
          </span>
        </motion.button>

        <div className="mb-2.5 flex items-baseline justify-between">
          <span className="font-ui text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-muted">
            Franchises
          </span>
          <span className="font-ui text-[10px] uppercase tracking-[0.1em] text-slate-faint">
            bid for one team
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {engine.teams.map((team, index) => {
            const summary = engine.summaryFor(team.id);
            return (
              <motion.button
                key={team.id}
                type="button"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, ease: EASE, delay: index * 0.025 }}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => onTake({ role: "franchise", teamId: team.id })}
                className="group relative overflow-hidden rounded-lg border border-line bg-surface-card px-2.5 py-2.5 pl-3 text-left shadow-chip transition-colors hover:border-slate-faint/60"
              >
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 w-[3px]"
                  style={{ backgroundColor: team.color }}
                />
                <span className="font-ui text-[10px] font-semibold uppercase leading-none tracking-[0.08em] text-slate-body">
                  {team.code}
                </span>
                <span className="mt-1 block font-num text-[14px] font-bold leading-none tabular-nums text-slate-ink">
                  {money(summary?.left ?? engine.rules.purse)}
                </span>
                <span className="mt-0.5 block font-ui text-[8.5px] uppercase leading-none tracking-[0.06em] text-slate-faint">
                  {team.name}
                </span>
              </motion.button>
            );
          })}
        </div>

        <p className="mt-6 font-ui text-[11px] leading-relaxed text-slate-faint">
          Seats are chosen locally for now. Once the auction room is server-owned, this
          is where the socket hands you an identity and the roles become enforceable —
          a franchise will not be able to reach the auctioneer's screen by picking it
          here.
        </p>
      </div>
    </div>
  );
}
