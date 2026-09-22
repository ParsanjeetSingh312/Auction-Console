/**
 * AuctionConsole.tsx
 * The unified dashboard: the auction-console.html layout, hydrated from the
 * Phase 2 RAG backend, with the Scout search engine as a first-class view.
 *
 * Layout, straight from the prototype: a masthead carrying the brand, the
 * command search and the meter strip; a tab bar; and a split body with the
 * working view on the left and a fixed rail on the right holding the block card
 * above the tally ledger. The rail never changes with the tab, so the standing
 * bid and the running ledger stay visible while you browse teams, read results,
 * or interrogate the Scout.
 *
 * Shared state lives here and nowhere else. `useAuctionEngine` owns the roster
 * and the auction; `useScout` owns the RAG conversation. This component holds
 * only what is genuinely cross-cutting — the active tab, the search box, the
 * pool's filters and sort, the open dialog, and the toast queue — and passes
 * both hooks down. That is what makes the two halves aware of each other: the
 * Scout view reads `engine.activePlayer` for context, and the auction views
 * call into `scout` to ask a question about whoever is up.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

import { money } from "../../console/format";
import type { ConsolePlayer, PoolFilters, SortKey } from "../../console/types";
import { useAuctionEngine } from "../../console/useAuctionEngine";
import { useScout } from "../../console/useScout";

import BlockPanel from "./BlockPanel";
import CommandSearch from "./CommandSearch";
import LedgerPanel from "./LedgerPanel";
import PoolTable from "./PoolTable";
import ResultsView from "./ResultsView";
import ScoutView from "./ScoutView";
import TeamsView from "./TeamsView";
import { PlayerCard, SetupDialog } from "./PlayerCard";
import LiveBlock from "../Auction/LiveBlock";
import TeamBudgetGrid from "./TeamBudgetGrid";
import { pressable, viewVariants } from "../../console/motion";

import "../../console/console.css";

import StadiumBackdrop from "../Sections/StadiumBackdrop";

type View = "pool" | "teams" | "results" | "scout" | "block";

interface Toast {
  id: number;
  message: string;
  kind?: "err";
}

const INITIAL_FILTERS: PoolFilters = {
  status: "all",
  role: "all",
  cap: "all",
  set: "all",
  country: "all",
  minRating: 8,
};

/**
 * The night theme, applied once around every screen this route can show.
 *
 * Same shape as the wrapper on /auction and for the same reason: the component
 * below returns from more than one place, so wrapping it is the only way to
 * cover them all without an edit per return that a later one would miss.
 *
 * Nothing inside changes — no props, no logic, no markup. `.console-dark`
 * redefines console.css's palette tokens for this subtree, and the backdrop is
 * a fixed layer behind it.
 */
export default function AuctionConsole() {
  return (
    <div className="console-dark">
      <StadiumBackdrop variant="console" />
      <AuctionConsoleInner />
    </div>
  );
}

function AuctionConsoleInner() {
  const engine = useAuctionEngine();
  const scout = useScout();

  const [view, setView] = useState<View>("pool");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<PoolFilters>(INITIAL_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>("sno");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [cardPlayer, setCardPlayer] = useState<ConsolePlayer | null>(null);
  /**
   * The franchise the war-room view speaks for.
   *
   * The console proper is the auctioneer's: it bids on behalf of anyone. The
   * block view is a bidder's station, so it needs to know whose purse and whose
   * "you are winning" it is showing.
   */
  const [bidderTeamId, setBidderTeamId] = useState(1);
  const [isSetupOpen, setIsSetupOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toastId = useRef(1);
  const toastTimers = useRef<number[]>([]);

  const notify = useCallback((message: string, kind?: "err") => {
    const id = toastId.current++;
    setToasts((prev) => [...prev, { id, message, kind }]);
    // Errors linger, because they usually explain why a click did nothing.
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

  /**
   * Probe the RAG backend only once the roster is in.
   *
   * `/api/v1/health` builds a ChromaManager, which loads the embedding model on
   * a cold start, and the route is synchronous — so it holds the server's event
   * loop for as long as that takes. Firing it alongside the roster fetch would
   * make the console's first paint wait on a model load it does not need. The
   * roster comes first; the status pill fills in behind it.
   */
  const { isLoadingRoster, rosterError } = engine;
  const { checkHealth } = scout;
  useEffect(() => {
    if (isLoadingRoster || rosterError) return;
    checkHealth();
  }, [isLoadingRoster, rosterError, checkHealth]);

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((current) => {
      if (current === key) {
        setSortDir((dir) => (dir === 1 ? -1 : 1));
        return current;
      }
      // Text sorts read best ascending; figures read best largest-first.
      setSortDir(key === "name" || key === "set" || key === "country" ? 1 : -1);
      return key;
    });
  }, []);

  /** Put a player up and make sure the room can see it happen. */
  const putUp = useCallback(
    (player: ConsolePlayer) => {
      const result = engine.putOnBlock(player.id);
      if (!result.ok) {
        if (result.message) notify(result.message, "err");
        return;
      }
      setQuery("");
    },
    [engine, notify],
  );

  /** Hand a question to the Scout tab, with the on-block player as context. */
  const askScout = useCallback(
    (question: string, context: ConsolePlayer | null = engine.activePlayer) => {
      setView("scout");
      scout.ask(question, context);
    },
    [engine.activePlayer, scout],
  );

  /** Hand raw search text to the RAG engine rather than the local matcher. */
  const searchScout = useCallback(
    (text: string) => {
      setView("scout");
      scout.runSearch(text);
    },
    [scout],
  );

  // The war-room view is full-bleed by design — it replaces the shell rather
  // than sitting inside it, because a focus tunnel with a masthead above it is
  // not a focus tunnel. Every other view keeps the console chrome.
  if (view === "block") {
    return (
      <>
        <LiveBlock
          engine={engine}
          teamId={bidderTeamId}
          onNotice={notify}
          corner={
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setView("pool")}
                className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
              >
                ← console
              </button>
              <label className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-600">
                  bid for
                </span>
                <select
                  value={bidderTeamId}
                  onChange={(event) => setBidderTeamId(Number(event.target.value))}
                  className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-neutral-300"
                >
                  {engine.teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.code} · {team.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          }
        />
        <div className="toasts" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast${toast.kind === "err" ? " err" : ""}`}>
              {toast.message}
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <div className="mark" aria-hidden="true" />
          <div>
            <h1>Auction&nbsp;Console</h1>
            <div className="eyebrow">
              {engine.isLoadingRoster
                ? "Loading the pool…"
                : `Player pool · ${engine.players.length} registered · purse ${money(engine.rules.purse)} a team`}
            </div>
          </div>
        </div>

        <CommandSearch
          engine={engine}
          query={query}
          onQueryChange={setQuery}
          onPutUp={putUp}
          onAskScout={searchScout}
        />

        <div className="meters">
          <div className="meter">
            <div className="eyebrow">Available</div>
            <b className="num">{engine.counts.available}</b>
          </div>
          <div className="meter is-sold">
            <div className="eyebrow">Sold</div>
            <b className="num">{engine.counts.sold}</b>
          </div>
          <div className="meter is-unsold">
            <div className="eyebrow">Unsold</div>
            <b className="num">{engine.counts.unsold}</b>
          </div>
          <div className="meter is-spend">
            <div className="eyebrow">Spent</div>
            <b className="num">
              {engine.counts.spent ? money(engine.counts.spent).replace("₹", "") : "—"}
            </b>
          </div>
        </div>

        <nav className="tabs" role="tablist" aria-label="Views">
          <Tab view="pool" active={view} onSelect={setView} count={engine.players.length}>
            Pool
          </Tab>
          <Tab view="teams" active={view} onSelect={setView} count={engine.teams.length}>
            Teams
          </Tab>
          <Tab view="results" active={view} onSelect={setView} count={engine.counts.sold}>
            Results
          </Tab>
          <Tab view="scout" active={view} onSelect={setView}>
            Scout
          </Tab>
          <Tab view="block" active={view} onSelect={setView}>
            Block
          </Tab>

          <span className="spacer" />

          <motion.button
            {...pressable}
            type="button"
            className="util"
            disabled={!engine.canUndo}
            title="Undo the last auction action"
            onClick={() => {
              const result = engine.undo();
              if (result.message) notify(result.message, result.ok ? undefined : "err");
            }}
          >
            ↶ Undo
          </motion.button>
          <motion.button
            {...pressable}
            type="button"
            className="util"
            title="Reload the pool from the RAG backend"
            onClick={engine.reloadRoster}
          >
            Reload pool
          </motion.button>
          <motion.button
            {...pressable}
            type="button"
            className="util"
            onClick={() => setIsSetupOpen(true)}
          >
            Auction setup
          </motion.button>
        </nav>
      </header>

      <div className="split">
        <main className="main">
          {engine.rosterError && (
            <RosterError message={engine.rosterError} onRetry={engine.reloadRoster} />
          )}

          {engine.isLoadingRoster && !engine.rosterError && (
            <div className="panel px-4 py-10 text-center">
              <span className="eyebrow">Loading the player pool from the RAG backend…</span>
            </div>
          )}

          {!engine.isLoadingRoster && !engine.rosterError && (
            /*
              A keyed motion.div, deliberately without AnimatePresence.
              Changing `key` remounts the element, so `initial -> animate`
              replays on every tab change, which is exactly the fade-and-slide
              wanted — and nothing more. AnimatePresence would additionally hold
              the outgoing view alive for its exit, and since Scout is mounted
              separately and permanently (a two-minute RAG answer has to survive
              a glance at another tab), that left a stale view parked in the DOM
              whenever Scout was open. No exit, no ghost.
            */
            <motion.div
              key={view}
              variants={viewVariants}
              initial="initial"
              animate="animate"
            >
              {view === "pool" && (
                <PoolTable
                  engine={engine}
                  query={query}
                  filters={filters}
                  onFiltersChange={setFilters}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                  onOpenCard={setCardPlayer}
                  onNotice={notify}
                  /*
                    The offline console is the operator's own tool: one person,
                    one browser, no server and no seats. Whoever opens it is
                    running the auction, so they get the full sheet.

                    Stated explicitly rather than left to the prop's default.
                    The default exists to keep call sites working during a
                    migration, and relying on it here would leave the most
                    privileged view in the app asserting nothing about why it
                    is privileged.
                  */
                  viewerRole="auctioneer"
                />
              )}
              {view === "teams" && <TeamsView engine={engine} onNotice={notify} />}
              {view === "results" && <ResultsView engine={engine} onNotice={notify} />}
            </motion.div>
          )}

          {/*
            The Scout view stays mounted once opened even when another tab is
            showing, so a two-minute RAG answer is not thrown away by a glance
            at the Teams tab. The auction views are cheap to rebuild; a
            conversation is not.
          */}
          <div hidden={view !== "scout"}>
            <ScoutView scout={scout} engine={engine} onNotice={notify} />
          </div>
        </main>

        <aside className="side">
          <BlockPanel
            engine={engine}
            onNotice={notify}
            onAskScout={(question) => askScout(question)}
          />

          {/*
            The purse grid, where the stacked bars and slot tallies used to be.
            During a lot the only budget question that matters is which rivals
            can still outbid you, and a ranked grid answers it at a glance where
            ten bar charts made you do the ranking yourself.

            Clicking a chip sets the franchise the war-room view speaks for, so
            the same control that answers "who is rich" also answers "whose
            station am I".
          */}
          <div className="border-b border-rule px-3.5 py-3">
            <TeamBudgetGrid
              summaries={engine.summaries}
              purse={engine.rules.purse}
              activeTeamId={bidderTeamId}
              onSelect={setBidderTeamId}
            />
          </div>

          <LedgerPanel log={engine.log} onClear={engine.resetAuction} />
        </aside>
      </div>

      {cardPlayer && (
        <PlayerCard
          player={cardPlayer}
          engine={engine}
          onClose={() => setCardPlayer(null)}
          onNotice={notify}
          onAskScout={askScout}
        />
      )}

      {isSetupOpen && (
        <SetupDialog
          rules={engine.rules}
          onSave={engine.setRules}
          onClose={() => setIsSetupOpen(false)}
          onReset={() => {
            engine.resetAuction();
            notify("Auction reset");
          }}
        />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast${toast.kind === "err" ? " err" : ""}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function Tab({
  view,
  active,
  onSelect,
  count,
  children,
}: {
  view: View;
  active: View;
  onSelect: (view: View) => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <motion.button
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      type="button"
      role="tab"
      className="viewtab"
      aria-selected={active === view}
      onClick={() => onSelect(view)}
    >
      {children}
      {count !== undefined && <span className="cnt">{count}</span>}
    </motion.button>
  );
}

function RosterError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="panel mb-3 border-unsold/40 bg-unsold-tint px-3 py-3" role="alert">
      <span className="eyebrow text-unsold">Player pool unavailable</span>
      <p className="mt-1 text-mini text-ink-soft">{message}</p>
      <button type="button" className="mini mt-2" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
