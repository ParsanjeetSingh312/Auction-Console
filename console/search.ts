/**
 * search.ts
 * The console's local search engine — the prototype's, typed, and extended to
 * the stat columns the RAG backend now supplies.
 *
 * This is deliberately *not* the RAG search. It runs in-process over the roster
 * already in memory and answers in under a millisecond, because on auction day
 * the search bar's job is to put a named player on the block before the
 * auctioneer finishes saying the name. A round trip to a reranker is the wrong
 * tool for that. Natural-language scouting goes to POST /api/v1/search instead,
 * and the search dropdown offers a one-key hand-off to it.
 *
 * Free text is fuzzy-matched against name / country / role / band. Operators
 * (`role:`, `cap:`, `sr:>140`, …) filter exactly.
 */
import { setMeta } from "./format";
import type { AuctionRecord, ConsolePlayer, PlayerStats, Team } from "./types";

/* ------------------------------------------------------------------ *
 * Query parsing
 * ------------------------------------------------------------------ */

/** Operator spellings a user might reasonably reach for. */
const FIELD_ALIASES: Record<string, string> = {
  r: "role",
  role: "role",
  spec: "role",
  c: "country",
  country: "country",
  nat: "country",
  s: "set",
  set: "set",
  band: "set",
  cap: "cap",
  capped: "cap",
  st: "status",
  status: "status",
  t: "team",
  team: "team",
  rt: "rating",
  rating: "rating",
  bp: "base",
  base: "base",
  price: "soldprice",
  paid: "soldprice",
};

const ROLE_ALIASES: Record<string, string> = {
  bat: "BAT",
  batter: "BAT",
  batsman: "BAT",
  batsmen: "BAT",
  bowl: "BOWL",
  bowler: "BOWL",
  bowlers: "BOWL",
  pace: "BOWL",
  spin: "BOWL",
  ar: "AR",
  all: "AR",
  allrounder: "AR",
  "all-rounder": "AR",
  rounder: "AR",
  wk: "WK",
  keeper: "WK",
  wicketkeeper: "WK",
};

/**
 * Numeric operators mapped onto the stat block, so `sr:>150` and `econ:<8`
 * filter the pool the same way the RAG backend's generated SQL would.
 */
const STAT_ALIASES: Record<string, keyof PlayerStats> = {
  mat: "matches",
  matches: "matches",
  runs: "total_runs",
  avg: "bat_avg",
  batavg: "bat_avg",
  sr: "bat_sr",
  batsr: "bat_sr",
  srspin: "sr_vs_spin",
  srpace: "sr_vs_fast",
  srfast: "sr_vs_fast",
  bndspin: "boundary_pct_spin",
  bndpace: "boundary_pct_fast",
  wkts: "wickets",
  wickets: "wickets",
  conceded: "runs_conceded",
  econ: "economy",
  economy: "economy",
  bowlavg: "bowl_avg",
  bowlsr: "bowl_sr",
  econlhb: "econ_vs_lhb",
  econrhb: "econ_vs_rhb",
};

export interface QueryOp {
  key: string;
  raw: string;
}

export interface ParsedQuery {
  text: string;
  ops: QueryOp[];
}

/**
 * Split raw input into free text and operators.
 *
 * A bare comparison (`>9.5`) is treated as a rating shorthand, since rating is
 * the only figure every player in the pool carries.
 */
export function parseQuery(raw: string): ParsedQuery {
  const ops: QueryOp[] = [];
  const words: string[] = [];

  for (const token of String(raw ?? "").trim().split(/\s+/)) {
    if (!token) continue;

    const field = token.match(/^([a-zA-Z][\w-]*):(.+)$/);
    if (field) {
      const lower = field[1].toLowerCase();
      ops.push({ key: FIELD_ALIASES[lower] ?? lower, raw: field[2] });
      continue;
    }

    if (/^(>=|<=|>|<|=)\d+(?:\.\d+)?$/.test(token)) {
      ops.push({ key: "rating", raw: token });
      continue;
    }

    words.push(token);
  }

  return { text: words.join(" "), ops };
}

/** Compare a possibly-null figure against an expression like `>=140`. */
function cmpNum(value: unknown, expr: string): boolean {
  if (value == null) return false;
  const left = Number(value);
  if (!Number.isFinite(left)) return false;

  const parsed = String(expr).match(/^(>=|<=|>|<|=)?\s*(-?\d+(?:\.\d+)?)$/);
  if (!parsed) return false;
  const right = Number(parsed[2]);

  switch (parsed[1]) {
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    default:
      return left === right;
  }
}

const norm = (value: string | null | undefined): string =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export interface OpContext {
  record: AuctionRecord;
  teams: Team[];
  onBlockId: number | null;
}

function opMatches(player: ConsolePlayer, op: QueryOp, ctx: OpContext): boolean {
  const value = op.raw.toLowerCase().replace(/^["']|["']$/g, "");

  switch (op.key) {
    case "role":
      return (
        ROLE_ALIASES[value] === player.roleShort ||
        player.roleShort.toLowerCase() === value ||
        norm(player.role).startsWith(value)
      );

    case "country": {
      if (value === "os") return player.overseas;
      if (value === "ind") return !player.overseas;
      const country = norm(player.country).replace(/ /g, "");
      return country !== "" && country.startsWith(value.replace(/ /g, ""));
    }

    case "set":
      return (
        player.set.toLowerCase() === value ||
        norm(setMeta(player.set).label).includes(value)
      );

    case "cap":
      if (["y", "yes", "c", "capped", "true"].includes(value)) return player.cap === "CAPPED";
      if (["n", "no", "uc", "uncapped", "false"].includes(value)) return player.cap === "UNCAPPED";
      return true;

    case "status":
      if (value === "block") return ctx.onBlockId === player.id;
      return ctx.record.status.startsWith(value);

    case "team": {
      if (ctx.record.teamId == null) return false;
      const team = ctx.teams.find((t) => t.id === ctx.record.teamId);
      return !!team && (team.code.toLowerCase() === value || norm(team.name).startsWith(value));
    }

    case "rating":
      return cmpNum(player.rating, op.raw);
    case "base":
      return cmpNum(player.base, op.raw);
    case "soldprice":
      return cmpNum(ctx.record.price, op.raw);

    default: {
      const statKey = STAT_ALIASES[op.key.replace(/[_-]/g, "")];
      if (statKey) return cmpNum(player.stats[statKey], op.raw);
      // An unrecognised operator is ignored rather than fatal — the user is
      // most likely mid-type.
      return true;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Fuzzy scoring
 *
 * Matching runs in three tiers so results stay predictable:
 *   A. substring      "kohl"  → Kohli,  "de kock" → De Kock
 *   B. initials       "vk"    → Virat Kohli
 *   C. subsequence within a single word — typo tolerance, "klasen" → Klaasen
 *
 * Cross-word subsequence is deliberately not allowed: it made "starc" match
 * Marcus Stoinis. Tier scores are banded so A always outranks B outranks C.
 * ------------------------------------------------------------------ */

interface Hit {
  score: number;
  marks: number[];
}

function fuzzySeq(word: string, needle: string): Hit | null {
  let cursor = 0;
  let score = 0;
  let streak = 0;
  const marks: number[] = [];

  for (const ch of needle) {
    let found = -1;
    for (let k = cursor; k < word.length; k++) {
      if (word[k] === ch) {
        found = k;
        break;
      }
    }
    if (found < 0) return null;

    score += 10 + (found === 0 ? 12 : 0) + (streak ? 10 : 0) - Math.min(found - cursor, 5);
    marks.push(found);
    streak = found === cursor ? streak + 1 : 1;
    cursor = found + 1;
  }

  return { score, marks };
}

function wordStarts(haystack: string): { w: string; i: number }[] {
  const out: { w: string; i: number }[] = [];
  const re = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack))) out.push({ w: m[0], i: m.index });
  return out;
}

export function scoreOne(haystack: string, needle: string, strict = false): Hit | null {
  const hay = haystack.toLowerCase();
  const need = needle.toLowerCase().trim();
  if (!need) return { score: 0, marks: [] };

  let best: Hit | null = null;
  const keep = (candidate: Hit | null) => {
    if (candidate && (!best || candidate.score > best.score)) best = candidate;
  };

  const at = hay.indexOf(need); // tier A
  if (at >= 0) {
    const startsWord = at === 0 || /[^a-z0-9]/.test(hay[at - 1]);
    const marks = Array.from({ length: need.length }, (_, i) => at + i);
    // A hit buried inside a word scores below initials for short queries, so
    // "rp" means Rishabh Pant rather than the "rp" inside Harpreet.
    keep({
      score: startsWord ? 400 + 6 * need.length - Math.min(at, 20) * 2 : 200 + 12 * need.length,
      marks,
    });
  }
  if (strict) return best;

  const ws = wordStarts(hay);
  const flat = need.replace(/\s+/g, "");

  if (flat.length >= 2 && flat.length <= ws.length) { // tier B
    for (let s = 0; s + flat.length <= ws.length; s++) {
      const marks: number[] = [];
      let good = true;
      for (let k = 0; k < flat.length; k++) {
        if (ws[s + k].w[0] !== flat[k]) {
          good = false;
          break;
        }
        marks.push(ws[s + k].i);
      }
      if (good) {
        keep({ score: 260 - s * 10, marks });
        break;
      }
    }
  }

  if (!/\s/.test(need)) { // tier C
    for (const { w, i } of ws) {
      const f = fuzzySeq(w, need);
      if (!f) continue;
      keep({
        score: Math.min(180, f.score + Math.round((need.length / w.length) * 30)),
        marks: f.marks.map((x) => x + i),
      });
    }
  }

  return best;
}

export interface PlayerHit {
  score: number;
  marks: number[] | null;
}

function scorePlayer(player: ConsolePlayer, text: string): PlayerHit | null {
  if (!text) return { score: 1, marks: null };

  const candidates: [string, number, boolean][] = [
    [`${player.first} ${player.surname}`.trim(), 60, false],
    [`${player.surname} ${player.first}`.trim(), 55, false],
    [player.surname, 50, false],
    [player.first, 25, false],
    [player.country ?? "", 0, true],
    [`${player.role} ${player.roleShort}`, 0, true],
    [`${player.set} ${setMeta(player.set).label}`, 0, true],
  ];

  let best: PlayerHit | null = null;
  for (const [hay, bonus, strict] of candidates) {
    if (!hay) continue;
    const found = scoreOne(hay, text, strict);
    if (!found) continue;
    const total = found.score + bonus;
    if (!best || total > best.score) best = { score: total, marks: found.marks };
  }
  return best;
}

/** A player that survived the query, with the score that got it there. */
export interface SearchHit {
  player: ConsolePlayer;
  hit: PlayerHit;
}

/**
 * Run a query over `players`.
 *
 * `recordFor` supplies the auction state for a player id, which the `status:`,
 * `team:` and `price:` operators need but the roster itself does not carry.
 */
export function runQuery(
  players: ConsolePlayer[],
  query: string,
  ctx: {
    recordFor: (id: number) => AuctionRecord;
    teams: Team[];
    onBlockId: number | null;
  },
): SearchHit[] {
  const parsed = parseQuery(query);
  const out: SearchHit[] = [];

  for (const player of players) {
    const opCtx: OpContext = {
      record: ctx.recordFor(player.id),
      teams: ctx.teams,
      onBlockId: ctx.onBlockId,
    };
    if (!parsed.ops.every((op) => opMatches(player, op, opCtx))) continue;

    const hit = scorePlayer(player, parsed.text);
    if (!hit) continue;
    out.push({ player, hit });
  }

  // Subsequence matching is generous by design; drop the stragglers that only
  // matched because the letters happened to appear in order somewhere.
  if (parsed.text && out.length > 1) {
    const best = Math.max(...out.map((o) => o.hit.score));
    return out.filter((o) => o.hit.score >= best * 0.62);
  }
  return out;
}

/**
 * Split a display name into segments so matched characters can be marked.
 *
 * Indices are recomputed against the string actually rendered, so the marks
 * always line up even though scoring considered several candidate haystacks.
 */
export function highlightSegments(
  player: ConsolePlayer,
  query: string,
): { text: string; match: boolean; surname: boolean }[] {
  const display = `${player.first} ${player.surname}`.trim();
  const text = parseQuery(query).text;
  const found = text ? scoreOne(display, text) : null;
  const marks = new Set(found?.marks ?? []);
  const split = player.first ? player.first.length + 1 : 0;

  const segments: { text: string; match: boolean; surname: boolean }[] = [];
  for (let i = 0; i < display.length; i++) {
    const match = marks.has(i);
    const surname = i >= split;
    const last = segments[segments.length - 1];
    if (last && last.match === match && last.surname === surname) {
      last.text += display[i];
    } else {
      segments.push({ text: display[i], match, surname });
    }
  }
  return segments;
}

/** Operator examples shown under the search dropdown. */
export const SEARCH_HINTS = [
  "role:bowler",
  "cap:uncapped",
  "country:india",
  "status:available",
  "rating:>9.5",
  "sr:>150",
  "econ:<8",
  "wkts:>50",
];
