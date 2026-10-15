/**
 * aucteamApi.ts
 * The AUCTEAM endpoints, typed. The only file that knows their paths.
 *
 * The interfaces mirror `ipl_auction_rag_backend/aucteam/aucteam_schema.py`
 * field for field. If one changes, both must.
 *
 * Only ids ever travel up. Role, tier, overseas status and every statistic
 * come back from the server, so the board can never claim a player is
 * something the players table says he is not.
 */
import { apiUrl } from "./apiBase";

export type TierCode = "MQ" | "PR" | "EM";
export type RoleCode = "BAT" | "WK" | "AR" | "BWL";
export type Severity = "block" | "warn" | "info";

export const TIER_NAMES: Record<TierCode, string> = {
  MQ: "Marquee",
  PR: "Prime",
  EM: "Emerging",
};

export const ROLE_NAMES: Record<RoleCode, string> = {
  BAT: "Batters",
  WK: "Wicketkeeper",
  AR: "All-Rounders",
  BWL: "Bowlers",
};

/** Board order, top to bottom: the order a scorecard reads. */
export const ROLE_ORDER: RoleCode[] = ["BAT", "WK", "AR", "BWL"];

export interface CardStat {
  key: string;
  label: string;
  value: number | null;
  format: "int" | "dec1" | "dec2";
}

export interface AucteamPlayer {
  id: number;
  name: string;
  role: RoleCode;
  role_label: string;
  tier: TierCode;
  tier_source: "curated" | "derived";
  tier_reason: string;
  jersey_number: number | null;
  country: string;
  overseas: boolean;
  capped: boolean;
  rating: number | null;
  matches: number | null;
  /** Six, in card order: three left of the number, three right. */
  stats: CardStat[];
}

export interface RosterRules {
  squad_size: number;
  max_overseas: number;
  min_wicketkeepers: number;
  min_bowling_options: number;
  role_bands: Record<RoleCode, [number, number]>;
}

export interface PoolResponse {
  total: number;
  players: AucteamPlayer[];
  tier_counts: Record<TierCode, number>;
  rules: RosterRules;
}

export interface RosterIssue {
  severity: Severity;
  code: string;
  message: string;
}

export interface TeamMetrics {
  size: number;
  role_counts: Record<RoleCode, number>;
  tier_counts: Record<TierCode, number>;
  overseas: number;
  uncapped: number;
  total_matches: number;
  avg_matches: number;
  marquee_share: number;
  emerging_share: number;
  bowling_options: number;
  power_hitters: number;
  top_order_avg: number | null;
  bowling_economy: number | null;
  most_capped: string | null;
  least_capped: string | null;
}

export interface ValidateResponse {
  metrics: TeamMetrics;
  issues: RosterIssue[];
  complete: boolean;
  legal: boolean;
  scout_prompt: string;
}

export interface ReportSection {
  title: string;
  verdict: string;
  body: string;
}

export interface TeamReport {
  report_id: number | null;
  team_name: string | null;
  grade: "A" | "B" | "C" | "D";
  score: number;
  headline: string;
  summary: string;
  balance: ReportSection;
  experience: ReportSection;
  strengths: string[];
  missing_links: string[];
  avoidable: string[];
  mode: "llm" | "local_analyst";
  notes: string[];
  metrics: TeamMetrics;
  issues: RosterIssue[];
  roster: AucteamPlayer[];
}

export class AucteamError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "AucteamError";
  }
}

/**
 * FastAPI's `detail` is a string for an HTTPException and a list of
 * `{loc, msg}` for a validation failure. Either way, one readable sentence.
 */
function describeDetail(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => (item && typeof item === "object" && "msg" in item ? String(item.msg) : null))
      .filter(Boolean)
      // Pydantic prefixes a custom ValueError with this; the user does not need it.
      .map((msg) => (msg as string).replace(/^Value error, /, ""));
    return messages.length ? messages.join(" ") : null;
  }
  return null;
}

async function call<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const relay = () => controller.abort();
  signal?.addEventListener("abort", relay);
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(apiUrl(`/api/v1/aucteam${path}`), {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail: string | null = null;
      try {
        detail = describeDetail((await response.json()).detail);
      } catch {
        /* not JSON: fall back to the status line */
      }
      throw new AucteamError(detail ?? `${response.status} ${response.statusText}`, response.status);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof AucteamError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      if (signal?.aborted) throw error;
      throw new AucteamError("SCOUT took too long to answer. Try again in a moment.");
    }
    throw new AucteamError("Cannot reach the AUCTONIQ server. Is it running?");
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

/**
 * GET /pool — every player as a card, with the roster rules.
 *
 * A long deadline on purpose. The first read after a server start can take
 * 20-30 s when the players table sits behind a slow or paused Supabase
 * connection; the server caches the pool afterwards, so only this first call
 * ever waits that long.
 */
export function fetchPool(signal?: AbortSignal): Promise<PoolResponse> {
  return call<PoolResponse>("/pool", {}, 90_000, signal);
}

/** POST /validate — the live check, on every change to the board. */
export function validateTeam(playerIds: number[], signal?: AbortSignal): Promise<ValidateResponse> {
  return call<ValidateResponse>(
    "/validate",
    { method: "POST", body: JSON.stringify({ player_ids: playerIds }) },
    30_000,
    signal,
  );
}

/**
 * POST /report — the finished eleven's report. Up to ~45 s server-side when a
 * language model writes it, so the client waits a little longer than that.
 */
export function requestReport(
  playerIds: number[],
  teamName: string | null,
  signal?: AbortSignal,
): Promise<TeamReport> {
  return call<TeamReport>(
    "/report",
    { method: "POST", body: JSON.stringify({ player_ids: playerIds, team_name: teamName }) },
    75_000,
    signal,
  );
}
