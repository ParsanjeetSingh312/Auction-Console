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
import { motion, useReducedMotion } from "framer-motion";

import { money } from "../../console/format";
import { EASE, pressable, viewVariants } from "../../console/motion";
import type { AuctionEngine } from "../../console/useAuctionEngine";
import type { ConsolePlayer, PoolFilters, SortKey } from "../../console/types";
import type { ScoutState } from "../../console/useScout";

import BlockPanel from "../Console/BlockPanel";
import CommandSearch from "../Console/CommandSearch";
import LedgerPanel from "../Console/LedgerPanel";
import PoolTable from "../Console/PoolTable";
import ScoutView from "../Console/ScoutView";
import TeamBudgetGrid from "../Console/TeamBudgetGrid";
import TeamsView from "../Console/TeamsView";

/** Left-pane tools. The right pane never changes — that is the point. */
type Tool = "teams" | "pool" | "scout";

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
}

export default function AdminSplitScreen({
  engine,
  scout,
  onNotice,
}: AdminSplitScreenProps) {
  const reduced = useReducedMotion();

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
          <span className="hidden font-ui text-[10px] uppercase tracking-[0.1em] text-slate-faint sm:inline">
            {engine.counts.sold} sold · {money(engine.counts.spent)} spent
          </span>
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
            {(["teams", "pool", "scout"] as Tool[]).map((key) => (
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
                {key}
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
          <div className="flex items-center justify-between border-b border-line bg-surface-card px-3 py-1.5">
            <span className="font-ui text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-muted">
              Live bidding
            </span>
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

            <TeamBudgetGrid summaries={engine.summaries} purse={engine.rules.purse} />

            <div className="overflow-hidden rounded-xl border border-line bg-surface-card shadow-soft">
              <LedgerPanel log={engine.log} />
            </div>
          </div>
        </motion.section>
      </div>
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
