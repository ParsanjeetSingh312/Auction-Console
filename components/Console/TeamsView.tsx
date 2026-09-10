/**
 * TeamsView.tsx
 * One card per franchise: purse, squad slots, role balance, and the buys.
 *
 * The slot strip is the quickest read on the page. Twenty-five squares, one per
 * roster place: filled in the team's colour for a buy, orange for an overseas
 * buy, dashed while still inside the minimum squad the team is obliged to fill.
 * A glance says whether a team is short of bodies, short of money, or out of
 * overseas places — the three things that decide whether they can bid at all.
 */
import { cssVars, money, moneyTight, setMeta } from "../../console/format";
import type { AuctionEngine } from "../../console/useAuctionEngine";
import type { TeamSummary } from "../../console/types";

export default function TeamsView({
  engine,
  onNotice,
}: {
  engine: AuctionEngine;
  onNotice: (message: string, kind?: "err") => void;
}) {
  return (
    <div className="teamwrap">
      {engine.summaries.map((summary) => (
        <TeamCard
          key={summary.team.id}
          summary={summary}
          engine={engine}
          onNotice={onNotice}
        />
      ))}
    </div>
  );
}

function TeamCard({
  summary,
  engine,
  onNotice,
}: {
  summary: TeamSummary;
  engine: AuctionEngine;
  onNotice: (message: string, kind?: "err") => void;
}) {
  const { team, squad, spent, left, maxBid, composition, size } = summary;
  const { rules, recordFor } = engine;
  const spentPct = Math.min(100, (spent / rules.purse) * 100);

  // Sorted by price so the marquee buys sit at the top of the squad list.
  const buys = squad
    .slice()
    .sort((a, b) => (recordFor(b.id).price ?? 0) - (recordFor(a.id).price ?? 0));

  return (
    <article className="teamcard" style={cssVars({ "--tc": team.color })}>
      <header>
        <h3>
          {team.name} <span className="eyebrow">{team.code}</span>
        </h3>

        <div className="purse">
          <div>
            <div className="eyebrow">Purse left</div>
            <b className="num">{money(left)}</b>
          </div>
          <div className="text-right">
            <div className="eyebrow">Max bid</div>
            <span className="font-mono">{money(maxBid)}</span>
          </div>
        </div>

        <div className="pbar">
          <i style={{ width: `${spentPct}%` }} />
        </div>
      </header>

      <div className="slots" aria-label={`${size} of ${rules.maxSquad} squad places filled`}>
        {Array.from({ length: rules.maxSquad }, (_, index) => {
          const player = buys[index];
          const className = player
            ? player.overseas
              ? "slot f os"
              : "slot f"
            : index < rules.minSquad
              ? "slot min"
              : "slot";
          return (
            <span
              key={index}
              className={className}
              title={player ? player.name : `empty slot ${index + 1}`}
            />
          );
        })}
      </div>

      <div className="comp">
        <div>
          <div className="eyebrow">Bat</div>
          <b>{composition.BAT}</b>
        </div>
        <div>
          <div className="eyebrow">Bowl</div>
          <b>{composition.BOWL}</b>
        </div>
        <div>
          <div className="eyebrow">All-r</div>
          <b>{composition.AR}</b>
        </div>
        <div>
          <div className="eyebrow">Keep</div>
          <b>{composition.WK}</b>
        </div>
      </div>

      <div className="squad">
        {buys.length === 0 ? (
          <div className="sempty">No buys yet.</div>
        ) : (
          buys.map((player) => (
            <div key={player.id} className="srow">
              <span
                className="rl"
                style={{ background: setMeta(player.set).rail }}
                aria-hidden
              />
              <span className="sn">
                {player.first && `${player.first} `}
                <b>{player.surname}</b>
                {player.overseas && <span className="flag is-os" aria-label="overseas" />}
              </span>
              <span className="sp">{moneyTight(recordFor(player.id).price)}</span>
              <span className="sx">
                <button
                  type="button"
                  title="Release back to the pool"
                  onClick={() => {
                    const result = engine.returnToPool(player.id);
                    if (result.message) onNotice(result.message);
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
          ))
        )}
      </div>
    </article>
  );
}
