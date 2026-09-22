/**
 * AuctionIntelligence.tsx
 * Insights derived from the auction, not written about it.
 *
 * **Every line here is computed, and that is the whole requirement.** The brief
 * is explicit — "these insights should ideally be generated from the actual
 * backend data rather than hardcoded" — and the prototype makes the same point
 * about its own engine: its insights are "genuinely derived rather than
 * hardcoded strings". A panel of plausible-sounding sentences that do not move
 * when the auction moves is worse than no panel, because it teaches the
 * operator to ignore the one place the product claims to be thinking.
 *
 * So each insight below is a pure function of state the console already holds,
 * and each one **states the figures it was derived from**. An insight you
 * cannot check is a claim; an insight carrying its own arithmetic is a reading.
 *
 * **Insights that do not apply are not rendered.** A squad alert for a team
 * with no gap, or a trend computed from two sales, is noise dressed as
 * analysis. Each rule returns null when its own precondition fails, and the
 * panel says plainly when nothing has cleared the bar yet.
 */
import { moneyTight } from "../../console/format";
import type { ConsolePlayer, Rules, TeamSummary } from "../../console/types";

type Tone = "info" | "alert" | "trend";

interface Insight {
  id: string;
  tone: Tone;
  label: string;
  text: string;
}

const TONE_STYLE: Record<Tone, { chip: string; dot: string }> = {
  info: { chip: "text-cyan-800 bg-cyan-50", dot: "bg-cyan-500" },
  alert: { chip: "text-amber-800 bg-amber-50", dot: "bg-amber-500" },
  trend: { chip: "text-emerald-800 bg-emerald-50", dot: "bg-emerald-500" },
};

export interface AuctionIntelligenceProps {
  teams: TeamSummary[];
  rules: Rules;
  /**
   * Everyone sold, paired with what they went for.
   *
   * Optional, and the reason is worth stating: the engine's public surface
   * exposes squads and totals but not a price per player, so a caller that
   * cannot supply this passes nothing and simply gets fewer insights. The
   * alternative — inferring a per-player price from a team total — would be
   * this panel inventing the figures it claims to have derived.
   */
  sold?: Array<{ player: ConsolePlayer; price: number }>;
}

/** Roles a minimum squad genuinely needs one of. */
const REQUIRED_ROLES = ["Wicket Keeper", "Bowler", "All-Rounder"];

/** Below this a percentage over base is arithmetic on noise, not a trend. */
const MIN_SALES_FOR_TREND = 5;

function build(
  teams: TeamSummary[],
  rules: Rules,
  sold: Array<{ player: ConsolePlayer; price: number }>,
): Insight[] {
  const out: Insight[] = [];

  // --- Who is still dangerous ------------------------------------------------
  const richest = [...teams].sort((a, b) => b.maxBid - a.maxBid)[0];
  if (richest) {
    const overseasLeft = rules.maxOverseas - richest.overseas;
    out.push({
      id: "purse",
      tone: "info",
      label: "Auction insight",
      text:
        `${richest.team.code} can still bid ${moneyTight(richest.maxBid)} ` +
        `with ${rules.maxSquad - richest.squad.length} squad slot(s) and ` +
        `${overseasLeft} overseas slot(s) open.`,
    });
  }

  // --- Squad gaps ------------------------------------------------------------
  for (const row of teams) {
    if (row.squad.length === 0) continue;
    const missing = REQUIRED_ROLES.filter(
      (role) => !row.squad.some((p) => p.role === role),
    );
    if (missing.length === 0) continue;
    // Only worth raising once a team is far enough in that the gap is a plan
    // rather than an accident of ordering.
    if (row.squad.length < Math.max(3, Math.floor(rules.minSquad / 3))) continue;

    out.push({
      id: `gap:${row.team.id}`,
      tone: "alert",
      label: "Squad alert",
      text:
        `${row.team.code} has ${row.squad.length} signed and still no ` +
        `${missing.join(", no ")}.`,
    });
    if (out.length > 6) break;
  }

  /*
    Market-wide premium, from squads and totals alone.

    Every franchise's `spent` and its squad's base prices are both on the
    summary, so the room's aggregate overpay is derivable even where a
    per-player price is not. It answers a coarser question than the per-role
    trend below, and it answers it from data that is always present.
  */
  const squadBase = teams.reduce(
    (sum, row) =>
      sum + row.squad.reduce((s2, p) => s2 + (p.baseAssumed ? 0 : p.base), 0),
    0,
  );
  const squadSpent = teams.reduce((sum, row) => sum + row.spent, 0);
  const signed = teams.reduce((sum, row) => sum + row.squad.length, 0);
  if (squadBase > 0 && signed >= MIN_SALES_FOR_TREND) {
    const pct = Math.round(((squadSpent - squadBase) / squadBase) * 100);
    out.push({
      id: "market",
      tone: "trend",
      label: "Market",
      text:
        `${signed} signed for ${moneyTight(squadSpent)} — ` +
        `${pct >= 0 ? `${pct}% above` : `${Math.abs(pct)}% below`} their combined base.`,
    });
  }

  // --- What the market is paying, per role -----------------------------------
  /*
    `baseAssumed` players are excluded on purpose.

    Two thirds of the pool has no real base price, and `base` then holds the
    auction floor standing in for it. A premium measured against a placeholder
    is not a premium over base — it is a premium over 30 lakh, which would make
    every uncapped signing look like a runaway and skew the trend hardest
    exactly where the data is thinnest.
  */
  const priced = sold.filter(
    (row) => row.price > 0 && row.player.base > 0 && !row.player.baseAssumed,
  );
  if (priced.length >= MIN_SALES_FOR_TREND) {
    const byRole = new Map<string, { over: number; n: number }>();
    for (const { player, price } of priced) {
      const premium = (price - player.base) / player.base;
      const row = byRole.get(player.role) ?? { over: 0, n: 0 };
      row.over += premium;
      row.n += 1;
      byRole.set(player.role, row);
    }

    const ranked = [...byRole.entries()]
      .filter(([, v]) => v.n >= 2)
      .map(([role, v]) => ({ role, pct: Math.round((v.over / v.n) * 100), n: v.n }))
      .sort((a, b) => b.pct - a.pct);

    const top = ranked[0];
    if (top) {
      out.push({
        id: "trend",
        tone: "trend",
        label: "Bidding trend",
        text:
          `${top.role}s are going ${top.pct >= 0 ? `${top.pct}% above` : `${Math.abs(top.pct)}% below`} ` +
          `base, across ${top.n} sale(s).`,
      });
    }

    const spend = priced.reduce((sum, row) => sum + row.price, 0);
    out.push({
      id: "average",
      tone: "info",
      label: "Market",
      text:
        `${priced.length} sold for ${moneyTight(spend)}, ` +
        `averaging ${moneyTight(Math.round(spend / priced.length))} a player.`,
    });
  }

  return out;
}

export default function AuctionIntelligence({
  teams,
  rules,
  sold = [],
}: AuctionIntelligenceProps) {
  const insights = build(teams, rules, sold);

  return (
    <div className="ledger">
      <div className="lhead">
        <span className="eyebrow">Auction intelligence</span>
        <span className="font-ui text-[10px] text-slate-faint">derived live</span>
      </div>

      {insights.length === 0 ? (
        <p className="px-3 py-4 font-ui text-[11px] text-slate-faint">
          Nothing to report yet. Insights appear once the room has sold enough
          for the arithmetic to mean something.
        </p>
      ) : (
        <ul className="divide-y divide-black/5">
          {insights.map((insight) => {
            const tone = TONE_STYLE[insight.tone];
            return (
              <li key={insight.id} className="px-3 py-2">
                <span
                  className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-ui text-[9px] uppercase tracking-[0.14em] ${tone.chip}`}
                >
                  <span aria-hidden className={`h-1 w-1 rounded-full ${tone.dot}`} />
                  {insight.label}
                </span>
                <p className="mt-1 font-ui text-[11.5px] leading-snug text-slate-ink">
                  {insight.text}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
