/**
 * aucteamStore.ts
 * AUCTEAM's state: the pool, the eleven, the live check and the report.
 *
 * WHY NOT ZUSTAND
 * ===============
 *
 * The brief names Zustand; the repository has a standing decision against a
 * new global store library (auctiq-architecture.md §9) and already has a house
 * pattern for exactly this -- `scoutStore.ts`, a module-level store read
 * through `useSyncExternalStore`. This file follows that pattern and exposes a
 * Zustand-shaped surface: `useAucteam(selector)` for reads, plain exported
 * functions for actions. Moving to Zustand later is a mechanical change.
 *
 * Selectors must return a primitive or a reference already held in state.
 * Building a fresh object or array inside one would hand React a new snapshot
 * on every read and loop. Derived lists live in hooks at the bottom, behind
 * useMemo.
 *
 * THE FLOW
 * ========
 *
 *   addPlayer ─► client preflight ─► roster changes ─► (debounced) /validate
 *                                                         │
 *                         complete && legal ◄─────────────┘
 *                                │
 *                                └─► /report, keyed by the roster's signature
 *
 * The client preflight refuses only what the server would also refuse
 * (eleven, duplicates, overseas, a keeper slot), so a drag that cannot succeed
 * snaps back at once instead of after a round trip. The server's check is
 * still the authority: it re-reads every player from the database.
 *
 * Each request is keyed. A /validate superseded by a newer change is aborted,
 * and a report that arrives for an eleven the user has since changed is
 * discarded rather than shown against the wrong team.
 */
import { useMemo, useSyncExternalStore } from "react";

import {
  fetchPool,
  requestReport,
  validateTeam,
  type AucteamPlayer,
  type RoleCode,
  type RosterRules,
  type TeamReport,
  type TierCode,
  type ValidateResponse,
} from "./aucteamApi";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface Refusal {
  playerId: number;
  message: string;
  /** Bumped per refusal so the same message twice still re-triggers a shake. */
  nonce: number;
}

export interface AucteamFilters {
  tier: TierCode | "ALL";
  role: RoleCode | "ALL";
  query: string;
}

export interface AucteamState {
  pool: AucteamPlayer[];
  poolStatus: LoadStatus;
  poolError: string | null;
  rules: RosterRules | null;

  /** Player ids in pick order. Never more than rules.squad_size. */
  roster: number[];
  teamName: string;

  filters: AucteamFilters;

  check: ValidateResponse | null;
  checking: boolean;

  report: TeamReport | null;
  reportStatus: LoadStatus;
  reportError: string | null;

  /** The card being dragged, and whether it is over the board. */
  dragId: number | null;
  dragOverBoard: boolean;

  refusal: Refusal | null;
}

const DEFAULT_SQUAD = 11;
const DEFAULT_MAX_OVERSEAS = 4;
const STORAGE_KEY = "auctoniq:aucteam:v1";
const VALIDATE_DEBOUNCE_MS = 140;

function restore(): Pick<AucteamState, "roster" | "teamName"> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { roster: [], teamName: "" };
    const saved = JSON.parse(raw);
    const roster = Array.isArray(saved.roster)
      ? saved.roster.filter((id: unknown) => Number.isInteger(id)).slice(0, DEFAULT_SQUAD)
      : [];
    const teamName = typeof saved.teamName === "string" ? saved.teamName.slice(0, 40) : "";
    return { roster: [...new Set<number>(roster)], teamName };
  } catch {
    return { roster: [], teamName: "" };
  }
}

function persist(): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ roster: state.roster, teamName: state.teamName }),
    );
  } catch {
    /* private mode or storage full: the board simply does not survive a refresh */
  }
}

let state: AucteamState = {
  pool: [],
  poolStatus: "idle",
  poolError: null,
  rules: null,
  ...restore(),
  filters: { tier: "ALL", role: "ALL", query: "" },
  check: null,
  checking: false,
  report: null,
  reportStatus: "idle",
  reportError: null,
  dragId: null,
  dragOverBoard: false,
  refusal: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<AucteamState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAucteamState(): AucteamState {
  return state;
}

/** Read a slice. See the header: return primitives or held references only. */
export function useAucteam<T>(selector: (s: AucteamState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

let poolController: AbortController | null = null;

export async function loadPool(): Promise<void> {
  if (state.poolStatus === "loading" || state.poolStatus === "ready") return;
  poolController?.abort();
  poolController = new AbortController();
  set({ poolStatus: "loading", poolError: null });
  try {
    const response = await fetchPool(poolController.signal);
    const known = new Set(response.players.map((p) => p.id));
    // A restored roster may name a player a re-ingest has since removed.
    const roster = state.roster.filter((id) => known.has(id));
    set({ pool: response.players, rules: response.rules, poolStatus: "ready", roster });
    persist();
    scheduleValidate();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    set({
      poolStatus: "error",
      poolError: error instanceof Error ? error.message : "Could not load the player pool.",
    });
  }
}

export function retryPool(): void {
  set({ poolStatus: "idle" });
  void loadPool();
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

function squadSize(): number {
  return state.rules?.squad_size ?? DEFAULT_SQUAD;
}

function playerById(id: number): AucteamPlayer | undefined {
  return state.pool.find((p) => p.id === id);
}

let refusalNonce = 0;

function refuse(playerId: number, message: string): { ok: false; reason: string } {
  set({ refusal: { playerId, message, nonce: ++refusalNonce } });
  return { ok: false, reason: message };
}

/**
 * Why `player` cannot join the current eleven, or null if they can. Mirrors
 * the server's hard rules; the role bands are advice and never refuse a pick.
 */
export function refusalFor(player: AucteamPlayer, roster: number[] = state.roster): string | null {
  const size = squadSize();
  if (roster.includes(player.id)) return `${player.name} is already in your XI.`;
  if (roster.length >= size) return `Your XI is full — remove a player to make room.`;

  const picked = roster.map(playerById).filter(Boolean) as AucteamPlayer[];
  const maxOverseas = state.rules?.max_overseas ?? DEFAULT_MAX_OVERSEAS;
  if (player.overseas && picked.filter((p) => p.overseas).length >= maxOverseas) {
    return `Only ${maxOverseas} overseas players can take the field.`;
  }

  const minKeepers = state.rules?.min_wicketkeepers ?? 1;
  const keepers = picked.filter((p) => p.role === "WK").length + (player.role === "WK" ? 1 : 0);
  const slotsAfter = size - roster.length - 1;
  if (keepers + slotsAfter < minKeepers) {
    return "Keep that slot for a wicketkeeper — every XI needs one.";
  }
  return null;
}

export function addPlayer(id: number): { ok: boolean; reason?: string } {
  const player = playerById(id);
  if (!player) return { ok: false, reason: "Unknown player." };
  const reason = refusalFor(player);
  if (reason) return refuse(id, reason);
  set({ roster: [...state.roster, id], refusal: null });
  rosterChanged();
  return { ok: true };
}

export function removePlayer(id: number): void {
  if (!state.roster.includes(id)) return;
  set({ roster: state.roster.filter((x) => x !== id) });
  rosterChanged();
}

export function togglePlayer(id: number): void {
  if (state.roster.includes(id)) removePlayer(id);
  else addPlayer(id);
}

export function clearRoster(): void {
  set({ roster: [], check: null });
  rosterChanged();
}

/**
 * Start a new XI: every pick goes back to the pool, and the check and the
 * report go with them. Any request still in flight is abandoned, so a report
 * for the old eleven can never land on the empty board. The team name stays.
 *
 * The animation that carries the picks home lives in
 * components/Aucteam/resetFlight.ts; this is only the state change it ends on.
 */
export function resetBuild(): void {
  window.clearTimeout(validateTimer);
  validateController?.abort();
  reportController?.abort();
  reportFor = null;
  set({
    roster: [],
    check: null,
    checking: false,
    report: null,
    reportStatus: "idle",
    reportError: null,
    refusal: null,
  });
  persist();
}

export function setTeamName(name: string): void {
  set({ teamName: name.slice(0, 40) });
  persist();
}

export function dismissRefusal(): void {
  if (state.refusal) set({ refusal: null });
}

// ---------------------------------------------------------------------------
// Filters and drag
// ---------------------------------------------------------------------------

export function setFilter(patch: Partial<AucteamFilters>): void {
  set({ filters: { ...state.filters, ...patch } });
}

export function setDrag(id: number | null): void {
  set({ dragId: id, dragOverBoard: id === null ? false : state.dragOverBoard });
}

export function setDragOverBoard(over: boolean): void {
  if (state.dragOverBoard !== over) set({ dragOverBoard: over });
}

// ---------------------------------------------------------------------------
// Validate, then report
// ---------------------------------------------------------------------------

let validateTimer: number | undefined;
let validateController: AbortController | null = null;
let reportController: AbortController | null = null;
/** The roster signature the in-flight or shown report belongs to. */
let reportFor: string | null = null;

function signature(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(",");
}

function rosterChanged(): void {
  persist();
  // A report describes one specific eleven. Any change makes it about a team
  // that no longer exists, so it goes -- and so does a request still running.
  if (reportFor !== null && reportFor !== signature(state.roster)) {
    reportController?.abort();
    reportFor = null;
    set({ report: null, reportStatus: "idle", reportError: null });
  }
  scheduleValidate();
}

function scheduleValidate(): void {
  window.clearTimeout(validateTimer);
  validateController?.abort();
  if (state.roster.length === 0) {
    set({ check: null, checking: false });
    return;
  }
  set({ checking: true });
  validateTimer = window.setTimeout(runValidate, VALIDATE_DEBOUNCE_MS);
}

async function runValidate(): Promise<void> {
  const ids = [...state.roster];
  const controller = new AbortController();
  validateController = controller;
  try {
    const check = await validateTeam(ids, controller.signal);
    if (controller.signal.aborted) return;
    set({ check, checking: false });
    if (check.complete && check.legal) void generateReport();
  } catch (error) {
    if (controller.signal.aborted) return;
    // A failed check is not fatal to building: the client preflight still
    // guards the hard rules. Leave the last good check on screen.
    void error;
    set({ checking: false });
  }
}

/** Ask SCOUT for the report on the current eleven. Safe to call repeatedly. */
export async function generateReport(force = false): Promise<void> {
  const ids = [...state.roster];
  if (ids.length !== squadSize()) return;
  const sig = signature(ids);
  if (!force && reportFor === sig && state.reportStatus !== "error") return;

  reportController?.abort();
  const controller = new AbortController();
  reportController = controller;
  reportFor = sig;
  set({ reportStatus: "loading", reportError: null, report: null });

  try {
    const report = await requestReport(ids, state.teamName.trim() || null, controller.signal);
    if (controller.signal.aborted || reportFor !== sig) return;
    set({ report, reportStatus: "ready" });
  } catch (error) {
    if (controller.signal.aborted) return;
    set({
      reportStatus: "error",
      reportError: error instanceof Error ? error.message : "SCOUT could not write the report.",
    });
  }
}

// ---------------------------------------------------------------------------
// Derived reads
// ---------------------------------------------------------------------------

/** The picked players, in pick order. */
export function useRosterPlayers(): AucteamPlayer[] {
  const pool = useAucteam((s) => s.pool);
  const roster = useAucteam((s) => s.roster);
  return useMemo(() => {
    const byId = new Map(pool.map((p) => [p.id, p]));
    return roster.map((id) => byId.get(id)).filter(Boolean) as AucteamPlayer[];
  }, [pool, roster]);
}

/** The pool after the tier, role and name filters. Picked players stay listed. */
export function useFilteredPool(): AucteamPlayer[] {
  const pool = useAucteam((s) => s.pool);
  const filters = useAucteam((s) => s.filters);
  return useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    const tierRank: Record<TierCode, number> = { MQ: 0, PR: 1, EM: 2 };
    return pool
      .filter((p) => filters.tier === "ALL" || p.tier === filters.tier)
      .filter((p) => filters.role === "ALL" || p.role === filters.role)
      .filter((p) => !query || p.name.toLowerCase().includes(query) || p.country.toLowerCase().includes(query))
      .sort(
        (a, b) =>
          tierRank[a.tier] - tierRank[b.tier] ||
          (b.rating ?? -1) - (a.rating ?? -1) ||
          (b.matches ?? 0) - (a.matches ?? 0),
      );
  }, [pool, filters]);
}
