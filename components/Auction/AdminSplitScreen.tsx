/**
 * AdminSplitScreen.tsx
 * The auctioneer's station: tools on the left, the live lot on the right.
 *
 * The problem this solves is specific. Running an auction from the Phase 2
 * console means the block lives in a rail beside whatever tab you are on, which
 * is fine until you need to actually read something — open the Scout, or sort
 * the pool by economy, and the thing you are selling is a narrow strip in the
 * corner. An auctioneer fielding "what's his record against spin?" mid-lot
 * should not have to choose between answering it and watching the bidding.
 *
 * So both halves are first class, and the split itself is the control: drag the
 * divider, or snap it. Three presets, because in practice there are three
 * modes of work and not a continuum —
 *
 *   Tools    70/30   deep in a query between lots
 *   Even     50/50   the default, running the room
 *   Block    25/75   a hot lot, where the tools are just context
 *
 * Motion carries the meaning here rather than decorating it. The panes animate
 * to a new split instead of jumping, so the eye tracks which side grew; the
 * divider gives spring feedback under the pointer; and the pane contents fade
 * between tabs on the shared `viewVariants`, so nothing about this screen moves
 * in a way the rest of the console does not.
 *
 * Composition, not reimplementation. Every panel on this screen is a Phase 2
 * component driven by the same live engine, so the auctioneer's split screen
 * and the console cannot disagree about the auction — there is one engine and
 * two arrangements of it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { money } from "../../console/format";
import { EASE, pressable, viewVariants } from "../../console/motion";
import type { AuctionEngine } from "../../console/useAuctionEngine";
import type { ConsolePlayer, PoolFilters, SortKey } from "../../console/types";
import type { ScoutState } from "../../console/useScout";
import type { AuctionSocket } from "../../hooks/useAuctionSocket";
import { useViewerRole } from "../../hooks/useViewerRole";
import type { ViewerRole } from "../../hooks/useViewerRole";

import ReloadPoolButton from "../ReloadPoolButton";
import TimerDisplay from "./TimerDisplay";
import BlockPanel from "../Console/BlockPanel";
import CommandSearch from "../Console/CommandSearch";
// Superseded in place by BiddingHistoryGrid. `LedgerPanel` stays on disk and
// unmounted; restoring the ruled-paper tally is this import and one line below.
import AuctionIntelligence from "../Console/AuctionIntelligence";
import BiddingHistoryGrid from "../Console/BiddingHistoryGrid";
import TeamLeaderboard from "../Console/TeamLeaderboard";
import PoolTable from "../Console/PoolTable";
import { SetupDialog } from "../Console/PlayerCard";
import ScoutView from "../Console/ScoutView";
import TeamBudgetGrid from "../Console/TeamBudgetGrid";
import TeamsView from "../Console/TeamsView";

/** Left-pane tools. The right pane never changes — that is the point. */
type Tool = "teams" | "pool" | "scout" | "stats";

/**
 * Tab labels. Split out because "stats" needs two words and the others do not,
 * and a tab bar that derives its labels from its keys can only ever show one.
 */
const TOOL_LABEL: Record<Tool, string> = {
  teams: "Teams",
  pool: "Pool",
  scout: "Scout",
  stats: "Leaderboard & Stats",
};

/** Fraction of the width given to the left pane. */
const PRESETS = { tools: 0.7, even: 0.5, block: 0.25 } as const;
type Preset = keyof typeof PRESETS;

/** Below this, a split screen is two cramped columns; the panes stack instead. */
const MIN_SPLIT_WIDTH = 1100;

const CLAMP = { min: 0.2, max: 0.8 } as const;

const INITIAL_FILTERS: PoolFilters = {
  status: "all",
  role: "all",
  cap: "all",
  set: "all",
  country: "all",
  minRating: 8,
};

export interface AdminSplitScreenProps {
  engine: AuctionEngine;
  scout: ScoutState;
  onNotice: (message: string, kind?: "err") => void;
  /**
   * The live room, when this screen is driving one.
   *
   * Optional so the split screen remains usable on the offline engine. Given
   * one, the control bar grows the three actions only an auctioneer has: open
   * the waiting room, start, and close the auction.
   */
  socket?: AuctionSocket;
  /**
   * Go back to the waiting room.
   *
   * Supplied by `LiveAuction` only while the room's phase is `waiting` — that
   * is, only when the auctioneer reached this screen by stepping out of the
   * waiting room rather than by the auction being live. Undefined at every
   * other time, and the control is not rendered.
   */
  onReturnToWaitingRoom?: () => void;
  /**
   * Go back to the auction report.
   *
   * Supplied only while the phase is `finished`. The mirror of
   * `onReturnToWaitingRoom`: both hand back the same override, and which
   * one is defined says which screen stepping into this console stepped
   * away from.
   */
  onReturnToReport?: () => void;
}

export default function AdminSplitScreen({
  engine,
  scout,
  onNotice,
  socket,
  onReturnToWaitingRoom,
  onReturnToReport,
}: AdminSplitScreenProps) {
  const reduced = useReducedMotion();

  /*
    The seat decides what the sheet shows.

    Read from the socket rather than hardcoded, even though `LiveAuction` only
    ever renders this screen for an auctioneer. Hardcoding would make that
    routing decision load-bearing in a second place: the day someone mounts
    this component somewhere else, a hardcoded "auctioneer" would hand a
    franchise the full price sheet, and nothing in this file would look wrong.
    Deriving it means the room's own answer is the one that applies.

    With no socket the screen is running on the offline engine, where there are
    no seats at all and whoever opened it is the operator — the same reasoning
    /console uses. Note that is NOT what `useViewerRole(undefined)` returns on
    its own: it answers "spectator" for an absent seat, which is the right safe
    default for a live room and the wrong one for a local tool.
  */
  const seatRole = useViewerRole(socket?.seat);
  const viewerRole: ViewerRole = socket ? seatRole : "auctioneer";

  const [tool, setTool] = useState<Tool>("teams");
  const [split, setSplit] = useState<number>(PRESETS.even);
  const [dragging, setDragging] = useState(false);
  const [wide, setWide] = useState(
    () => typeof window === "undefined" || window.innerWidth >= MIN_SPLIT_WIDTH,
  );

  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<PoolFilters>(INITIAL_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>("sno");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= MIN_SPLIT_WIDTH);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* ---------------------------------------------------------------- *
   * The divider
   *
   * Dragging is tracked on the window rather than on the handle, so the
   * pointer can leave the 8px strip mid-drag — which it always does — without
   * the split freezing. Pointer capture would also work; a window listener is
   * simpler and behaves identically for a one-axis drag.
   * ---------------------------------------------------------------- */
  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) => {
      const frame = frameRef.current;
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      if (rect.width === 0) return;
      const fraction = (event.clientX - rect.left) / rect.width;
      setSplit(Math.min(CLAMP.max, Math.max(CLAMP.min, fraction)));
    };
    const onUp = () => setDragging(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // Stops the drag selecting text across both panes.
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = previous;
    };
  }, [dragging]);

  /** Keyboard equivalent, so the split is not mouse-only. */
  const nudge = useCallback((delta: number) => {
    setSplit((current) => Math.min(CLAMP.max, Math.max(CLAMP.min, current + delta)));
  }, []);

  /*
    The auction setup dialog, as the classic console has always had it.

    Same component, same two fields -- purse per team and the squad limits --
    and the same destructive reset at the bottom. Reusing it rather than writing
    a second one means the rules a reset restores cannot drift between the two
    screens, which is the kind of divergence nobody notices until two rooms
    disagree about what a team can afford.
  */
  const [showSetup, setShowSetup] = useState(false);

  const activePreset: Preset | null = useMemo(() => {
    const match = (Object.keys(PRESETS) as Preset[]).find(
      (key) => Math.abs(PRESETS[key] - split) < 0.02,
    );
    return match ?? null;
  }, [split]);

  const putUp = useCallback(
    (player: ConsolePlayer) => {
      const result = engine.putOnBlock(player.id);
      if (!result.ok) {
        if (result.message) onNotice(result.message, "err");
        return;
      }
      setQuery("");
    },
    [engine, onNotice],
  );

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((current) => {
      if (current === key) {
        setSortDir((dir) => (dir === 1 ? -1 : 1));
        return current;
      }
      setSortDir(key === "name" || key === "set" || key === "country" ? 1 : -1);
      return key;
    });
  }, []);

  const askScout = useCallback(
    (question: string) => {
      setTool("scout");
      scout.ask(question, engine.activePlayer);
    },
    [engine.activePlayer, scout],
  );

  /*
    While dragging, the width is driven directly and the spring is switched
    off — a spring chasing the pointer lags behind it, which feels like the
    divider is stuck to treacle. On release and on a preset, the spring is what
    makes the movement legible.
  */
  const paneTransition = reduced
    ? { duration: 0 }
    : dragging
      ? { duration: 0 }
      : { type: "spring" as const, stiffness: 260, damping: 32, mass: 0.8 };

  return (
    <div className="flex min-h-screen flex-col bg-surface bg-dots">
      {/* ------------------------------------------------------------ *
        Control bar
       * ------------------------------------------------------------ */}
      <header className="z-20 flex flex-wrap items-center gap-3 border-b border-line bg-surface-card px-4 py-2.5 shadow-soft">
        <div className="flex items-center gap-2.5">
          <span className="h-6 w-[3px] rounded-sm bg-slate-ink" aria-hidden />
          <div>
            <div className="font-head text-[13px] font-bold leading-none tracking-[0.1em] text-slate-ink">
              AUCTIONEER
            </div>
            <div className="mt-0.5 font-ui text-[9.5px] uppercase leading-none tracking-[0.14em] text-slate-faint">
              AUCTIQ control
            </div>
          </div>
        </div>

        <div className="min-w-[240px] flex-1">
          <CommandSearch
            engine={engine}
            query={query}
            onQueryChange={setQuery}
            onPutUp={putUp}
            onAskScout={(text) => {
              setTool("scout");
              scout.runSearch(text);
            }}
          />
        </div>

        {/* Split presets. */}
        {wide && (
          <div
            className="flex items-center gap-1 rounded-lg border border-line bg-surface-sunken p-1"
            role="group"
            aria-label="Split layout"
          >
            {(Object.keys(PRESETS) as Preset[]).map((key) => (
              <motion.button
                key={key}
                {...(reduced ? {} : pressable)}
                type="button"
                onClick={() => setSplit(PRESETS[key])}
                aria-pressed={activePreset === key}
                className={`rounded-md px-2.5 py-1 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors ${
                  activePreset === key
                    ? "bg-surface-card text-slate-ink shadow-chip"
                    : "text-slate-muted hover:text-slate-body"
                }`}
              >
                {key}
              </motion.button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3">
          {/*
            Auctioneers only, and labelled "Setup" rather than "Reset".

            `ResetAuction` below is already the destructive control, and it is
            the correct one in a live room: it goes through the socket, the
            server refuses it for anyone not holding the auctioneer's seat, and
            it arms before it fires. What it has never had is the *inputs* --
            purse per team and the squad limits -- which is what this opens.
          */}
          {viewerRole === "auctioneer" && (
            <motion.button
              {...(reduced ? {} : pressable)}
              type="button"
              onClick={() => setShowSetup(true)}
              className="rounded-md border border-line px-2.5 py-1 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-muted transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
            >
              Setup
            </motion.button>
          )}
          <span className="hidden font-ui text-[10px] uppercase tracking-[0.1em] text-slate-faint sm:inline">
            {engine.counts.sold} sold · {money(engine.counts.spent)} spent
          </span>

          {socket && (
            <RunControls
              socket={socket}
              reduced={!!reduced}
              onReturnToWaitingRoom={onReturnToWaitingRoom}
              onReturnToReport={onReturnToReport}
            />
          )}

          {/*
            Re-fetch the pool from the backend.

            The auctioneer needs this more than anyone else does: they are the
            one who will have re-run ingestion, or noticed a player missing, and
            they are also the one who cannot afford to reload the page — a full
            refresh costs them the split they set up and whatever they had open
            in the left pane, mid-lot.
          */}
          <ReloadPoolButton
            loading={engine.isLoadingRoster}
            onReload={engine.reloadRoster}
            reduced={!!reduced}
          />

          {socket && <ResetAuction socket={socket} reduced={!!reduced} />}

          <Link
            to="/"
            className="rounded-lg border border-line px-3 py-1.5 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
          >
            ← AUCTIQ
          </Link>
        </div>
      </header>

      {/* ------------------------------------------------------------ *
        The split
       * ------------------------------------------------------------ */}
      <div
        ref={frameRef}
        className={`flex min-h-0 flex-1 ${wide ? "flex-row" : "flex-col"}`}
      >
        {/* ---- left: tools ---- */}
        <motion.section
          animate={wide ? { width: `${split * 100}%` } : { width: "100%" }}
          transition={paneTransition}
          style={wide ? undefined : { width: "100%" }}
          className="flex min-w-0 flex-col overflow-hidden"
          aria-label="Administrative tools"
        >
          <nav
            className="flex items-center gap-1 border-b border-line bg-surface-card/70 px-3 py-1.5"
            role="tablist"
          >
            {(["teams", "pool", "scout", "stats"] as Tool[]).map((key) => (
              <motion.button
                key={key}
                whileHover={reduced ? undefined : { y: -1 }}
                whileTap={reduced ? undefined : { scale: 0.97 }}
                transition={{ type: "spring", stiffness: 400, damping: 28 }}
                type="button"
                role="tab"
                aria-selected={tool === key}
                onClick={() => setTool(key)}
                className={`rounded-md px-3 py-1.5 font-ui text-[10.5px] font-semibold uppercase tracking-[0.12em] transition-colors ${
                  tool === key
                    ? "bg-surface-sunken text-slate-ink"
                    : "text-slate-muted hover:text-slate-body"
                }`}
              >
                {TOOL_LABEL[key]}
              </motion.button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {/*
              Scout stays mounted whenever it has been opened — a two-minute
              RAG answer must survive the auctioneer glancing at the pool. The
              other two are cheap and are keyed so they replay their entrance.
            */}
            {tool !== "scout" && (
              <motion.div
                key={tool}
                variants={viewVariants}
                initial="initial"
                animate="animate"
              >
                {tool === "teams" && <TeamsView engine={engine} onNotice={onNotice} />}
                {tool === "stats" && (
                  /*
                    All three read-only panels in one pane.

                    They were stacked under the block first, which was wrong on
                    its own terms: the right half is the lot and the left half is
                    whatever you are working on, so analysis belongs in the left
                    half beside the pool and the scout — not squeezed under the
                    thing it is analysing.
                  */
                  <div className="space-y-3 p-3">
                    <div className="overflow-hidden rounded-xl border border-line bg-surface-card shadow-soft">
                      <TeamLeaderboard teams={engine.summaries} rules={engine.rules} />
                    </div>
                    <div className="overflow-hidden rounded-xl border border-line bg-surface-card shadow-soft">
                      <AuctionIntelligence teams={engine.summaries} rules={engine.rules} />
                    </div>
                    <div className="overflow-hidden rounded-xl border border-line bg-surface-card shadow-soft">
                      <BiddingHistoryGrid log={engine.log} />
                    </div>
                  </div>
                )}
                {tool === "pool" && (
                  <PoolTable
                    engine={engine}
                    query={query}
                    filters={filters}
                    onFiltersChange={setFilters}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={toggleSort}
                    onOpenCard={() => {}}
                    onNotice={onNotice}
                    viewerRole={viewerRole}
                  />
                )}
              </motion.div>
            )}

            <div hidden={tool !== "scout"}>
              <ScoutView scout={scout} engine={engine} onNotice={onNotice} />
            </div>
          </div>
        </motion.section>

        {/* ---- the divider ---- */}
        {wide && (
          <Divider
            dragging={dragging}
            reduced={!!reduced}
            split={split}
            onGrab={() => setDragging(true)}
            onNudge={nudge}
          />
        )}

        {/* ---- right: the live lot ---- */}
        <motion.section
          animate={wide ? { width: `${(1 - split) * 100}%` } : { width: "100%" }}
          transition={paneTransition}
          className={`flex min-w-0 flex-col overflow-hidden bg-surface-sunken ${
            wide ? "border-l border-line" : "border-t border-line"
          }`}
          aria-label="Live bidding"
        >
          <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-card px-3 py-1.5">
            <span className="shrink-0 font-ui text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-muted">
              Live bidding
            </span>

            {/*
              The clock, in the header of the pane the auctioneer is already
              watching. They are the one person who cannot act on it directly —
              they do not bid — but they are the one who has to *narrate* it,
              and "going once" is impossible to time from a screen that does
              not show how long is left.
            */}
            {socket?.lotClock && (
              <div className="w-36 shrink-0">
                <TimerDisplay
                  clock={socket.lotClock}
                  timeoutBy={socket.state?.lot?.timeout_by_code ?? null}
                  variant="panel"
                  compact
                />
              </div>
            )}
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 rounded-full ${engine.block ? "animate-pulse" : ""}`}
                style={{ backgroundColor: engine.block ? "#1E6B47" : "#94A3B8" }}
              />
              <span className="font-ui text-[10px] uppercase tracking-[0.1em] text-slate-faint">
                {engine.block ? "lot open" : "idle"}
              </span>
            </span>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
            <BlockPanel engine={engine} onNotice={onNotice} onAskScout={askScout} />

            {socket && <LifelineBoard socket={socket} />}

            <TeamBudgetGrid summaries={engine.summaries} purse={engine.rules.purse} />

            {/* The tally, still here. The analysis panels live in the
                Leaderboard & Stats tab on the left, beside the pool and the
                scout, rather than under the lot they are analysing. */}
            <div className="overflow-hidden rounded-xl border border-line bg-surface-card shadow-soft">
              <BiddingHistoryGrid log={engine.log} limit={20} />
            </div>
          </div>
        </motion.section>
      </div>

      {/*
        The setup dialog, reused from the classic console rather than rewritten.

        `onSave` writes the rules through the engine, which is what every purse
        and squad check reads. `onReset` is the offline engine's own reset and
        is the right one when this screen runs without a room; in a live room
        the socket-backed `ResetAuction` control is authoritative, and the
        dialog closes onto it rather than competing with it.
      */}
      <AnimatePresence>
        {showSetup && (
          <SetupDialog
            rules={engine.rules}
            onSave={(next) => {
              engine.setRules(next);
              setShowSetup(false);
              onNotice("Auction rules updated");
            }}
            onReset={() => {
              engine.resetAuction();
              setShowSetup(false);
              onNotice("Auction reset");
            }}
            onClose={() => setShowSetup(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The drag handle.
 *
 * Eight pixels wide with a wider invisible hit area, because a 2px rule is the
 * correct *look* for a divider and an infuriating thing to grab. The grip dots
 * only appear on hover so the resting state stays a hairline.
 */
function Divider({
  dragging,
  reduced,
  split,
  onGrab,
  onNudge,
}: {
  dragging: boolean;
  reduced: boolean;
  split: number;
  onGrab: () => void;
  onNudge: (delta: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      aria-valuenow={Math.round(split * 100)}
      aria-valuemin={Math.round(CLAMP.min * 100)}
      aria-valuemax={Math.round(CLAMP.max * 100)}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        onGrab();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onNudge(-0.03);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onNudge(0.03);
        }
      }}
      className="group relative w-2 shrink-0 cursor-col-resize focus-visible:outline-none"
    >
      <motion.span
        aria-hidden
        animate={{
          backgroundColor: dragging ? "#0F172A" : "#E8ECF1",
          scaleX: dragging && !reduced ? 2.2 : 1,
        }}
        transition={{ duration: 0.16, ease: EASE }}
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 origin-center group-hover:bg-slate-faint group-focus-visible:bg-slate-ink"
      />
      <span
        aria-hidden
        className={`absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col gap-[3px] rounded-full border border-line bg-surface-card px-[3px] py-1.5 shadow-chip transition-opacity ${
          dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        }`}
      >
        <i className="block h-[2px] w-[2px] rounded-full bg-slate-faint" />
        <i className="block h-[2px] w-[2px] rounded-full bg-slate-faint" />
        <i className="block h-[2px] w-[2px] rounded-full bg-slate-faint" />
      </span>
    </div>
  );
}

/**
 * Who can still freeze the room.
 *
 * Strictly the auctioneer's information rather than a control — they cannot
 * call a timeout and would not want to. It earns its place because a lifeline
 * is the one thing on this screen that can change how long a lot takes without
 * anyone bidding, and an auctioneer who can see that six franchises are out of
 * timeouts knows the back half of the auction will run faster than the front.
 *
 * Pips in the franchise's own colour, because at this size a coloured dot is
 * read faster than a digit, and the colour is already how every other panel on
 * this screen identifies a team.
 */
function LifelineBoard({ socket }: { socket: AuctionSocket }) {
  const teams = socket.state?.teams ?? [];
  const per = socket.state?.rules.timeouts_per_team ?? 3;
  if (teams.length === 0) return null;

  return (
    <div className="rounded-xl border border-line bg-surface-card p-3 shadow-soft">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-ui text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-muted">
          Timeout lifelines
        </span>
        <span className="font-ui text-[9.5px] uppercase tracking-[0.1em] text-slate-faint">
          {per} each
        </span>
      </div>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
        {teams.map((team) => (
          <div
            key={team.id}
            title={`${team.name} — ${team.timeouts_left} of ${per} left`}
            className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 ${
              team.timeouts_left === 0
                ? "border-dashed border-line bg-surface-sunken/50"
                : "border-line bg-surface-sunken"
            }`}
          >
            <span
              className={`font-ui text-[9.5px] font-semibold uppercase tracking-[0.06em] ${
                team.timeouts_left === 0 ? "text-slate-faint" : "text-slate-body"
              }`}
            >
              {team.code}
            </span>
            <span className="ml-auto flex gap-0.5" aria-hidden>
              {Array.from({ length: per }).map((_, index) => (
                <i
                  key={index}
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor:
                      index < team.timeouts_left ? team.color : "#D8DEE6",
                  }}
                />
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Reset the auction — behind a door, and available in every phase.
 *
 * This is the most destructive control in the product: it returns all 284
 * players to the pool, every purse to its opening figure, every lifeline to
 * three, and empties the ledger. There is no undo across it, deliberately —
 * undoing into an auction that no longer exists is worse than not offering it.
 *
 * So what makes it "secure" is three things, none of which is a password:
 *
 *   **The room decides, not the button.** `reset` is refused for anyone whose
 *   seat is not the auctioneer's, server-side, whatever the client sends. The
 *   control is hidden for everyone else purely so a franchise is not shown a
 *   button that would bounce.
 *
 *   **It arms rather than fires.** One click opens a confirmation; a second,
 *   differently-placed click commits. Nothing destructive in this product
 *   should be one stray click from an auctioneer reaching for the pool tab.
 *
 *   **It says what it will destroy, in figures.** "Reset?" invites a reflexive
 *   yes. "47 sold · ₹412 Cr committed — this cannot be undone" does not. The
 *   numbers come from the room, so they are what will actually be lost.
 *
 * It disarms itself after a few seconds. An armed destructive control left
 * sitting on screen is a worse hazard than the unarmed one, because the next
 * person to touch the keyboard has no idea it is armed.
 */
function ResetAuction({
  socket,
  reduced,
}: {
  socket: AuctionSocket;
  reduced: boolean;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 8000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const counts = socket.state?.counts;
  const purse = socket.state?.rules.purse ?? 0;
  const touched = (counts?.sold ?? 0) + (counts?.unsold ?? 0);

  if (socket.seat?.role !== "auctioneer") return null;

  if (!armed) {
    return (
      <motion.button
        {...(reduced ? {} : pressable)}
        type="button"
        onClick={() => setArmed(true)}
        title="Return every player to the pool and every purse to full"
        className="rounded-lg border border-line px-3 py-1.5 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-muted transition-colors hover:border-unsold/50 hover:text-unsold"
      >
        Reset auction
      </motion.button>
    );
  }

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
      className="flex items-center gap-2 rounded-lg border border-unsold/40 bg-unsold/5 px-2.5 py-1.5"
      role="alertdialog"
      aria-label="Confirm auction reset"
    >
      <span className="font-ui text-[10px] leading-tight text-slate-body">
        <b className="font-semibold">Reset everything?</b>{" "}
        <span className="text-slate-muted">
          {touched > 0
            ? `${counts?.sold ?? 0} sold · ${counts?.unsold ?? 0} unsold · ${money(
                counts?.spent ?? 0,
              )} committed`
            : "nothing sold yet"}
          {" — purses back to "}
          {money(purse)}, lifelines restored. Cannot be undone.
        </span>
      </span>

      <button
        type="button"
        onClick={() => {
          socket.resetRoom();
          setArmed(false);
        }}
        className="shrink-0 rounded-md border border-unsold bg-unsold px-2.5 py-1 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-white transition-opacity hover:opacity-90"
      >
        Reset
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="shrink-0 rounded-md border border-line px-2.5 py-1 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:text-slate-ink"
      >
        Cancel
      </button>
    </motion.div>
  );
}

/**
 * The three buttons only the auctioneer has.
 *
 * Which one is shown depends on the phase, because at any given moment exactly
 * one of them is the thing to do. Offering "start" while the auction is already
 * running, or "finish" before it has begun, is how an auctioneer clicks the
 * wrong control in front of a room.
 *
 * `finish` is the only destructive one here — it closes the auction and
 * generates the report — so it is the only one that asks first.
 */
/**
 * The auctioneer's run controls, by phase.
 *
 * The `waiting` phase used to fall through to the bare label at the bottom of
 * this function — the control bar simply read "waiting" and offered nothing.
 * That was the other half of the lock-out: even once an auctioneer reached
 * this screen during a waiting period, there was no control here acknowledging
 * that a waiting room existed, let alone taking them back to it.
 */
function RunControls({
  socket,
  reduced,
  onReturnToWaitingRoom,
  onReturnToReport,
}: {
  onReturnToWaitingRoom?: () => void;
  onReturnToReport?: () => void;
  socket: AuctionSocket;
  reduced: boolean;
}) {
  const [confirmingFinish, setConfirmingFinish] = useState(false);
  const phase = socket.state?.phase ?? "lobby";

  const primary =
    "rounded-lg border border-slate-ink bg-slate-ink px-3.5 py-1.5 font-ui text-[10px] font-semibold uppercase tracking-[0.12em] text-white transition-colors hover:bg-slate-ink/90";
  const quiet =
    "rounded-lg border border-line px-3 py-1.5 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink";

  if (phase === "lobby") {
    return (
      <div className="flex items-center gap-2">
        <motion.button
          {...(reduced ? {} : pressable)}
          type="button"
          onClick={() => socket.openWaitingRoom(600)}
          className={primary}
          title="Summon the franchises and start a ten-minute countdown"
        >
          Open waiting room
        </motion.button>
        <motion.button
          {...(reduced ? {} : pressable)}
          type="button"
          onClick={socket.startAuction}
          className={quiet}
          title="Skip the waiting room and begin immediately"
        >
          Start now
        </motion.button>
      </div>
    );
  }

  if (phase === "live") {
    if (confirmingFinish) {
      return (
        <div className="flex items-center gap-2">
          <span className="font-ui text-[10px] uppercase tracking-[0.1em] text-slate-muted">
            Close the auction?
          </span>
          <button
            type="button"
            onClick={() => {
              socket.finish();
              setConfirmingFinish(false);
            }}
            className="rounded-lg border border-unsold bg-unsold px-3 py-1.5 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-white"
          >
            Yes, finish
          </button>
          <button type="button" onClick={() => setConfirmingFinish(false)} className={quiet}>
            Cancel
          </button>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5">
          <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sold" />
          <span className="font-ui text-[9.5px] uppercase tracking-[0.1em] text-slate-muted">
            live · {socket.state?.connected ?? 0} in room
          </span>
        </span>
        <motion.button
          {...(reduced ? {} : pressable)}
          type="button"
          onClick={() => setConfirmingFinish(true)}
          className={quiet}
          title="Close the auction and generate the report"
        >
          Finish auction
        </motion.button>
      </div>
    );
  }

  if (phase === "waiting") {
    return (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5">
          <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
          <span className="font-ui text-[9.5px] uppercase tracking-[0.1em] text-slate-muted">
            waiting · {socket.state?.connected ?? 0} in room
          </span>
        </span>
        {onReturnToWaitingRoom && (
          <motion.button
            {...(reduced ? {} : pressable)}
            type="button"
            data-testid="run-return-waiting-room"
            onClick={onReturnToWaitingRoom}
            className={quiet}
            title="Go back to the waiting room and watch the franchises arrive"
          >
            Waiting room
          </motion.button>
        )}
        <motion.button
          {...(reduced ? {} : pressable)}
          type="button"
          data-testid="run-start-auction"
          onClick={socket.startAuction}
          className={primary}
          title="Begin the auction — every client opens its block at once"
        >
          Start the auction
        </motion.button>
      </div>
    );
  }

  if (phase === "finished") {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5 font-ui text-[9.5px] uppercase tracking-[0.1em] text-slate-muted">
          finished
        </span>
        {/*
          The reset used to live only here, as a single unguarded click that
          was reachable only once the auction had already finished. It is now
          the header control below, which asks first and is available in every
          phase — an auctioneer who needs to wipe a practice run needs it most
          *during* the run, not after it.
        */}
        {onReturnToReport && (
          <motion.button
            {...(reduced ? {} : pressable)}
            type="button"
            data-testid="run-return-report"
            onClick={onReturnToReport}
            className={quiet}
            title="Back to the auction report"
          >
            Report
          </motion.button>
        )}
        <span className="font-ui text-[9.5px] uppercase tracking-[0.1em] text-slate-faint">
          reset from the control bar →
        </span>
      </div>
    );
  }

  return (
    <span className="rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5 font-ui text-[9.5px] uppercase tracking-[0.1em] text-slate-muted">
      {phase}
    </span>
  );
}
