/**
 * ResultsView.tsx
 * What the auction actually did: headline figures, the biggest buys, where the
 * money went, and who is still unsold.
 *
 * Every bar chart is scaled against the largest value in its own group rather
 * than against the purse, because the interesting comparison is between teams
 * (or bands, or roles), not against a ceiling nobody reaches.
 */
import { useMemo } from "react";
import { motion } from "framer-motion";

import {
  cssVars,
  money,
  moneyTight,
  ratingLabel,
  ROLE_LABELS,
  setMeta,
} from "../../console/format";
import { cardVariants, gridVariants, liftable } from "../../console/motion";
import type { AuctionEngine } from "../../console/useAuctionEngine";
import type { ConsolePlayer, RoleShort } from "../../console/types";

interface Bar {
  key: string;
  value: number;
  color?: string;
}

export default function ResultsView({
  engine,
  onNotice,
}: {
  engine: AuctionEngine;
  onNotice: (message: string, kind?: "err") => void;
}) {
  const { players, recordFor, teamById, summaries, counts } = engine;

  const { sold, unsold, top, overpays, byTeam, byBand, byRole } = useMemo(() => {
    const soldPlayers: ConsolePlayer[] = [];
    const unsoldPlayers: ConsolePlayer[] = [];

    for (const player of players) {
      const status = recordFor(player.id).status;
      if (status === "sold") soldPlayers.push(player);
      else if (status === "unsold") unsoldPlayers.push(player);
    }

    const priceOf = (player: ConsolePlayer) => recordFor(player.id).price ?? 0;

    const bandTotals = new Map<string, number>();
    const roleTotals = new Map<RoleShort, number>();
    for (const player of soldPlayers) {
      bandTotals.set(player.set, (bandTotals.get(player.set) ?? 0) + priceOf(player));
      roleTotals.set(
        player.roleShort,
        (roleTotals.get(player.roleShort) ?? 0) + priceOf(player),
      );
    }

    return {
      sold: soldPlayers,
      unsold: unsoldPlayers,
      top: soldPlayers.slice().sort((a, b) => priceOf(b) - priceOf(a)).slice(0, 10),
      // A buy at more than twice base is the room deciding the sheet was wrong.
      overpays: soldPlayers.filter((player) => priceOf(player) > player.base * 2).length,
      byTeam: summaries
        .map((summary) => ({
          key: summary.team.name,
          value: summary.spent,
          color: summary.team.color,
        }))
        .filter((bar) => bar.value > 0),
      byBand: Array.from(bandTotals.entries())
        .map(([code, value]) => ({
          key: `${code} · ${setMeta(code).label}`,
          value,
          color: setMeta(code).rail,
        }))
        .sort((a, b) => b.value - a.value),
      byRole: Array.from(roleTotals.entries())
        .map(([code, value]) => ({ key: ROLE_LABELS[code], value }))
        .sort((a, b) => b.value - a.value),
    };
  }, [players, recordFor, summaries]);

  if (sold.length === 0 && unsold.length === 0) {
    return (
      <div className="panel px-8 py-9 text-center">
        <div className="empty">
          <b>The gavel has not dropped yet</b>
          Results, spend and squad breakdowns appear here once players start selling.
        </div>
      </div>
    );
  }

  return (
    <>
      <motion.div className="rgrid" variants={gridVariants}>
        <motion.div className="stat" variants={cardVariants} {...liftable}>
          <div className="eyebrow">Players sold</div>
          <b className="num">{sold.length}</b>
          <div className="sub">of {players.length} in the pool</div>
        </motion.div>
        <motion.div className="stat" variants={cardVariants} {...liftable}>
          <div className="eyebrow">Total spend</div>
          <b className="num">{money(counts.spent)}</b>
          <div className="sub">across {summaries.length} teams</div>
        </motion.div>
        <motion.div className="stat" variants={cardVariants} {...liftable}>
          <div className="eyebrow">Average buy</div>
          <b className="num">
            {sold.length ? money(Math.round(counts.spent / sold.length)) : "—"}
          </b>
          <div className="sub">{overpays} went for more than 2× base</div>
        </motion.div>
        <motion.div className="stat" variants={cardVariants} {...liftable}>
          <div className="eyebrow">Unsold</div>
          <b className="num">{unsold.length}</b>
          <div className="sub">{counts.available} still to come up</div>
        </motion.div>
      </motion.div>

      {top.length > 0 && (
        <motion.section className="panel mb-3" variants={cardVariants}>
          <header className="panel-head">
            <span className="eyebrow">Biggest buys</span>
            <span className="eyebrow">price · team · rating</span>
          </header>
          <table className="sheet">
            <tbody>
              {top.map((player, index) => {
                const record = recordFor(player.id);
                const team = teamById(record.teamId);
                const meta = setMeta(player.set);
                return (
                  /* Same CSS stagger the pool sheet uses; `top` is capped well
                     under the clamp so every row gets its own beat. */
                  <tr key={player.id} className="row-in" style={cssVars({ "--i": String(index) })}>
                    <td className="c-rail" style={{ background: meta.rail }} />
                    <td className="c-no">{index + 1}</td>
                    <td className="c-name">
                      {player.first && <span className="fn">{player.first} </span>}
                      <span className="sn">{player.surname}</span>
                    </td>
                    <td>
                      <span className="tag tag-sold">{team?.name ?? "—"}</span>
                    </td>
                    <td className="c-num font-mono">{money(record.price)}</td>
                    <td className="c-num font-mono text-muted">
                      {((record.price ?? 0) / player.base).toFixed(1)}× base
                    </td>
                    <td className="c-num">
                      <span className="ratebar-v num">{ratingLabel(player.rating)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </motion.section>
      )}

      <BarPanel title="Spend by team" bars={byTeam} />
      <BarPanel title="Spend by band" bars={byBand} />
      <BarPanel title="Spend by role" bars={byRole} />

      {unsold.length > 0 && (
        <motion.section className="panel mb-3" variants={cardVariants}>
          <header className="panel-head">
            <span className="eyebrow">Unsold — {unsold.length}</span>
            <button
              type="button"
              className="mini"
              onClick={() => {
                for (const player of unsold) engine.returnToPool(player.id);
                onNotice(`${unsold.length} players returned to the pool`);
              }}
            >
              Return all to the pool
            </button>
          </header>
          <div className="bars">
            {unsold.map((player) => (
              <div
                key={player.id}
                className="barrow"
                style={{ gridTemplateColumns: "1fr auto auto", gap: "8px" }}
              >
                <span className="bl">{player.name}</span>
                <span className="bv">{moneyTight(player.base)}</span>
                <button
                  type="button"
                  className="mini"
                  onClick={() => {
                    const result = engine.putOnBlock(player.id);
                    if (result.message) onNotice(result.message, result.ok ? undefined : "err");
                  }}
                >
                  Put up again
                </button>
              </div>
            ))}
          </div>
        </motion.section>
      )}
    </>
  );
}

function BarPanel({ title, bars }: { title: string; bars: Bar[] }) {
  if (bars.length === 0) return null;
  const max = Math.max(1, ...bars.map((bar) => bar.value));

  return (
    <section className="panel mb-3">
      <header className="panel-head">
        <span className="eyebrow">{title}</span>
      </header>
      <div className="bars">
        {bars.map((bar) => (
          <div
            key={bar.key}
            className="barrow"
            style={bar.color ? cssVars({ "--band": bar.color }) : undefined}
          >
            <span className="bl">{bar.key}</span>
            <span className="bt">
              <i style={{ width: `${(bar.value / max) * 100}%` }} />
            </span>
            <span className="bv">{moneyTight(bar.value)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
