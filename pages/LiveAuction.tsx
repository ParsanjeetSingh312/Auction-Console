/**
 * LiveAuction.tsx
 * The `/auction` route: the room, end to end.
 *
 * One socket, one engine adapter, four screens chosen by the room's phase and
 * the seat you hold:
 *
 *              lobby            waiting          live              finished
 *   no seat    seat picker      seat picker      seat picker       report
 *   auctioneer split screen     waiting room     split screen      report
 *   franchise  waiting room     waiting room     block             report
 *
 * The phase comes from the server, so every client changes screen at the same
 * moment — a franchise does not have to be told the auction started, their
 * block simply opens. That is the whole difference between this and Phase 3.
 *
 * The auctioneer is given the split screen during `lobby` rather than a holding
 * page, because that is where the control to open the waiting room lives and
 * because the minutes before an auction are exactly when they want the pool and
 * the Scout in front of them.
 *
 * Two engines are in play and the split is deliberate. `useAuctionEngine` still
 * hydrates the 284-player pool from REST, because that is work the room has no
 * reason to repeat; `useSocketEngine` overlays the auction half with the room's
 * own state. Every view below therefore renders against the live room while
 * being, line for line, the same component the offline console uses.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";

import { money } from "../console/format";
import { EASE, pressable } from "../console/motion";
import { useSocketEngine } from "../console/socketEngine";
import { useAuctionEngine } from "../console/useAuctionEngine";
import { useScout } from "../console/useScout";
import { useAuctionSocket } from "../hooks/useAuctionSocket";

import ReloadPoolButton from "../components/ReloadPoolButton";
import AdminSplitScreen from "../components/Auction/AdminSplitScreen";
import PostAuctionReport from "../components/Auction/PostAuctionReport";
import SocketBlock from "../components/Auction/SocketBlock";
import WaitingRoom from "../components/Auction/WaitingRoom";

import "../console/console.css";

interface Toast {
  id: number;
  message: string;
  kind?: "err";
}

export default function LiveAuction() {
  const local = useAuctionEngine();
  const socket = useAuctionSocket();
  const engine = useSocketEngine(local, socket);
  const scout = useScout();

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

  /*
    Every refusal from the room becomes a toast.

    The room answers a rejected bid asynchronously, so there is no call site to
    return it to — this is the one place it can surface. Dismissed immediately
    after so the same message can be raised again on the next attempt, which
    during a contested lot is common.
  */
  const { error, dismissError } = socket;
  useEffect(() => {
    if (!error) return;
    notify(error, "err");
    dismissError();
  }, [error, notify, dismissError]);

  const { isLoadingRoster, rosterError } = local;
  const { checkHealth } = scout;
  useEffect(() => {
    if (isLoadingRoster || rosterError) return;
    checkHealth();
  }, [isLoadingRoster, rosterError, checkHealth]);

  const leaveSeat = useCallback(() => {
    // A page reload is the honest way to drop a seat: the room frees it on
    // disconnect, and re-mounting the socket is exactly what we want.
    window.location.reload();
  }, []);

  const toastLayer = (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast${toast.kind === "err" ? " err" : ""}`}>
          {toast.message}
        </div>
      ))}
    </div>
  );

  const phase = socket.state?.phase ?? "lobby";
  const role = socket.seat?.role ?? null;

  /* ---------------- the report ---------------- */

  if (phase === "finished") {
    return (
      <>
        <PostAuctionReport
          onLeave={leaveSeat}
          // Only the auctioneer is offered the reset, and the room enforces
          // that regardless — this just avoids showing a franchise a button
          // that would be refused.
          onReset={role === "auctioneer" ? socket.resetRoom : undefined}
        />
        {toastLayer}
      </>
    );
  }

  /* ---------------- no seat yet ---------------- */

  if (role === null) {
    return (
      <>
        <SeatPicker engine={engine} local={local} socket={socket} />
        {toastLayer}
      </>
    );
  }

  /* ---------------- auctioneer ---------------- */

  if (role === "auctioneer") {
    // The waiting room is shown to the auctioneer too, so they can watch the
    // franchises arrive — it is the only screen that shows who is actually in.
    if (phase === "waiting") {
      return (
        <>
          <WaitingRoom socket={socket} onLeave={leaveSeat} />
          {toastLayer}
        </>
      );
    }

    return (
      <>
        <AdminSplitScreen
          engine={engine}
          scout={scout}
          onNotice={notify}
          socket={socket}
        />
        {toastLayer}
      </>
    );
  }

  /* ---------------- franchise ---------------- */

  if (phase !== "live") {
    return (
      <>
        <WaitingRoom socket={socket} onLeave={leaveSeat} />
        {toastLayer}
      </>
    );
  }

  return (
    <>
      <SocketBlock socket={socket} engine={engine} onLeave={leaveSeat} />
      {toastLayer}
    </>
  );
}

/**
 * The lobby.
 *
 * One chair and ten seats. The asymmetry is deliberate and visible: there is
 * exactly one auctioneer and they can do things nobody else can.
 *
 * Seats already taken are shown as taken rather than hidden, because a
 * franchise arriving to find their team greyed out learns something ("someone
 * else is playing Mumbai") that a missing tile does not tell them.
 */
function SeatPicker({
  engine,
  local,
  socket,
}: {
  engine: ReturnType<typeof useSocketEngine>;
  local: ReturnType<typeof useAuctionEngine>;
  socket: ReturnType<typeof useAuctionSocket>;
}) {
  const connecting = socket.status !== "open";

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
              {local.isLoadingRoster
                ? "Loading the player pool…"
                : `${local.players.length} players · ${money(engine.rules.purse)} a franchise · squad cap ${engine.rules.maxSquad}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ConnectionPill status={socket.status} />
            <ReloadPoolButton
              loading={local.isLoadingRoster}
              onReload={local.reloadRoster}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-card px-3 py-1.5 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink disabled:cursor-not-allowed disabled:opacity-60"
            />
            <Link
              to="/"
              className="rounded-lg border border-line bg-surface-card px-3 py-1.5 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
            >
              ← AUCTIQ
            </Link>
          </div>
        </header>

        <motion.button
          {...pressable}
          type="button"
          disabled={connecting}
          onClick={() => socket.claimSeat({ role: "auctioneer" })}
          className="group relative mb-6 block w-full overflow-hidden rounded-xl border border-line bg-surface-card p-5 text-left shadow-soft transition-shadow hover:shadow-soft-lg disabled:cursor-not-allowed disabled:opacity-60"
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
          {(socket.state?.teams ?? []).map((team, index) => (
            <motion.button
              key={team.id}
              type="button"
              disabled={connecting || team.connected}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, ease: EASE, delay: index * 0.025 }}
              whileHover={team.connected ? undefined : { scale: 1.03 }}
              whileTap={team.connected ? undefined : { scale: 0.97 }}
              onClick={() => socket.claimSeat({ role: "franchise", teamId: team.id })}
              title={team.connected ? `${team.name} is already being played` : team.name}
              className={`group relative overflow-hidden rounded-lg border px-2.5 py-2.5 pl-3 text-left shadow-chip transition-colors ${
                team.connected
                  ? "cursor-not-allowed border-dashed border-line bg-surface-sunken/60"
                  : "border-line bg-surface-card hover:border-slate-faint/60"
              }`}
            >
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-[3px]"
                style={{ backgroundColor: team.connected ? "#CBD5E1" : team.color }}
              />
              <span className="font-ui text-[10px] font-semibold uppercase leading-none tracking-[0.08em] text-slate-body">
                {team.code}
              </span>
              <span className="mt-1 block font-num text-[14px] font-bold leading-none tabular-nums text-slate-ink">
                {money(team.left)}
              </span>
              <span className="mt-0.5 block font-ui text-[8.5px] uppercase leading-none tracking-[0.06em] text-slate-faint">
                {team.connected ? "taken" : team.name}
              </span>
            </motion.button>
          ))}
        </div>

        <p className="mt-6 font-ui text-[11px] leading-relaxed text-slate-faint">
          The room assigns your seat and holds it server-side. A franchise cannot
          reach the auctioneer's screen or start the auction, whatever it asks for
          here — the role is decided by the socket you are on, not by the message
          you send.
        </p>
      </div>
    </div>
  );
}

function ConnectionPill({ status }: { status: string }) {
  const tone =
    status === "open" ? "#1E6B47" : status === "closed" ? "#A2382C" : "#8A5A12";
  return (
    <span className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-card px-2.5 py-1.5">
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${status !== "open" ? "animate-pulse" : ""}`}
        style={{ backgroundColor: tone }}
      />
      <span className="font-ui text-[9.5px] uppercase tracking-[0.1em] text-slate-muted">
        {status === "open" ? "room live" : status}
      </span>
    </span>
  );
}
