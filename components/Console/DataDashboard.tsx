/**
 * DataDashboard.tsx
 * The Data Interface: everything the console knows, with nothing that bids.
 *
 * This is the Phase 2 console's layout, view for view, minus the auction. The
 * masthead, the tab bar, the split body and the right rail are all the same
 * shapes in the same places, because someone who has used the console should
 * not have to relearn anything to read data in it — the only difference they
 * should notice is that the block is gone.
 *
 * What is excluded, and how
 * -------------------------
 * Three things had to go: the Block tab, the BlockPanel in the rail, and every
 * path that mutates the auction. The first two are simply not rendered. The
 * third is handled by `readOnlyEngine`, which hands the views an engine whose
 * write methods refuse — so PoolTable, TeamsView, ResultsView, ScoutView and
 * PlayerCard are used here completely unmodified, exactly as the console uses
 * them, and there is no second copy of any of them to keep in step.
 *
 * The rail keeps the franchise purses and the ledger. Both are readings, not
 * controls, and during pre-auction analysis "who has money" is one of the more
 * useful things on the screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";

import { money } from "../../console/format";
import {
  drawerVariants,
  figureVariants,
  shellItem,
  shellVariants,
  toastVariants,
  viewVariants,
} from "../../console/motion";
import { readOnlyEngine } from "../../console/readOnlyEngine";
import type { ConsolePlayer, PoolFilters, SortKey } from "../../console/types";
import { useAuctionEngine } from "../../console/useAuctionEngine";
import { useScout } from "../../console/useScout";

import ReloadPoolButton from "../ReloadPoolButton";
import CommandSearch from "./CommandSearch";
import LedgerPanel from "./LedgerPanel";
import PoolTable from "./PoolTable";
import type { PoolLayout } from "./PoolTable";
import ResultsView from "./ResultsView";
import ScoutView from "./ScoutView";
import TeamBudgetGrid from "./TeamBudgetGrid";
import TeamsView from "./TeamsView";
import { PlayerCard } from "./PlayerCard";

import "../../console/console.css";

/** No "block" — that is the whole point of this route. */
type View = "pool" | "teams" | "results" | "scout";

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

export default function DataDashboard() {
  /*
    A private auction, deliberately.

    `persist: false` means this engine neither reads nor writes the saved
    auction, so the header's AVAILABLE / SOLD / UNSOLD / SPENT always describe
    the pool as registered rather than whatever auction happens to be sitting in
    localStorage from /console. The Data Interface is a scouting view of the
    pool; a sale made in another room is not its business to report.
  */
  const live = useAuctionEngine({ persist: false });
  const scout = useScout();

  /*
    Memoised on the live engine so the sealed wrapper keeps a stable identity
    between renders. Without this, every render would hand the views a brand
    new object and defeat any memoisation inside them.
  */
  const engine = useMemo(() => readOnlyEngine(live), [live]);

  const [view, setView] = useState<View>("pool");

  /*
    The pool opens on the box grid, not the sheet.

    This is the Data Interface's own default and deliberately not PoolTable's:
    /console still opens on the sheet, because it is the auctioneer's working
    surface and sorting eleven columns is the job it exists for. /data is the
    read-only scouting view, where the reference layout — four role columns of
    player boxes — is what it should show first.

    The sheet is one click away in the filter rail, and switching does not
    change which players are on screen: both views render the same filtered,
    sorted result.
  */
  const [layout, setLayout] = useState<PoolLayout>("grid");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<PoolFilters>(INITIAL_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>("sno");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [cardPlayer, setCardPlayer] = useState<ConsolePlayer | null>(null);
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
    document.title = "AUCTIQ · Data Interface";
  }, []);

  /* Same deferral as the console: the roster first, the health pill behind it. */
  const { isLoadingRoster, rosterError } = live;
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
      setSortDir(key === "name" || key === "set" || key === "country" ? 1 : -1);
      return key;
    });
  }, []);

  /**
   * The command bar's "put up" path, rerouted.
   *
   * In the console this puts a player on the block. Here there is no block, so
   * the same gesture opens that player's card instead — which is what someone
   * looking them up in an analytics view actually wanted.
   */
  const openCard = useCallback((player: ConsolePlayer) => {
    setCardPlayer(player);
    setQuery("");
  }, []);

  const askScout = useCallback(
    (question: string, context: ConsolePlayer | null = null) => {
      setView("scout");
      scout.ask(question, context);
    },
    [scout],
  );

  const searchScout = useCallback(
    (text: string) => {
      setView("scout");
      scout.runSearch(text);
    },
    [scout],
  );

  return (
    <div className="shell">
      {/*
        The masthead arrives as one staggered group: brand, search, meters,
        tabs. Items come down while the view below comes up — the two meeting
        in the middle is what makes the screen read as opening rather than as
        having been scrolled to.
      */}
      <motion.header
        className="masthead"
        variants={shellVariants}
        initial="initial"
        animate="animate"
      >
        <motion.div className="brand" variants={shellItem}>
          <div className="mark" aria-hidden="true" />
          <div>
            <h1>Data&nbsp;Interface</h1>
            <div className="eyebrow">
              {engine.isLoadingRoster
                ? "Loading the pool…"
                : `AUCTIQ · ${engine.players.length} players · read-only analytics`}
            </div>
          </div>
        </motion.div>

        <CommandSearch
          engine={engine}
          query={query}
          onQueryChange={setQuery}
          onPutUp={openCard}
          onAskScout={searchScout}
        />

        <motion.div className="meters" variants={shellItem}>
          <Meter label="Available" value={engine.counts.available} />
          <Meter label="Sold" value={engine.counts.sold} tone="is-sold" />
          <Meter label="Unsold" value={engine.counts.unsold} tone="is-unsold" />
          <Meter
            label="Spent"
            tone="is-spend"
            value={engine.counts.spent ? money(engine.counts.spent).replace("₹", "") : "—"}
          />
        </motion.div>

        <motion.nav className="tabs" role="tablist" aria-label="Views" variants={shellItem}>
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

          <span className="spacer" />

          {/*
            Says what this route is rather than leaving someone to infer it from
            an absence. "Where is the block?" is the first question a console
            user will have on arriving here.
          */}
          <span
            className="tag tag-neutral"
            title="Bidding is disabled on this route. The auction runs in the Live Bidding Interface."
          >
            Read-only
          </span>

          {/*
            The pool is the one piece of state this screen does not own, and
            re-running ingestion changes it underneath an open browser. The
            shared button carries the loading state, which matters here because
            a cold fetch takes seconds and an unchanged button invites a second
            click and a second in-flight request.
          */}
          <ReloadPoolButton
            loading={engine.isLoadingRoster}
            onReload={engine.reloadRoster}
            className="util flex items-center gap-1.5"
          />

          <Link to="/auction" className="util" style={{ textDecoration: "none" }}>
            Live bidding →
          </Link>
          <Link to="/" className="util" style={{ textDecoration: "none" }}>
            ← AUCTIQ
          </Link>
        </motion.nav>
      </motion.header>

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
            /* Keyed, no AnimatePresence — same reasoning as the console. */
            <motion.div key={view} variants={viewVariants} initial="initial" animate="animate">
              {view === "pool" && (
                <PoolTable
                  engine={engine}
                  query={query}
                  filters={filters}
                  onFiltersChange={setFilters}
                  layout={layout}
                  onLayoutChange={setLayout}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                  onOpenCard={setCardPlayer}
                  onNotice={notify}
                  /*
                    The Data Interface is the participant's view of the pool.

                    A fixed role rather than one read from a seat, because this
                    route has no socket and therefore no seat to read — it runs
                    on `readOnlyEngine` over the REST roster alone. Anyone can
                    open /data, including someone about to bid against nine
                    others, so it is given the narrower of the two views: the
                    sheet up to Rating, with no status, no prices and no
                    controls.

                    Note this is the *presentation* half of the guarantee. The
                    engine being sealed is what makes the route read-only; this
                    is what makes it discreet. Neither substitutes for the
                    other.
                  */
                  viewerRole="participant"
                />
              )}
              {view === "teams" && <TeamsView engine={engine} onNotice={notify} />}
              {view === "results" && <ResultsView engine={engine} onNotice={notify} />}
            </motion.div>
          )}

          {/* Kept mounted once opened, so a long RAG answer survives a tab glance. */}
          <div hidden={view !== "scout"}>
            <ScoutView scout={scout} engine={engine} onNotice={notify} />
          </div>
        </main>

        <aside className="side">
          <div className="border-b border-rule px-3.5 py-3">
            <TeamBudgetGrid summaries={engine.summaries} purse={engine.rules.purse} />
          </div>

          {/* No onClear: clearing the ledger would be a write. */}
          <LedgerPanel log={engine.log} />
        </aside>
      </div>

      <AnimatePresence>
        {cardPlayer && (
          <PlayerCard
            key={cardPlayer.id}
            player={cardPlayer}
            engine={engine}
            onClose={() => setCardPlayer(null)}
            onNotice={notify}
            onAskScout={askScout}
          />
        )}
      </AnimatePresence>

      {/*
        `initial={false}` on purpose: `.toast` already carries its own CSS
        entrance (`toast-rise`), shared with the console, and running both would
        animate the same element twice. AnimatePresence is here only so a toast
        leaves rather than vanishing mid-sentence.
      */}
      <div className="toasts" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              className={`toast${toast.kind === "err" ? " err" : ""}`}
              variants={toastVariants}
              initial={false}
              animate="animate"
              exit="exit"
            >
              {toast.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * One figure in the masthead strip.
 *
 * The span is keyed on its own value, so React swaps the element when the count
 * changes and the new number rises into place. See `figureVariants` for why
 * this is a swap rather than a count-up.
 *
 * Deliberately *not* wrapped in AnimatePresence. The obvious version — old
 * number out, new number in, `mode="popLayout"` — keeps both in the DOM for the
 * length of the crossover, and for that window `textContent` reads "0284".
 * Nothing on screen looks wrong, because the outgoing digit is taken out of
 * flow, but the accessibility tree and anything scraping the meter see a number
 * that was never true. On a read-only analytics surface that is not a trade
 * worth making for one extra beat of motion, so only the arrival is animated
 * and there is never more than one figure mounted.
 */
function Meter({
  label,
  value,
  tone = "",
}: {
  label: string;
  value: number | string;
  tone?: string;
}) {
  return (
    <div className={`meter ${tone}`.trim()}>
      <div className="eyebrow">{label}</div>
      <b className="num">
        <motion.span
          key={value}
          variants={figureVariants}
          initial="initial"
          animate="animate"
          style={{ display: "inline-block" }}
        >
          {value}
        </motion.span>
      </b>
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
