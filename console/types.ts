/**
 * types.ts
 * The console's single player shape, plus the auction-side state the RAG
 * backend does not (and should not) own.
 *
 * There are two data authorities in play and it is worth being explicit about
 * which owns what:
 *
 *   - The RAG backend (GET /api/v1/players) owns player identity and the 17
 *     scouting attributes. It is read-only and shared with the search engine,
 *     so the same row that the vector index describes is the row the console
 *     renders. Nothing here writes back to it.
 *   - The console owns auction state: who is on the block, the standing bid,
 *     what each team has spent, and the ledger. None of that exists in the RAG
 *     schema, so it lives in the client (and in localStorage) exactly as it did
 *     in the auction-console.html prototype.
 */

/** A role exactly as the backend spells it. */
export type Role = "Batter" | "Bowler" | "All-Rounder" | "Wicket Keeper";

/** The four-way short code the sheet uses for glyphs and grouping. */
export type RoleShort = "BAT" | "BOWL" | "AR" | "WK";

export type CapStatus = "CAPPED" | "UNCAPPED";

export type PlayerStatus = "available" | "sold" | "unsold";

/**
 * A player row from GET /api/v1/players, exactly as PlayerResponse emits it.
 *
 * Every statistic is nullable because availability is role-dependent in this
 * dataset: bowlers carry no batting columns and batters no bowling columns.
 * `set_code` is not part of PlayerResponse today — it is declared optional so
 * that the console picks it up automatically if the backend ever adds it.
 */
export interface ApiPlayer {
  id: number | null;
  player_name: string;
  country: string | null;
  role: string;
  cap_status: string | null;
  overseas: number | null;
  base_price: number | null;
  rating: number | null;
  matches: number | null;
  total_runs: number | null;
  bat_avg: number | null;
  bat_sr: number | null;
  boundary_pct_spin: number | null;
  boundary_pct_fast: number | null;
  sr_vs_spin: number | null;
  sr_vs_fast: number | null;
  wickets: number | null;
  runs_conceded: number | null;
  economy: number | null;
  bowl_avg: number | null;
  bowl_sr: number | null;
  econ_vs_lhb: number | null;
  econ_vs_rhb: number | null;
  set_code?: string | null;
}

/** The stat block, split by which half of the sheet it comes from. */
export interface PlayerStats {
  matches: number | null;
  // Batting — Batter / Wicket Keeper / All-Rounder.
  total_runs: number | null;
  bat_avg: number | null;
  bat_sr: number | null;
  sr_vs_spin: number | null;
  sr_vs_fast: number | null;
  boundary_pct_spin: number | null;
  boundary_pct_fast: number | null;
  // Bowling — Bowler.
  wickets: number | null;
  runs_conceded: number | null;
  economy: number | null;
  bowl_avg: number | null;
  bowl_sr: number | null;
  econ_vs_lhb: number | null;
  econ_vs_rhb: number | null;
}

/**
 * The console's working player: the API row normalised for display, with the
 * name split so the pool table can set the surname in the sheet's bold caps.
 */
export interface ConsolePlayer {
  /** The RAG backend's primary key. Stable across reloads. */
  id: number;
  /** Display order. Derived from the API's own ordering, not stored upstream. */
  sno: number;
  name: string;
  first: string;
  surname: string;
  /**
   * Null when the dataset only knows the player is not Indian — 77 rows store
   * the literal placeholder "Overseas", which reads as a nation if rendered.
   */
  country: string | null;
  overseas: boolean;
  role: string;
  roleShort: RoleShort;
  cap: CapStatus;
  /**
   * Grouping band. The backend's `set_code` when present, otherwise derived
   * from role × cap status — see `bandFor` in format.ts.
   */
  set: string;
  /** True when `set` was derived here rather than read from the backend. */
  setDerived: boolean;
  base: number;
  /**
   * True when `base` is the auction floor standing in for a missing figure.
   * Two thirds of the current dataset has no `base_price`, and bidding needs a
   * number, so the floor is substituted — but the UI marks it rather than
   * passing it off as the sheet's own.
   */
  baseAssumed: boolean;
  rating: number | null;
  stats: PlayerStats;
}

/** Auction state the console owns, keyed by player id. */
export interface AuctionRecord {
  status: PlayerStatus;
  teamId: number | null;
  price: number | null;
}

export interface Team {
  id: number;
  name: string;
  code: string;
  color: string;
}

export interface Rules {
  /** Purse per team, in ₹ lakh. */
  purse: number;
  maxSquad: number;
  minSquad: number;
  maxOverseas: number;
}

export interface BlockState {
  playerId: number;
  /** Standing ask, in ₹ lakh. */
  bid: number;
  bidderId: number | null;
}

export type LogKind = "note" | "bid" | "sold" | "unsold";

export interface LogEntry {
  seq: number;
  kind: LogKind;
  what: string;
  amount: number | null;
  ts: number;
}

export interface TeamSummary {
  team: Team;
  squad: ConsolePlayer[];
  spent: number;
  left: number;
  overseas: number;
  /** The most this team can bid without stranding its minimum squad. */
  maxBid: number;
  composition: Record<RoleShort, number>;
  size: number;
}

/** Pool filters, mirroring the prototype's filter strip. */
export interface PoolFilters {
  status: PlayerStatus | "all";
  role: RoleShort | "all";
  cap: CapStatus | "all";
  set: string;
  country: string;
  minRating: number;
}

export type SortKey =
  | "sno"
  | "set"
  | "name"
  | "country"
  | "role"
  | "cap"
  | "base"
  | "rating"
  | "status"
  | "price";
