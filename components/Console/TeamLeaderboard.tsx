/**
 * TeamLeaderboard.tsx
 * The ten franchises, ranked, with the three numbers that constrain them.
 *
 * **Ranked by spend, not by squad size.** Both are defensible and they answer
 * different questions. Squad size says who is furthest through the job; spend
 * says who has committed hardest, which is the one that predicts what happens
 * to the next lot. A team with four players and no purse is out of the auction
 * in a way a team with four players and a full purse is not.
 *
 * **Purse, squad and overseas are shown together because they gate together.**
 * `Room.blocked_reason` checks all three in order — squad full, then overseas
 * full, then over budget — so a leaderboard that shows only money will explain
 * two thirds of the refusals an auctioneer sees. Each is rendered against its
 * own limit rather than as a bare figure: "18/25" is a position, "18" is
 * trivia.
 *
 * **`maxBid` is shown, not `left`.** They are different numbers and the
 * difference is load-bearing: the room holds back enough purse to fill the
 * minimum squad, so a franchise with ₹30 Cr remaining may only be permitted to
 * bid ₹28.9 Cr. `left` is what they have; `maxBid` is what they can actually
 * do with it, and the second is what decides the next lot.
 */
import { moneyTight } from "../../console/format";
import NumberRoll from "../UI/NumberRoll";
import type { Rules, TeamSummary } from "../../console/types";

export interface TeamLeaderboardProps {
  teams: TeamSummary[];
  rules: Rules;
  /** Highlighted as the viewer's own franchise, when there is one. */
  myTeamCode?: string;
}

export default function TeamLeaderboard({
  teams,
  rules,
  myTeamCode,
}: TeamLeaderboardProps) {
  const ranked = [...teams].sort((a, b) => b.spent - a.spent);
  const topSpend = ranked[0]?.spent ?? 0;

  return (
    <div className="ledger">
      <div className="lhead">
        <span className="eyebrow">Leaderboard</span>
        <span className="font-ui text-[10px] text-slate-faint">by spend</span>
      </div>

      <ul className="divide-y divide-black/5">
        {ranked.map((row, index) => {
          const mine = myTeamCode && row.team.code === myTeamCode;
          const squadFull = row.squad.length >= rules.maxSquad;
          const overseasFull = row.overseas >= rules.maxOverseas;
          // Bar width against the biggest spender, so the field is comparable
          // at a glance without anyone reading a single figure.
          const share = topSpend > 0 ? (row.spent / topSpend) * 100 : 0;

          return (
            <li
              key={row.team.id}
              className={`relative px-3 py-2 ${mine ? "bg-cyan-50/70" : ""}`}
            >
              {/* The bar sits behind the text rather than beside it, so the
                  row stays readable at any width. */}
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 opacity-[0.10]"
                style={{ width: `${share}%`, background: row.team.color }}
              />

              <div className="relative flex items-center gap-2">
                <span className="w-4 shrink-0 font-num text-[10px] tabular-nums text-slate-faint">
                  {index + 1}
                </span>
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: row.team.color }}
                />
                <span className="font-head text-[12px] font-semibold tracking-wide text-slate-ink">
                  {row.team.code}
                </span>

                {/*
                  Rolled rather than snapped. Spend only moves when a lot
                  closes, so the count is the thing that says a sale just
                  happened on a panel with no other event to show it.
                  `BlockView` already tweens the live bid itself, which is why
                  this is the leaderboard and not there.
                */}
                <NumberRoll
                  value={row.spent}
                  format={moneyTight}
                  className="ml-auto font-num text-[12px] font-bold text-slate-ink"
                />
              </div>

              <div className="relative mt-1 flex items-center gap-3 pl-6 font-ui text-[10px] text-slate-faint">
                <span title="What this franchise may actually bid right now">
                  max bid{" "}
                  <NumberRoll
                    value={row.maxBid}
                    format={moneyTight}
                    className="font-num text-slate-ink"
                  />
                </span>
                <span className={squadFull ? "font-semibold text-amber-700" : undefined}>
                  squad{" "}
                  <span className="font-num tabular-nums">
                    {row.squad.length}/{rules.maxSquad}
                  </span>
                </span>
                <span className={overseasFull ? "font-semibold text-amber-700" : undefined}>
                  overseas{" "}
                  <span className="font-num tabular-nums">
                    {row.overseas}/{rules.maxOverseas}
                  </span>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
