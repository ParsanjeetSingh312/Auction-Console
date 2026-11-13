/**
 * PlayerHero.tsx
 * A player presented the way the auction talks about one.
 *
 * The order is the argument: identity first (the jersey number, then the
 * name), then what they cost, then what they can do. A room decides on
 * identity and price long before it reads a strike rate.
 *
 * **No figure.** The stickman that stood in front of the number is gone. It
 * was a generic silhouette, the same three poses for 284 players, and it read
 * as clip art. The number on its own says more: it is the back of the shirt.
 *
 * **The jersey number is the artwork, not a label.** It is set enormous and
 * allowed to bleed past the frame, because a number that fits neatly reads as
 * a caption where one that overflows reads as a shirt. There is no "94 OVR"
 * badge anywhere: an overall rating flattens role, form and price into one
 * meaningless integer.
 *
 * **Where the number is unknown, the role takes the hero slot.** Only verified
 * squad numbers are stored (data/jersey_numbers.json), and an invented one at
 * this size would be the most prominent lie the product could tell.
 *
 * **Motion, once, on open.** The stage lights up with a sweep, the number rises
 * into place, the name and chips follow, and every figure counts up from zero.
 * It plays once per card and never loops, so reading is never interrupted.
 * With reduced motion asked for, everything is simply there.
 *
 * **The stat grid is role-aware, and shows only what exists.** A bowler gets
 * wickets and economy where a batter gets runs and strike rate; nothing is
 * invented to fill a fixed grid.
 */
import { useEffect, useRef } from "react";
import { animate, motion, useReducedMotion } from "framer-motion";

import { crore } from "../Auction/blockTypes";
import type { ConsolePlayer, Team } from "../../console/types";
import StatsFreshness from "../UI/StatsFreshness";

const EASE = [0.22, 1, 0.36, 1] as const;

/** A figure worth a cell, or nothing. */
interface Stat {
  label: string;
  value: number;
  digits: number;
}

function statsFor(player: ConsolePlayer): Stat[] {
  const s = player.stats;

  /** A cell, or nothing at all when the figure is missing. */
  const cell = (label: string, value: number | null, digits = 0): Stat | null =>
    value == null ? null : { label, value, digits };

  const rows: Array<Stat | null> = [cell("Matches", s.matches)];

  // The pool stores batting OR bowling per player (all-rounders carry both
  // since the quarterly refresh), so the grid follows the role.
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
    if (player.roleShort === "AR") {
      rows.push(
        cell("Wickets", s.wickets),
        cell("Economy", s.economy, 2),
        cell("Econ v LHB", s.econ_vs_lhb, 2),
        cell("Econ v RHB", s.econ_vs_rhb, 2),
      );
    }
  }

  return rows.filter((row): row is Stat => row !== null);
}

/** A number that counts up from zero once, then stays put. */
function CountUp({ value, digits = 0, delay = 0 }: { value: number; digits?: number; delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (reduce) {
      node.textContent = value.toFixed(digits);
      return;
    }
    const controls = animate(0, value, {
      duration: 1.1,
      delay,
      ease: EASE,
      onUpdate: (v) => {
        node.textContent = v.toFixed(digits);
      },
    });
    return () => controls.stop();
  }, [value, digits, delay, reduce]);
  return <span ref={ref}>{reduce ? value.toFixed(digits) : (0).toFixed(digits)}</span>;
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
  const reduce = useReducedMotion();
  const stats = statsFor(player);
  const jersey = player.jersey;

  /** Enter from below, once; nothing at all under reduced motion. */
  const rise = (delay: number, y = 14) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.55, delay, ease: EASE },
        };

  return (
    <article className={`text-auctiq-text ${className}`.trim()}>
      {/* The stage. `overflow-hidden` lets the number bleed past the frame. */}
      <div className="relative h-56 overflow-hidden rounded-xl border border-white/10 bg-[radial-gradient(120%_90%_at_80%_10%,#12305a_0%,#0a1630_45%,#060c1a_100%)]">
        {/* Faint pitch lines: a crease and a return crease, nothing louder. */}
        <svg aria-hidden className="absolute inset-0 h-full w-full opacity-[0.07]" preserveAspectRatio="none">
          <line x1="0" y1="72%" x2="100%" y2="72%" stroke="#fff" strokeWidth="1" />
          <line x1="14%" y1="0" x2="14%" y2="100%" stroke="#fff" strokeWidth="1" />
          <line x1="86%" y1="0" x2="86%" y2="100%" stroke="#fff" strokeWidth="1" />
        </svg>

        {/* The number, or the role when the number is not verified. */}
        <motion.span
          aria-hidden
          className="pointer-events-none absolute -bottom-6 right-4 select-none font-auctiq leading-none tracking-tighter text-transparent [-webkit-text-stroke:1.5px_rgba(103,232,249,0.55)]"
          style={{ fontSize: jersey != null ? "clamp(9rem, 26vw, 14rem)" : "clamp(5rem, 14vw, 8rem)" }}
          initial={reduce ? false : { opacity: 0, y: 60, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: EASE }}
        >
          {jersey != null ? (
            <>
              <span className="align-top text-[0.4em]">#</span>
              {jersey}
            </>
          ) : (
            player.roleShort
          )}
        </motion.span>

        {/* A solid copy of the number, filled in by a left-to-right sweep. */}
        {jersey != null && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute -bottom-6 right-4 select-none bg-gradient-to-b from-[#a5f3fc] to-[#0e7490] bg-clip-text font-auctiq leading-none tracking-tighter text-transparent"
            style={{ fontSize: "clamp(9rem, 26vw, 14rem)" }}
            initial={reduce ? false : { opacity: 0, clipPath: "inset(0 100% 0 0)" }}
            animate={{ opacity: 0.2, clipPath: "inset(0 0% 0 0)" }}
            transition={{ duration: 0.9, delay: 0.35, ease: EASE }}
          >
            <span className="align-top text-[0.4em]">#</span>
            {jersey}
          </motion.span>
        )}

        {/* One pass of light across the stage on open. */}
        {!reduce && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/10 to-transparent"
            initial={{ left: "-40%" }}
            animate={{ left: "130%" }}
            transition={{ duration: 1.1, delay: 0.25, ease: "easeInOut" }}
          />
        )}

        {/* Top left: who this is, in the stage's own corner. */}
        <motion.div className="absolute left-5 top-5" {...rise(0.15, 8)}>
          <span className="inline-flex items-center gap-2 rounded-full border border-cyan-300/30 bg-cyan-300/10 px-3 py-1 font-tech text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" />
            {player.role}
          </span>
        </motion.div>

        {/* Bottom left: the gold rule draws in under the stage. */}
        <motion.span
          aria-hidden
          className="absolute bottom-5 left-5 h-[2px] rounded-full bg-gradient-to-r from-[#dcb963] to-transparent"
          initial={reduce ? false : { width: 0 }}
          animate={{ width: "38%" }}
          transition={{ duration: 0.9, delay: 0.45, ease: EASE }}
        />
      </div>

      <motion.p
        className="mt-5 font-tech text-[11px] uppercase tracking-[0.22em] text-auctiq-dim"
        {...rise(0.3)}
      >
        {jersey != null ? `Player #${jersey}` : player.role}
        {player.set ? ` · ${player.set}` : ""}
      </motion.p>

      <motion.h2
        className="mt-1 font-auctiq text-[34px] leading-none tracking-[0.01em] text-white"
        {...rise(0.36, 18)}
      >
        {player.name}
      </motion.h2>

      <motion.div className="mt-3 flex flex-wrap gap-2" {...rise(0.44)}>
        <Chip>{player.roleShort}</Chip>
        {player.country && <Chip>{player.country}</Chip>}
        <Chip>{player.cap}</Chip>
        {player.overseas && <Chip>Overseas</Chip>}
      </motion.div>

      <motion.div
        className="mt-4 rounded-xl border border-auctiq-gold/25 bg-gradient-to-r from-auctiq-gold/[0.08] to-transparent p-4"
        {...rise(0.5)}
      >
        <p className="font-tech text-[10px] uppercase tracking-[0.2em] text-auctiq-dim">Base price</p>
        <p className="mt-1 font-num text-[26px] font-bold leading-none tabular-nums text-auctiq-gold">
          {crore(player.base)}
          {/* Two thirds of the pool has no listed base; `base` then holds the
              floor standing in for it, and the card says so. */}
          {player.baseAssumed && (
            <span className="ml-2 align-middle font-tech text-[9px] uppercase tracking-[0.14em] text-auctiq-dim">
              floor
            </span>
          )}
        </p>
      </motion.div>

      {soldTo && soldFor != null && (
        <motion.div
          className="mt-3 flex items-center gap-3 rounded-xl border p-4"
          style={{ borderColor: `${soldTo.color}66`, background: `${soldTo.color}14` }}
          {...rise(0.55)}
        >
          {/* A crest drawn from the franchise's own colour and code. */}
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
        </motion.div>
      )}

      {stats.length > 0 && (
        <dl className="mt-5 grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4">
          {stats.map((stat, i) => (
            <motion.div
              key={stat.label}
              className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2.5"
              {...rise(0.55 + i * 0.04, 10)}
            >
              <dt className="font-tech text-[9.5px] uppercase tracking-[0.16em] text-auctiq-dim">
                {stat.label}
              </dt>
              <dd className="mt-1 font-num text-[19px] font-semibold leading-none tabular-nums text-white">
                <CountUp value={stat.value} digits={stat.digits} delay={0.55 + i * 0.04} />
              </dd>
            </motion.div>
          ))}
        </dl>
      )}
      {stats.length > 0 && <StatsFreshness tone="dark" className="mt-4" />}
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
