/**
 * TeamBudgetGrid.tsx
 * Ten franchises, ten chips, ranked by what they can still spend.
 *
 * This replaces the stacked bar charts and the slot-by-slot tally that used to
 * fill the side panel. Those answered "how has this team spent?", which is a
 * question for after the auction. During a lot there is only one question —
 * *who can still outbid me* — and a bar chart answers it slowly: you read ten
 * bars, estimate ten lengths, then rank them yourself.
 *
 * So the grid does the ranking. The richest franchise is always the top-left
 * chip, and when a sale changes the order the chips animate to their new
 * positions rather than snapping, because watching a rival drop two places is
 * the information. `layout` on each chip is what buys that.
 *
 * Franchise colour appears as a dot and a left border only. Filling a chip with
 * team colour would turn a dashboard into a kit and destroy the one thing a
 * white theme is for: making the numbers the loudest object on the screen.
 */
import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { money } from "../../console/format";
import { EASE, rowVariants, SPRING } from "../../console/motion";
import type { TeamSummary } from "../../console/types";

/**
 * Franchise colours, keyed by the team codes the engine uses.
 *
 * Kept here rather than in the engine because these are a presentation
 * concern — the auction rules do not care what colour Mumbai is.
 */
const TEAM_COLOR: Record<string, string> = {
  MUM: "#004BA0",
  CHE: "#D6A700", // the kit yellow, darkened to stay legible on white
  BLR: "#D5152D",
  KOL: "#3A225D",
  DEL: "#17479E",
  PBK: "#D71920",
  RAJ: "#EA1A85",
  HYD: "#F26522",
  LKO: "#0057E2",
  AHM: "#1B2133",
};

export function teamColor(code: string): string {
  return TEAM_COLOR[code] ?? "#64748B";
}

export interface TeamBudgetGridProps {
  summaries: TeamSummary[];
  /** Opening purse, ₹ lakh — the denominator for the depletion tint. */
  purse: number;
  /** Highlighted as the viewer's own franchise. */
  activeTeamId?: number | null;
  onSelect?: (teamId: number) => void;
}

export default function TeamBudgetGrid({
  summaries,
  purse,
  activeTeamId = null,
  onSelect,
}: TeamBudgetGridProps) {
  const reduced = useReducedMotion();

  /**
   * Richest first, then by name so that two franchises on an identical purse —
   * which is the state every auction starts in — hold a stable order instead of
   * shuffling on every render.
   */
  const ranked = useMemo(
    () =>
      [...summaries].sort(
        (a, b) => b.left - a.left || a.team.name.localeCompare(b.team.name),
      ),
    [summaries],
  );

  return (
    <section className="rounded-xl border border-line bg-surface-card p-3 shadow-soft">
      <header className="mb-2.5 flex items-baseline justify-between">
        <h2 className="font-ui text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-muted">
          Franchise purses
        </h2>
        <span className="font-ui text-[10px] uppercase tracking-[0.1em] text-slate-faint">
          richest first
        </span>
      </header>

      <div className="grid grid-cols-2 gap-2">
        <AnimatePresence initial={false}>
          {ranked.map((summary, rank) => (
            <Chip
              key={summary.team.id}
              summary={summary}
              purse={purse}
              rank={rank}
              isActive={summary.team.id === activeTeamId}
              onSelect={onSelect}
              reduced={!!reduced}
            />
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

function Chip({
  summary,
  purse,
  rank,
  isActive,
  onSelect,
  reduced,
}: {
  summary: TeamSummary;
  purse: number;
  rank: number;
  isActive: boolean;
  onSelect?: (teamId: number) => void;
  reduced: boolean;
}) {
  const color = teamColor(summary.team.code);
  const pct = purse > 0 ? Math.max(0, Math.min(1, summary.left / purse)) : 0;

  // A franchise nearly out of money is the one fact worth catching without
  // reading a figure, so the chip itself warms as the purse empties.
  const depleted = pct <= 0.15;
  const low = pct <= 0.35;

  const interactive = typeof onSelect === "function";

  return (
    <motion.button
      type="button"
      layout={!reduced}
      variants={rowVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      // Gesture and layout need different curves: a press should answer like a
      // spring, whereas a chip changing rank should glide, or the reorder reads
      // as a twitch. Framer takes both in one object, keyed per property.
      transition={
        reduced ? { duration: 0 } : { ...SPRING, layout: { duration: 0.34, ease: EASE } }
      }
      whileHover={interactive && !reduced ? { scale: 1.03 } : undefined}
      whileTap={interactive && !reduced ? { scale: 0.97 } : undefined}
      onClick={interactive ? () => onSelect!(summary.team.id) : undefined}
      aria-current={isActive || undefined}
      disabled={!interactive}
      title={`${summary.team.name} · ${summary.size} bought · ${summary.overseas} overseas`}
      className={`group relative block overflow-hidden rounded-lg border bg-surface-card px-2.5 py-2 pl-3 text-left shadow-chip transition-colors ${
        isActive ? "border-slate-ink/25 ring-1 ring-slate-ink/10" : "border-line"
      } ${interactive ? "cursor-pointer hover:border-slate-faint/60" : "cursor-default"} ${
        depleted ? "bg-red-50/60" : low ? "bg-amber-50/50" : ""
      }`}
    >
      {/* Franchise colour: a rail, never a fill. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ backgroundColor: color }}
      />

      {/*
        Stacked rather than side by side. The console's money format is
        `₹120.00 Cr` and it is not negotiable — it is the same figure the pool
        table and the block card show, and one format across every view is what
        lets a number be compared at a glance. At two columns in a 250px rail
        that string simply will not sit beside a team code, so the code takes
        the top line and the figure gets the full width beneath it.
      */}
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="font-ui text-[10px] font-semibold uppercase leading-none tracking-[0.08em] text-slate-body">
          {summary.team.code}
        </span>
        {rank === 0 && (
          <span className="ml-auto font-ui text-[8.5px] uppercase leading-none tracking-[0.06em] text-slate-faint">
            top
          </span>
        )}
      </span>

      <span
        className={`mt-1 block font-num text-[15px] font-bold leading-none tabular-nums ${
          depleted ? "text-red-600" : low ? "text-amber-600" : "text-slate-ink"
        }`}
      >
        {money(summary.left)}
      </span>

      <span className="mt-0.5 block font-ui text-[8.5px] uppercase leading-none tracking-[0.06em] text-slate-faint">
        {summary.size === 0 ? "no buys" : `${summary.size} bought`}
      </span>
    </motion.button>
  );
}
