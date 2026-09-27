/**
 * PlayerHero.tsx
 * A player presented the way the auction talks about one.
 *
 * Built to the reference: a figure standing against their own jersey number,
 * then the name, then what they cost, then what they can do. The order is the
 * argument — a room decides on identity and price long before it reads a
 * strike rate, and a layout that leads with a stats table is a spreadsheet
 * about a player rather than a presentation of one.
 *
 * **The jersey number is the artwork, not a label.** It is set enormous behind
 * the silhouette and allowed to bleed past the frame, because a number that
 * fits neatly reads as a caption where one that overflows reads as the back of
 * a shirt. This is the same rule `UI/PlayerCard`'s generated portrait already
 * follows, and the prototype states the underlying point directly: there is no
 * "94 OVR" badge anywhere, because an overall rating is a video-game idea that
 * flattens role, form, scarcity and price into one meaningless integer.
 *
 * **Where the number is unknown, the role badge takes the hero slot.** Only a
 * handful of squad numbers are verified, and an invented one at this size is
 * the most prominent lie the product could tell. See `jersey` in
 * `console/types.ts`.
 *
 * **The stat grid is role-aware, and it shows only what exists.** The reference
 * lists catches and age; this dataset has neither, and inventing them to fill
 * a grid would be the same failure as an invented number, just smaller. A
 * bowler gets wickets, economy and bowling average where a batter gets runs,
 * average and strike rate — the pool stores one set or the other per player,
 * never both, so showing a fixed six would leave half of them empty.
 */
import { crore } from "../Auction/blockTypes";
import type { ConsolePlayer, Team } from "../../console/types";
import PlayerSilhouette from "./PlayerSilhouette";

/** A figure worth a cell, or nothing. */
interface Stat {
  label: string;
  value: string;
}

function statsFor(player: ConsolePlayer): Stat[] {
  const s = player.stats;

  /** A cell, or nothing at all when the figure is missing. */
  const cell = (label: string, value: number | null, digits = 0): Stat | null =>
    value == null ? null : { label, value: value.toFixed(digits) };

  const rows: Array<Stat | null> = [cell("Matches", s.matches)];

  /*
    The pool stores batting OR bowling per player, never both — `role` decides
    which, and `ingestion/excel_parser.py` branches on exactly that. A fixed
    grid of six would therefore be half empty for every player on the board.
  */
  /*
    The last two in each branch arrived with Phase 4, which removed the second
    career-record block from PlayerCard.

    Those two panels were described as duplicates and were mostly that — five
    of seven figures were common to both — but not entirely. The lower block
    uniquely carried the matchup splits: boundary percentage against spin and
    pace for a batter, economy against left- and right-handers for a bowler.
    Deleting it wholesale would have quietly cost every player two figures, so
    they were folded in here first and the block removed afterwards.

    They are also the more interesting numbers. An overall economy of 7.5 says
    much less at an auction than 6.9 against right-handers and 8.4 against
    left — that is the difference between a bowler you can use in any over and
    one you have to hide from a left-handed pair.
  */
  if (player.roleShort === "BOWL") {
    rows.push(
      cell("Wickets", s.wickets),
      cell("Economy", s.economy, 2),
      cell("Bowl avg", s.bowl_avg, 1),
      cell("Bowl SR", s.bowl_sr, 1),
      cell("Conceded", s.runs_conceded),
      cell("Econ v LHB", s.econ_vs_lhb, 2),
      cell("Econ v RHB", s.econ_vs_rhb, 2),
    );
  } else {
    rows.push(
      cell("Runs", s.total_runs),
      cell("Average", s.bat_avg, 1),
      cell("Strike rate", s.bat_sr, 1),
      cell("SR vs spin", s.sr_vs_spin, 1),
      cell("SR vs pace", s.sr_vs_fast, 1),
      cell("Bnd% v spin", s.boundary_pct_spin, 1),
      cell("Bnd% v pace", s.boundary_pct_fast, 1),
    );
  }

  return rows.filter((row): row is Stat => row !== null);
}

export interface PlayerHeroProps {
  player: ConsolePlayer;
  /** The franchise that bought them, when the lot has closed. */
  soldTo?: Team | null;
  /** Hammer price, ₹ lakh. */
  soldFor?: number | null;
  className?: string;
}

export default function PlayerHero({
  player,
  soldTo = null,
  soldFor = null,
  className = "",
}: PlayerHeroProps) {
  const stats = statsFor(player);
  const jersey = player.jersey;

  return (
    <article className={`text-auctiq-text ${className}`.trim()}>
      {/*
        The stage. `overflow-hidden` is what lets the number bleed: it is sized
        past the panel and clipped by it, rather than shrunk to fit.
      */}
      <div className="relative grid h-56 place-items-center overflow-hidden rounded-xl border border-white/10 bg-[#070d1a]">
        {jersey != null ? (
          <span
            aria-hidden
            className="pointer-events-none absolute select-none font-auctiq leading-none tracking-tighter text-cyan-300/15"
            style={{ fontSize: "clamp(9rem, 26vw, 15rem)" }}
          >
            <span className="align-top text-[0.42em]">#</span>
            {jersey}
          </span>
        ) : (
          <span
            aria-hidden
            className="pointer-events-none absolute select-none font-auctiq leading-none tracking-[0.06em] text-cyan-300/10"
            style={{ fontSize: "clamp(3rem, 10vw, 6rem)" }}
          >
            {player.roleShort}
          </span>
        )}

        <span aria-hidden className="relative h-36 w-36 text-cyan-300/85">
          <PlayerSilhouette role={player.roleShort} />
        </span>
      </div>

      <p className="mt-5 font-tech text-[11px] uppercase tracking-[0.22em] text-auctiq-dim">
        {jersey != null ? `Player #${jersey}` : player.role}
        {player.set ? ` · ${player.set}` : ""}
      </p>

      <h2 className="mt-1 font-auctiq text-[34px] leading-none tracking-[0.01em] text-white">
        {player.name}
      </h2>

      <div className="mt-3 flex flex-wrap gap-2">
        <Chip>{player.roleShort}</Chip>
        {player.country && <Chip>{player.country}</Chip>}
        <Chip>{player.cap}</Chip>
        {player.overseas && <Chip>Overseas</Chip>}
      </div>

      <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <p className="font-tech text-[10px] uppercase tracking-[0.2em] text-auctiq-dim">
          Base price
        </p>
        <p className="mt-1 font-num text-[26px] font-bold leading-none tabular-nums text-auctiq-gold">
          {crore(player.base)}
          {/* Two thirds of the pool has no listed base, and `base` then holds
              the floor standing in for it. Saying so costs one line and stops
              the figure being read as a reserve somebody actually set. */}
          {player.baseAssumed && (
            <span className="ml-2 align-middle font-tech text-[9px] uppercase tracking-[0.14em] text-auctiq-dim">
              floor
            </span>
          )}
        </p>
      </div>

      {soldTo && soldFor != null && (
        <div
          className="mt-3 flex items-center gap-3 rounded-xl border p-4"
          style={{
            borderColor: `${soldTo.color}66`,
            background: `${soldTo.color}14`,
          }}
        >
          {/* A crest drawn from the franchise's own colour and code, rather
              than a bitmap: no asset to ship, and no licensing question. */}
          <span
            aria-hidden
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg font-head text-[13px] font-bold text-white"
            style={{ background: soldTo.color }}
          >
            {soldTo.code}
          </span>
          <div className="min-w-0">
            <p className="truncate font-tech text-[10px] uppercase tracking-[0.2em] text-auctiq-dim">
              Sold to {soldTo.name}
            </p>
            <p className="mt-0.5 font-num text-[22px] font-bold leading-none tabular-nums text-auctiq-gold">
              {crore(soldFor)}
            </p>
          </div>
        </div>
      )}

      {stats.length > 0 && (
        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label}>
              <dt className="font-tech text-[9.5px] uppercase tracking-[0.16em] text-auctiq-dim">
                {stat.label}
              </dt>
              <dd className="mt-0.5 font-num text-[19px] font-semibold leading-none tabular-nums text-white">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-white/15 px-2.5 py-1 font-tech text-[9.5px] font-semibold uppercase tracking-[0.12em] text-auctiq-dim">
      {children}
    </span>
  );
}
