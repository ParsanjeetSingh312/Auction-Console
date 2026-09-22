/**
 * format.ts
 * Display conventions carried over from auction-console.html.
 *
 * Two rules run through everything here. Money is held in ₹ lakh end to end and
 * only rendered in crore past the 100-lakh mark, and an absent figure always
 * renders as an em dash — never "null", "NaN", or a zero that would read as a
 * genuine worst-in-class result.
 */
import type { CSSProperties } from "react";

import type {
  ApiPlayer,
  CapStatus,
  ConsolePlayer,
  PlayerStats,
  RoleShort,
} from "./types";

/**
 * Pass CSS custom properties through `style`.
 *
 * The console's stylesheet is driven by per-row variables — `--band` for a set
 * colour, `--tc` for a team's — but React's CSSProperties has no index
 * signature for them, so the cast has to happen somewhere. Here, once.
 */
export function cssVars(vars: Record<string, string>): CSSProperties {
  return vars as CSSProperties;
}

/* ------------------------------------------------------------------ *
 * Money and bidding
 * ------------------------------------------------------------------ */

/** ₹ lakh in, long-form string out. */
export function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 100 ? `₹${(value / 100).toFixed(2)} Cr` : `₹${value} L`;
}

/** The compact form used in tables and the ledger, where width is scarce. */
export function moneyTight(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 100 ? `${(value / 100).toFixed(2)}cr` : `${value}L`;
}

/** The auction's increment ladder: the step is a function of the standing bid. */
export function incrementFor(bid: number): number {
  if (bid < 100) return 5;
  if (bid < 200) return 10;
  if (bid < 500) return 20;
  if (bid < 1000) return 25;
  return 50;
}

/* ------------------------------------------------------------------ *
 * Statistics
 * ------------------------------------------------------------------ */

/** A possibly-null statistic, fixed to `digits` places. */
export function stat(value: unknown, digits = 2): string {
  if (value == null) return "—";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "—";
}

/** A possibly-null count, rendered without decimals. */
export function count(value: unknown): string {
  if (value == null) return "—";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.round(numeric)) : "—";
}

/**
 * Ratings in this dataset are bunched between 8.25 and 9.75, so the track is
 * drawn against that window rather than 0–10 — a 0–10 scale would render every
 * bar as an indistinguishable four-fifths full.
 */
const RATING_FLOOR = 8;
const RATING_RANGE = 1.75;

export function ratingPct(rating: number | null | undefined): number {
  if (rating == null || !Number.isFinite(rating)) return 0;
  return Math.max(0, Math.min(100, ((rating - RATING_FLOOR) / RATING_RANGE) * 100));
}

/** Ratings print as 9.5 rather than 9.50, matching the sheet. */
export function ratingLabel(rating: number | null | undefined): string {
  if (rating == null || !Number.isFinite(rating)) return "—";
  return String(Number(rating.toFixed(2)));
}

/** Turn a snake_case column name into a display label. */
export function columnLabel(column: string): string {
  return column.replace(/_/g, " ");
}

/** True when a player has no top-flight record at all. */
export function hasNoRecord(matches: number | null | undefined): boolean {
  return matches == null || matches === 0;
}

/**
 * The stat rows worth showing for a player, in sheet order and already
 * formatted. Bowling rows carry no batting columns and vice versa, so the
 * irrelevant half is dropped rather than rendered as a wall of dashes.
 */
export function statLines(player: ConsolePlayer): { label: string; value: string }[] {
  const s = player.stats;
  const shared = [{ label: "Matches", value: count(s.matches) }];

  if (player.roleShort === "BOWL") {
    return shared.concat([
      { label: "Wickets", value: count(s.wickets) },
      { label: "Runs conceded", value: count(s.runs_conceded) },
      { label: "Economy", value: stat(s.economy) },
      { label: "Bowl avg", value: stat(s.bowl_avg) },
      { label: "Bowl SR", value: stat(s.bowl_sr, 1) },
      { label: "Econ v LHB", value: stat(s.econ_vs_lhb) },
      { label: "Econ v RHB", value: stat(s.econ_vs_rhb) },
    ]);
  }

  return shared.concat([
    { label: "Runs", value: count(s.total_runs) },
    { label: "Bat avg", value: stat(s.bat_avg) },
    { label: "Bat SR", value: stat(s.bat_sr) },
    { label: "SR v spin", value: stat(s.sr_vs_spin) },
    { label: "SR v pace", value: stat(s.sr_vs_fast) },
    { label: "Bnd% spin", value: stat(s.boundary_pct_spin, 1) },
    { label: "Bnd% pace", value: stat(s.boundary_pct_fast, 1) },
  ]);
}

/**
 * The one figure worth showing for a player in a mixed-role list.
 *
 * Which figure that is depends on the role: a bowler's line means nothing said
 * in runs, and a batter's nothing said in wickets.
 */
export function headlineFor(player: ConsolePlayer): string {
  if (hasNoRecord(player.stats.matches)) return "no IPL record";
  if (player.roleShort === "BOWL") {
    return `${count(player.stats.wickets)} wkts · ${stat(player.stats.economy)} econ`;
  }
  return `${count(player.stats.total_runs)} runs · ${stat(player.stats.bat_sr)} SR`;
}

/* ------------------------------------------------------------------ *
 * Roles
 * ------------------------------------------------------------------ */

const ROLE_SHORT: Record<string, RoleShort> = {
  Batter: "BAT",
  Batsman: "BAT",
  Bowler: "BOWL",
  "All-Rounder": "AR",
  "All Rounder": "AR",
  "Wicket Keeper": "WK",
  Wicketkeeper: "WK",
};

export function roleShort(role: string | null | undefined): RoleShort {
  if (!role) return "BAT";
  return ROLE_SHORT[role] ?? "BAT";
}

/**
 * Tailwind class for the role glyph's fill.
 *
 * Spelled out per role rather than built as `bg-role-${code}`: Tailwind
 * generates utilities by scanning source text, so an interpolated class name
 * is simply never emitted and the glyph comes out transparent.
 */
const ROLE_GLYPH_CLASS: Record<RoleShort, string> = {
  BAT: "bg-role-bat",
  BOWL: "bg-role-bowl",
  AR: "bg-role-ar",
  WK: "bg-role-wk",
};

export function roleGlyphClass(code: RoleShort): string {
  return ROLE_GLYPH_CLASS[code];
}

/** Two characters, so every glyph fits the 17px box without truncating oddly. */
const ROLE_GLYPH_TEXT: Record<RoleShort, string> = {
  BAT: "BT",
  BOWL: "BW",
  AR: "AR",
  WK: "WK",
};

export function roleGlyphText(code: RoleShort): string {
  return ROLE_GLYPH_TEXT[code];
}

export const ROLE_LABELS: Record<RoleShort, string> = {
  BAT: "Batter",
  BOWL: "Bowler",
  AR: "All-Rounder",
  WK: "Wicket Keeper",
};

/* ------------------------------------------------------------------ *
 * Sets / bands
 * ------------------------------------------------------------------ */

export interface BandMeta {
  label: string;
  /** Pale fill for the set pill. */
  band: string;
  /** Saturated colour for the 6px row rail. */
  rail: string;
}

/**
 * The sheet's own colour bands. The first eleven are the real auction sets; the
 * BO1/UBO1 pair is the console's own, used when a set has to be derived and the
 * data cannot tell a fast bowler from a spinner.
 */
const SET_META: Record<string, BandMeta> = {
  M1: { label: "Marquee I", band: "#CFE3EE", rail: "#4A85A4" },
  M2: { label: "Marquee II", band: "#D9E7F3", rail: "#5590B6" },
  BA1: { label: "Batters", band: "#DCE4EF", rail: "#6980A4" },
  AL1: { label: "All-rounders", band: "#E4EFCF", rail: "#78A040" },
  WK1: { label: "Wicketkeepers", band: "#D2EDE0", rail: "#3C9B78" },
  FA1: { label: "Fast bowlers", band: "#F8DFCD", rail: "#CF7639" },
  SP1: { label: "Spinners", band: "#F7EACC", rail: "#C1932A" },
  BO1: { label: "Bowlers", band: "#F8DFCD", rail: "#CF7639" },
  UBA1: { label: "Uncapped batters", band: "#F3DFE4", rail: "#BC6A7F" },
  UAL1: { label: "Uncapped all-rounders", band: "#E7DCF1", rail: "#8768AD" },
  UWK1: { label: "Uncapped keepers", band: "#DDE5F3", rail: "#5C76A6" },
  UFA1: { label: "Uncapped fast bowlers", band: "#FADFD2", rail: "#CC6547" },
  UBO1: { label: "Uncapped bowlers", band: "#FADFD2", rail: "#CC6547" },
};

const FALLBACK_META: BandMeta = { label: "Unbanded", band: "#E7EAE5", rail: "#98A29B" };

export function setMeta(code: string): BandMeta {
  return SET_META[code] ?? { ...FALLBACK_META, label: code };
}

/**
 * Derive a grouping band from role and cap status.
 *
 * GET /api/v1/players does not expose the sheet's set code — the RAG `players`
 * table has no such column — so the console reconstructs the one grouping the
 * data can actually support. It deliberately stops short of guessing at the
 * marquee sets or the pace/spin split, which are editorial calls the dataset
 * does not record: capped bowlers land in a single BO1 band rather than being
 * split between FA1 and SP1 on no evidence.
 *
 * If the backend later returns `set_code`, that value wins and this is unused.
 */
export function bandFor(roleCode: RoleShort, cap: CapStatus): string {
  const base: Record<RoleShort, string> = {
    BAT: "BA1",
    AR: "AL1",
    WK: "WK1",
    BOWL: "BO1",
  };
  return (cap === "UNCAPPED" ? "U" : "") + base[roleCode];
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

/**
 * The auction's floor, in ₹ lakh, and the stand-in for a missing base price.
 * It is the lowest figure the dataset actually records.
 */
export const BASE_PRICE_FLOOR = 30;

/**
 * Country, or null when the dataset does not actually know it. 77 overseas rows
 * store the literal string "Overseas"; rendering that in a Country column reads
 * as though it were a nation, so callers show a dash and let ✈ carry the one
 * fact that is genuinely known.
 */
export function countryLabel(country: string | null | undefined): string | null {
  if (!country || country === "Overseas" || country === "Unknown") return null;
  return country;
}

/**
 * Split a full name into first name and surname.
 *
 * The dataset stores one `player_name` string, but the console's pool table and
 * block card set the surname in bold caps above a lighter first name, so the
 * two halves have to be recovered. The first token is the given name and the
 * remainder the surname, which keeps multi-word surnames ("De Kock") intact.
 */
export function splitName(full: string): { first: string; surname: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length <= 1) return { first: "", surname: parts[0] ?? "" };
  return { first: parts[0], surname: parts.slice(1).join(" ") };
}

function pickStats(row: ApiPlayer): PlayerStats {
  return {
    matches: row.matches,
    total_runs: row.total_runs,
    bat_avg: row.bat_avg,
    bat_sr: row.bat_sr,
    sr_vs_spin: row.sr_vs_spin,
    sr_vs_fast: row.sr_vs_fast,
    boundary_pct_spin: row.boundary_pct_spin,
    boundary_pct_fast: row.boundary_pct_fast,
    wickets: row.wickets,
    runs_conceded: row.runs_conceded,
    economy: row.economy,
    bowl_avg: row.bowl_avg,
    bowl_sr: row.bowl_sr,
    econ_vs_lhb: row.econ_vs_lhb,
    econ_vs_rhb: row.econ_vs_rhb,
  };
}

/**
 * Turn one API row into the console's working shape.
 *
 * `index` supplies the sheet number: the RAG table has no `sno` column, so the
 * backend's own `ORDER BY id` sequence stands in for auction-day ordering.
 */
export function toConsolePlayer(row: ApiPlayer, index: number): ConsolePlayer {
  const { first, surname } = splitName(row.player_name);
  const code = roleShort(row.role);
  const cap: CapStatus = row.cap_status === "UNCAPPED" ? "UNCAPPED" : "CAPPED";
  const apiSet = row.set_code ?? null;

  return {
    // A row without an id cannot be bid on or persisted, so fall back to the
    // ordinal rather than dropping the player from the pool entirely.
    id: row.id ?? index + 1,
    sno: index + 1,
    jersey: row.jersey_number ?? null,
    name: row.player_name,
    first,
    surname,
    country: countryLabel(row.country),
    overseas: row.overseas === 1,
    role: row.role,
    roleShort: code,
    cap,
    set: apiSet ?? bandFor(code, cap),
    setDerived: apiSet === null,
    // Bidding needs a starting number and 0 would read as a free player, so a
    // missing base price falls back to the auction floor — flagged, not hidden.
    base: row.base_price ?? BASE_PRICE_FLOOR,
    baseAssumed: row.base_price == null,
    rating: row.rating,
    stats: pickStats(row),
  };
}

/* ------------------------------------------------------------------ *
 * Answer parsing
 * ------------------------------------------------------------------ */

/**
 * The backend prefixes its answer with this marker when no LLM key is
 * configured, then falls back to dumping the raw retrieval payload as text.
 */
const LLM_UNAVAILABLE = "[LLM unavailable";

/** Heading the fallback path uses before repeating the ranked sources. */
const RAW_DUMP_HEADING = /\*\*Semantic Search Results/i;

export interface ParsedAnswer {
  /** False when the backend answered without an LLM. */
  llmAvailable: boolean;
  /** Operational messages worth surfacing separately, e.g. a SQL failure. */
  notices: string[];
  /** Prose worth rendering. Empty when the payload was only a raw dump. */
  body: string;
}

/**
 * Split a raw answer into a renderable body plus notices.
 *
 * Without an API key the answer is a plain-text dump of the same sources and
 * rows that render properly in their own sections below, so it is dropped
 * rather than shown twice.
 */
export function parseAnswer(answer: string): ParsedAnswer {
  const llmAvailable = !answer.includes(LLM_UNAVAILABLE);
  const notices: string[] = [];

  let text = answer;
  if (!llmAvailable) {
    const cut = text.search(RAW_DUMP_HEADING);
    if (cut !== -1) text = text.slice(0, cut);
  }

  const body = text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "---") return false;
      if (trimmed.includes(LLM_UNAVAILABLE)) return false;
      if (/error:/i.test(trimmed)) {
        notices.push(trimmed.replace(/\*\*/g, ""));
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();

  return { llmAvailable, notices, body };
}

/**
 * Minimal inline renderer for the `**bold**` the LLM prompts produce. Returns
 * alternating plain and emphasised segments; anything else is left as text.
 */
export function boldSegments(text: string): { text: string; bold: boolean }[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter((part) => part !== "")
    .map((part) =>
      part.startsWith("**") && part.endsWith("**")
        ? { text: part.slice(2, -2), bold: true }
        : { text: part, bold: false },
    );
}
