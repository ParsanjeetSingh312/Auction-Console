/**
 * useAuctionEngine.ts
 * Roster hydration plus the whole client-side auction: the block, the bidding
 * ladder, budget/squad legality, the ledger, and undo.
 *
 * Why the auction lives in the client. The roster comes from the RAG backend,
 * which is a read-only analytical store — it has no notion of who is on the
 * block or what a team has spent, and it should not grow one. So the console
 * owns that state, exactly as the auction-console.html prototype did, and
 * checkpoints it to localStorage so a refresh mid-auction is survivable.
 *
 * State is grouped into one `AuctionState` object rather than four `useState`
 * calls because every intent touches several parts of it at once — a bid moves
 * the block *and* appends to the ledger *and* bumps the sequence — and a single
 * object keeps those transitions atomic and trivially snapshot-able for undo.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchPlayers, RagError } from "./ragClient";
import { incrementFor, money, toConsolePlayer } from "./format";
import type {
  AuctionRecord,
  BlockState,
  ConsolePlayer,
  LogEntry,
  LogKind,
  Rules,
  Team,
  TeamSummary,
} from "./types";

/* ------------------------------------------------------------------ *
 * Defaults
 *
 * Teams, purse and squad limits are auction-day settings, not player data —
 * neither backend stores them, so they start from these and are editable in the
 * setup dialog.
 * ------------------------------------------------------------------ */

const DEFAULT_TEAMS: Team[] = [
  { id: 1, name: "Mumbai", code: "MUM", color: "#123E8C" },
  { id: 2, name: "Chennai", code: "CHE", color: "#B58200" },
  { id: 3, name: "Bengaluru", code: "BLR", color: "#A62B22" },
  { id: 4, name: "Kolkata", code: "KOL", color: "#5C3B8F" },
  { id: 5, name: "Delhi", code: "DEL", color: "#1E86A8" },
  { id: 6, name: "Punjab", code: "PBK", color: "#B2354F" },
  { id: 7, name: "Rajasthan", code: "RAJ", color: "#C4557E" },
  { id: 8, name: "Hyderabad", code: "HYD", color: "#C2622A" },
  { id: 9, name: "Lucknow", code: "LKO", color: "#1E7A5E" },
  { id: 10, name: "Ahmedabad", code: "AHM", color: "#2B4F6E" },
];

export const DEFAULT_RULES: Rules = {
  purse: 12000,
  maxSquad: 25,
  minSquad: 18,
  maxOverseas: 8,
};

const AVAILABLE: AuctionRecord = { status: "available", teamId: null, price: null };

const STORAGE_KEY = "ipl-auction-console/v1";
const MAX_UNDO = 60;
const MAX_LOG = 400;

/* ------------------------------------------------------------------ *
 * State shape
 * ------------------------------------------------------------------ */

interface AuctionState {
  records: Record<number, AuctionRecord>;
  block: BlockState | null;
  log: LogEntry[];
  seq: number;
}

const EMPTY_STATE: AuctionState = { records: {}, block: null, log: [], seq: 0 };

interface PersistedState extends AuctionState {
  rules: Rules;
}

/** The result of an intent, so the UI can raise the reason it was refused. */
export interface IntentResult {
  ok: boolean;
  message?: string;
}

const OK: IntentResult = { ok: true };

export interface AuctionEngine {
  /* roster */
  players: ConsolePlayer[];
  playerById: (id: number) => ConsolePlayer | undefined;
  /** What the backend says the pool holds, which may exceed what was fetched. */
  totalPlayers: number;
  isLoadingRoster: boolean;
  rosterError: string | null;
  reloadRoster: () => void;

  /* auction */
  teams: Team[];
  rules: Rules;
  block: BlockState | null;
  activePlayer: ConsolePlayer | null;
  log: LogEntry[];
  recordFor: (id: number) => AuctionRecord;
  teamById: (id: number | null) => Team | undefined;
  summaries: TeamSummary[];
  summaryFor: (teamId: number) => TeamSummary | undefined;
  /** Why `teamId` cannot go to `amount` for `player`, or null when it can. */
  blockedReason: (teamId: number, player: ConsolePlayer, amount: number) => string | null;
  /** What the next bid would cost, given who currently holds the ask. */
  nextAsk: number;
  counts: { available: number; sold: number; unsold: number; spent: number };

  /* intents */
  putOnBlock: (playerId: number) => IntentResult;
  bidFor: (teamId: number) => IntentResult;
  raiseAsk: (delta: number) => IntentResult;
  sell: () => IntentResult;
  pass: () => IntentResult;
  returnToPool: (playerId: number) => IntentResult;
  undo: () => IntentResult;
  canUndo: boolean;
  setRules: (rules: Rules) => void;
  resetAuction: () => void;
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function loadPersisted(): PersistedState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (!parsed || typeof parsed !== "object" || !parsed.records) return null;
    return {
      records: parsed.records,
      block: parsed.block ?? null,
      log: Array.isArray(parsed.log) ? parsed.log : [],
      seq: typeof parsed.seq === "number" ? parsed.seq : 0,
      rules: { ...DEFAULT_RULES, ...(parsed.rules ?? {}) },
    };
  } catch {
    // Private browsing, cleared storage, or a payload from an older shape —
    // none of which should stop the console from opening.
    return null;
  }
}

function savePersisted(state: AuctionState, rules: Rules): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, rules }));
  } catch {
    /* storage full or blocked — the auction still runs, it just will not resume */
  }
}

/* ------------------------------------------------------------------ *
 * Hook
 * ------------------------------------------------------------------ */

export function useAuctionEngine(): AuctionEngine {
  const [players, setPlayers] = useState<ConsolePlayer[]>([]);
  const [totalPlayers, setTotalPlayers] = useState(0);
  const [isLoadingRoster, setIsLoadingRoster] = useState(true);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [rosterNonce, setRosterNonce] = useState(0);

  const [teams] = useState<Team[]>(DEFAULT_TEAMS);
  const [rules, setRulesState] = useState<Rules>(DEFAULT_RULES);
  const [state, setState] = useState<AuctionState>(EMPTY_STATE);

  const undoStack = useRef<AuctionState[]>([]);
  const [canUndo, setCanUndo] = useState(false);

  /* ---------------- roster ---------------- */

  useEffect(() => {
    const controller = new AbortController();
    setIsLoadingRoster(true);
    setRosterError(null);

    fetchPlayers(controller.signal)
      .then((data) => {
        setPlayers(data.players.map(toConsolePlayer));
        setTotalPlayers(data.total);
        setIsLoadingRoster(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setRosterError(
          error instanceof RagError ? error.message : "Could not load the player pool.",
        );
        setIsLoadingRoster(false);
      });

    return () => controller.abort();
  }, [rosterNonce]);

  const reloadRoster = useCallback(() => setRosterNonce((n) => n + 1), []);

  /**
   * Restore the saved auction once the roster is in, so records can be matched
   * against ids that actually exist. Anything referring to a player the backend
   * no longer returns is dropped rather than silently skewing the tallies.
   */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || players.length === 0) return;
    restored.current = true;

    const saved = loadPersisted();
    if (!saved) return;

    const ids = new Set(players.map((p) => p.id));
    const records: Record<number, AuctionRecord> = {};
    for (const [key, record] of Object.entries(saved.records)) {
      const id = Number(key);
      if (ids.has(id)) records[id] = record;
    }

    setRulesState(saved.rules);
    setState({
      records,
      block: saved.block && ids.has(saved.block.playerId) ? saved.block : null,
      log: saved.log,
      seq: saved.seq,
    });
  }, [players]);

  // Checkpoint after every committed change. Skipped until the roster is in, so
  // the initial empty state cannot overwrite a saved auction.
  useEffect(() => {
    if (players.length === 0) return;
    savePersisted(state, rules);
  }, [state, rules, players.length]);

  /* ---------------- lookups ---------------- */

  const playerIndex = useMemo(
    () => new Map(players.map((player) => [player.id, player])),
    [players],
  );

  const playerById = useCallback(
    (id: number) => playerIndex.get(id),
    [playerIndex],
  );

  const recordFor = useCallback(
    (id: number): AuctionRecord => state.records[id] ?? AVAILABLE,
    [state.records],
  );

  const teamById = useCallback(
    (id: number | null) => (id == null ? undefined : teams.find((t) => t.id === id)),
    [teams],
  );

  const activePlayer = useMemo(
    () => (state.block ? playerIndex.get(state.block.playerId) ?? null : null),
    [state.block, playerIndex],
  );

  /**
   * The auction floor, used to reserve budget for a team's remaining minimum
   * squad slots. Taken from the pool rather than hardcoded so a dataset with a
   * different floor needs no code change.
   */
  const minBase = useMemo(
    () => (players.length ? Math.min(...players.map((p) => p.base)) : 30),
    [players],
  );

  const summaries = useMemo<TeamSummary[]>(() => {
    return teams.map((team) => {
      const squad = players.filter((player) => {
        const record = state.records[player.id];
        return record?.status === "sold" && record.teamId === team.id;
      });

      const spent = squad.reduce(
        (total, player) => total + (state.records[player.id]?.price ?? 0),
        0,
      );
      const left = rules.purse - spent;
      const slotsAfterThis = Math.max(0, rules.minSquad - (squad.length + 1));

      const composition = { BAT: 0, BOWL: 0, AR: 0, WK: 0 };
      for (const player of squad) composition[player.roleShort] += 1;

      return {
        team,
        squad,
        spent,
        left,
        overseas: squad.filter((p) => p.overseas).length,
        maxBid: Math.max(0, left - slotsAfterThis * minBase),
        composition,
        size: squad.length,
      };
    });
  }, [teams, players, state.records, rules, minBase]);

  const summaryFor = useCallback(
    (teamId: number) => summaries.find((s) => s.team.id === teamId),
    [summaries],
  );

  const counts = useMemo(() => {
    let sold = 0;
    let unsold = 0;
    let spent = 0;
    for (const player of players) {
      const record = state.records[player.id];
      if (!record || record.status === "available") continue;
      if (record.status === "sold") {
        sold += 1;
        spent += record.price ?? 0;
      } else {
        unsold += 1;
      }
    }
    return { available: players.length - sold - unsold, sold, unsold, spent };
  }, [players, state.records]);

  /**
   * Rule check, in the order a room would apply it: squad size, then the
   * overseas cap, then money.
   */
  const blockedReason = useCallback(
    (teamId: number, player: ConsolePlayer, amount: number): string | null => {
      const summary = summaries.find((s) => s.team.id === teamId);
      if (!summary) return "unknown team";
      if (summary.size >= rules.maxSquad) return `squad full (${rules.maxSquad})`;
      if (player.overseas && summary.overseas >= rules.maxOverseas) {
        return `overseas full (${rules.maxOverseas})`;
      }
      if (amount > summary.maxBid) return `over budget — max ${money(summary.maxBid)}`;
      return null;
    },
    [summaries, rules],
  );

  /**
   * The next bid. An unclaimed player can be taken at the opening ask; once a
   * team holds it, the ladder applies.
   */
  const nextAsk = useMemo(() => {
    if (!state.block) return 0;
    return state.block.bidderId == null
      ? state.block.bid
      : state.block.bid + incrementFor(state.block.bid);
  }, [state.block]);

  /* ---------------- intents ---------------- */

  /** Commit a transition, pushing the previous state onto the undo stack. */
  const commit = useCallback((next: (prev: AuctionState) => AuctionState) => {
    setState((prev) => {
      undoStack.current.push(prev);
      if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
      return next(prev);
    });
    setCanUndo(true);
  }, []);

  const appendLog = useCallback(
    (prev: AuctionState, kind: LogKind, what: string, amount: number | null): AuctionState => {
      const seq = prev.seq + 1;
      const entry: LogEntry = { seq, kind, what, amount, ts: Date.now() };
      return { ...prev, seq, log: [entry, ...prev.log].slice(0, MAX_LOG) };
    },
    [],
  );

  const putOnBlock = useCallback(
    (playerId: number): IntentResult => {
      const player = playerIndex.get(playerId);
      if (!player) return { ok: false, message: "That player is not in the pool." };

      const record = state.records[playerId] ?? AVAILABLE;
      if (record.status === "sold") {
        const team = teams.find((t) => t.id === record.teamId);
        return {
          ok: false,
          message: `${player.name} is already sold to ${team?.name ?? "a team"}.`,
        };
      }

      commit((prev) => {
        // An unsold player put back up returns to the pool first, so the tallies
        // never count them as both unsold and on the block.
        const records = { ...prev.records, [playerId]: { ...AVAILABLE } };
        const next = { ...prev, records, block: { playerId, bid: player.base, bidderId: null } };
        return appendLog(next, "note", `${player.surname} on the block`, player.base);
      });

      return OK;
    },
    [playerIndex, state.records, teams, commit, appendLog],
  );

  const bidFor = useCallback(
    (teamId: number): IntentResult => {
      if (!state.block) return { ok: false, message: "Nobody is on the block." };
      const player = playerIndex.get(state.block.playerId);
      const team = teams.find((t) => t.id === teamId);
      if (!player || !team) return { ok: false, message: "Unknown team or player." };

      const amount = nextAsk;
      const blocked = blockedReason(teamId, player, amount);
      if (blocked) {
        return { ok: false, message: `${team.name} cannot go to ${money(amount)} — ${blocked}` };
      }

      commit((prev) =>
        appendLog(
          { ...prev, block: { ...prev.block!, bid: amount, bidderId: teamId } },
          "bid",
          `${team.code} · ${player.surname}`,
          amount,
        ),
      );
      return OK;
    },
    [state.block, playerIndex, teams, nextAsk, blockedReason, commit, appendLog],
  );

  /**
   * Raise the standing ask without changing hands — the auctioneer talking the
   * price up. If a team already holds the bid, the raise still has to be one
   * they could legally honour.
   */
  const raiseAsk = useCallback(
    (delta: number): IntentResult => {
      if (!state.block) return { ok: false, message: "Nobody is on the block." };
      const player = playerIndex.get(state.block.playerId);
      if (!player) return { ok: false, message: "Unknown player." };

      const amount = Math.max(player.base, state.block.bid + delta);
      if (amount === state.block.bid) return OK;

      const holder = state.block.bidderId;
      if (holder != null) {
        const blocked = blockedReason(holder, player, amount);
        if (blocked) {
          const team = teams.find((t) => t.id === holder);
          return {
            ok: false,
            message: `${team?.name ?? "That team"} cannot go to ${money(amount)} — ${blocked}`,
          };
        }
      }

      const team = teams.find((t) => t.id === holder);
      commit((prev) =>
        appendLog(
          { ...prev, block: { ...prev.block!, bid: amount } },
          team ? "bid" : "note",
          team ? `${team.code} · ${player.surname}` : "ask raised",
          amount,
        ),
      );
      return OK;
    },
    [state.block, playerIndex, teams, blockedReason, commit, appendLog],
  );

  /**
   * The next player to call up, in sheet order — so the gavel keeps moving
   * without the auctioneer having to search for someone after every lot.
   */
  const nextAvailable = useCallback(
    (records: Record<number, AuctionRecord>): ConsolePlayer | undefined =>
      players.find((player) => (records[player.id]?.status ?? "available") === "available"),
    [players],
  );

  const sell = useCallback((): IntentResult => {
    if (!state.block) return { ok: false, message: "Nobody is on the block." };
    if (state.block.bidderId == null) {
      return { ok: false, message: "No team holds the bid yet." };
    }

    const player = playerIndex.get(state.block.playerId);
    const team = teams.find((t) => t.id === state.block!.bidderId);
    if (!player || !team) return { ok: false, message: "Unknown team or player." };

    const price = state.block.bid;
    const blocked = blockedReason(team.id, player, price);
    if (blocked) return { ok: false, message: `Cannot complete the sale — ${blocked}` };

    commit((prev) => {
      const records = {
        ...prev.records,
        [player.id]: { status: "sold" as const, teamId: team.id, price },
      };
      const logged = appendLog(
        { ...prev, records, block: null },
        "sold",
        `${team.code} ← ${player.surname}`,
        price,
      );
      const next = nextAvailable(records);
      return next
        ? { ...logged, block: { playerId: next.id, bid: next.base, bidderId: null } }
        : logged;
    });

    return { ok: true, message: `Sold — ${player.name} to ${team.name} · ${money(price)}` };
  }, [state.block, playerIndex, teams, blockedReason, commit, appendLog, nextAvailable]);

  const pass = useCallback((): IntentResult => {
    if (!state.block) return { ok: false, message: "Nobody is on the block." };
    const player = playerIndex.get(state.block.playerId);
    if (!player) return { ok: false, message: "Unknown player." };

    commit((prev) => {
      const records = {
        ...prev.records,
        [player.id]: { status: "unsold" as const, teamId: null, price: null },
      };
      const logged = appendLog(
        { ...prev, records, block: null },
        "unsold",
        `${player.surname} unsold`,
        null,
      );
      const next = nextAvailable(records);
      return next
        ? { ...logged, block: { playerId: next.id, bid: next.base, bidderId: null } }
        : logged;
    });

    return { ok: true, message: `${player.name} goes unsold` };
  }, [state.block, playerIndex, commit, appendLog, nextAvailable]);

  const returnToPool = useCallback(
    (playerId: number): IntentResult => {
      const player = playerIndex.get(playerId);
      if (!player) return { ok: false, message: "That player is not in the pool." };

      commit((prev) =>
        appendLog(
          { ...prev, records: { ...prev.records, [playerId]: { ...AVAILABLE } } },
          "note",
          `${player.surname} back in the pool`,
          null,
        ),
      );
      return { ok: true, message: `${player.name} returned to the pool` };
    },
    [playerIndex, commit, appendLog],
  );

  const undo = useCallback((): IntentResult => {
    const previous = undoStack.current.pop();
    setCanUndo(undoStack.current.length > 0);
    if (!previous) return { ok: false, message: "Nothing left to undo." };
    setState(previous);
    return { ok: true, message: "Undone" };
  }, []);

  const setRules = useCallback((next: Rules) => setRulesState(next), []);

  const resetAuction = useCallback(() => {
    undoStack.current = [];
    setCanUndo(false);
    setState(EMPTY_STATE);
  }, []);

  return {
    players,
    playerById,
    totalPlayers,
    isLoadingRoster,
    rosterError,
    reloadRoster,

    teams,
    rules,
    block: state.block,
    activePlayer,
    log: state.log,
    recordFor,
    teamById,
    summaries,
    summaryFor,
    blockedReason,
    nextAsk,
    counts,

    putOnBlock,
    bidFor,
    raiseAsk,
    sell,
    pass,
    returnToPool,
    undo,
    canUndo,
    setRules,
    resetAuction,
  };
}
