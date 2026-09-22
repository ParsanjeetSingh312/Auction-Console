/**
 * StatRadar.tsx
 * A player's shape, measured against the pool they are in.
 *
 * **Every axis is a percentile, not a raw figure, and that is the whole
 * design.** A radar drawn from raw numbers is unreadable: a strike rate of 148
 * and an economy of 7.2 cannot share a scale, and normalising each axis to its
 * own maximum makes the best player in the pool a perfect hexagon regardless of
 * whether they are actually good. Ranking each figure against the other 283
 * players gives every axis the same meaning — "how many of the pool does he
 * beat here" — so the shape says something true about the player rather than
 * about the arithmetic.
 *
 * **Lower-is-better metrics are inverted, and the label says so.** Economy,
 * bowling average and bowling strike rate all improve as they fall. Plotting
 * them raw would draw the best bowlers as the smallest shape. They are ranked
 * in reverse, and the axis is drawn with the raw value beside it so nobody has
 * to guess which direction is good.
 *
 * **An absent figure removes its axis; it never plots as zero.** Two thirds of
 * this dataset is sparse. A missing strike rate rendered at the origin would
 * claim the player is the worst in the pool at it, which is a different and
 * much worse statement than "not recorded". Below three usable axes there is no
 * shape worth drawing and the component renders nothing, so the card falls back
 * to the figures it already shows.
 *
 * Hand-built SVG rather than a charting dependency. The prototype makes the
 * same call — `analytics/Charts.tsx` is noted in the audit as "hand-built SVG on
 * d3 scales, no charting library" — and a radar is about forty lines of
 * trigonometry against roughly a hundred kilobytes of Recharts.
 */
import { useMemo, useRef } from "react";

import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import { count, stat } from "../../console/format";
import type { ConsolePlayer, PlayerStats, RoleShort } from "../../console/types";

gsap.registerPlugin(useGSAP);

/** One spoke of the radar. */
export interface RadarAxis {
  label: string;
  /** Where the pool ranks this player on this metric, 0 → 1. */
  value: number;
  /** The raw figure, formatted for display beside the label. */
  raw: string;
  /** True when a lower raw figure is a better one. */
  inverted?: boolean;
}

/** How one metric is pulled off a player and ranked. */
interface Metric {
  label: string;
  pick: (stats: PlayerStats) => number | null;
  /** Lower is better — economy, bowling average, bowling strike rate. */
  inverted?: boolean;
  /** A whole number, like wickets or matches. */
  whole?: boolean;
}

const BATTING: Metric[] = [
  { label: "Runs", pick: (s) => s.total_runs, whole: true },
  { label: "Average", pick: (s) => s.bat_avg },
  { label: "Strike rate", pick: (s) => s.bat_sr },
  { label: "vs Spin", pick: (s) => s.sr_vs_spin },
  { label: "vs Pace", pick: (s) => s.sr_vs_fast },
  { label: "Matches", pick: (s) => s.matches, whole: true },
];

const BOWLING: Metric[] = [
  { label: "Wickets", pick: (s) => s.wickets, whole: true },
  { label: "Economy", pick: (s) => s.economy, inverted: true },
  { label: "Bowl avg", pick: (s) => s.bowl_avg, inverted: true },
  { label: "Balls/wkt", pick: (s) => s.bowl_sr, inverted: true },
  { label: "vs LHB", pick: (s) => s.econ_vs_lhb, inverted: true },
  { label: "vs RHB", pick: (s) => s.econ_vs_rhb, inverted: true },
];

/** All-rounders are measured on both halves of their game. */
const ALL_ROUND: Metric[] = [
  { label: "Runs", pick: (s) => s.total_runs, whole: true },
  { label: "Bat avg", pick: (s) => s.bat_avg },
  { label: "Bat SR", pick: (s) => s.bat_sr },
  { label: "Wickets", pick: (s) => s.wickets, whole: true },
  { label: "Economy", pick: (s) => s.economy, inverted: true },
  { label: "Bowl avg", pick: (s) => s.bowl_avg, inverted: true },
];

function metricsFor(role: RoleShort): Metric[] {
  if (role === "BOWL") return BOWLING;
  if (role === "AR") return ALL_ROUND;
  // Batters and wicket keepers are both measured on their batting: the dataset
  // holds no dismissal figures, so a keeper's keeping cannot be plotted here.
  return BATTING;
}

/**
 * Where `value` sits among `pool`, as a fraction.
 *
 * Only players who actually record the metric are counted. Including the
 * sparse two thirds as zeroes would push everyone who has a figure into the
 * top decile and flatten the whole chart.
 */
function rank(pool: number[], value: number, inverted: boolean): number {
  if (pool.length < 2) return 0.5;
  const below = pool.reduce((n, other) => n + (other < value ? 1 : 0), 0);
  const fraction = below / (pool.length - 1);
  return Math.min(1, Math.max(0, inverted ? 1 - fraction : fraction));
}

/**
 * Build the axes for one player, ranked against everyone comparable.
 *
 * "Comparable" means the same role. Ranking a bowler's batting average against
 * the specialist batters would tell you only that he is a bowler, which the
 * card already says in larger type.
 */
export function buildRadar(
  player: ConsolePlayer,
  pool: ConsolePlayer[],
): RadarAxis[] | null {
  const peers = pool.filter((other) => other.roleShort === player.roleShort);
  const axes: RadarAxis[] = [];

  for (const metric of metricsFor(player.roleShort)) {
    const own = metric.pick(player.stats);
    if (own == null || !Number.isFinite(own)) continue;

    const values: number[] = [];
    for (const peer of peers) {
      const v = metric.pick(peer.stats);
      if (v != null && Number.isFinite(v)) values.push(v);
    }

    axes.push({
      label: metric.label,
      value: rank(values, own, metric.inverted ?? false),
      raw: metric.whole ? count(own) : stat(own),
      inverted: metric.inverted,
    });
  }

  // Three points is the fewest that makes an area rather than a line.
  return axes.length >= 3 ? axes : null;
}

const SIZE = 210;
const CENTRE = SIZE / 2;
const RADIUS = 66;
const RINGS = [0.25, 0.5, 0.75, 1];

/** Polar to cartesian, with zero at twelve o'clock. */
function point(index: number, total: number, fraction: number) {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  return {
    x: CENTRE + Math.cos(angle) * RADIUS * fraction,
    y: CENTRE + Math.sin(angle) * RADIUS * fraction,
  };
}

export interface StatRadarProps {
  axes: RadarAxis[];
  /** The role tint, so the shape matches the rest of the player's colour. */
  tint: string;
}

export default function StatRadar({ axes, tint }: StatRadarProps) {
  const container = useRef<SVGSVGElement>(null);

  const shape = useMemo(
    () =>
      axes
        .map((axis, index) => {
          const p = point(index, axes.length, axis.value);
          return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
        })
        .join(" "),
    [axes],
  );

  /*
    The shape grows from the centre once, on open.

    Scaled rather than redrawn point by point: one transform on one element is
    a compositor job, where tweening the `points` attribute would re-parse the
    polygon on every frame. `svgOrigin` because an SVG child's transform origin
    is the user-space origin, not its own box — without it the shape grows from
    the top-left corner of the viewBox and swings across the chart.
  */
  useGSAP(
    () => {
      const media = gsap.matchMedia();

      media.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(".radar-shape", {
          scale: 0.2,
          autoAlpha: 0,
          svgOrigin: `${CENTRE} ${CENTRE}`,
          duration: 0.62,
          ease: "power3.out",
        });
        gsap.from(".radar-dot", {
          scale: 0,
          svgOrigin: `${CENTRE} ${CENTRE}`,
          duration: 0.4,
          ease: "back.out(2)",
          stagger: 0.05,
          delay: 0.18,
        });
      });

      return () => media.revert();
    },
    { dependencies: [shape], scope: container },
  );

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
      <svg
        ref={container}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="h-[210px] w-[210px] flex-none overflow-visible"
        role="img"
        aria-label={`Percentile rank against the pool: ${axes
          .map((a) => `${a.label} ${Math.round(a.value * 100)}%`)
          .join(", ")}`}
      >
        {/* Rings */}
        {RINGS.map((ring) => (
          <polygon
            key={ring}
            points={axes
              .map((_, index) => {
                const p = point(index, axes.length, ring);
                return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
              })
              .join(" ")}
            fill="none"
            stroke="var(--rule-2, rgba(255,255,255,.07))"
            strokeWidth="1"
          />
        ))}

        {/* Spokes */}
        {axes.map((axis, index) => {
          const p = point(index, axes.length, 1);
          return (
            <line
              key={axis.label}
              x1={CENTRE}
              y1={CENTRE}
              x2={p.x}
              y2={p.y}
              stroke="var(--rule-2, rgba(255,255,255,.07))"
              strokeWidth="1"
            />
          );
        })}

        {/* The player */}
        <polygon
          className="radar-shape"
          points={shape}
          fill={tint}
          fillOpacity="0.18"
          stroke={tint}
          strokeWidth="1.75"
          strokeLinejoin="round"
        />

        {axes.map((axis, index) => {
          const p = point(index, axes.length, axis.value);
          return (
            <circle
              key={axis.label}
              className="radar-dot"
              cx={p.x}
              cy={p.y}
              r="2.75"
              fill={tint}
            />
          );
        })}

        {/* Labels, pushed just outside the outer ring. */}
        {axes.map((axis, index) => {
          const p = point(index, axes.length, 1.26);
          const anchor =
            Math.abs(p.x - CENTRE) < 6
              ? "middle"
              : p.x > CENTRE
                ? "start"
                : "end";
          return (
            <text
              key={axis.label}
              x={p.x}
              y={p.y}
              textAnchor={anchor}
              dominantBaseline="middle"
              className="font-ui"
              fontSize="8"
              letterSpacing="0.08em"
              fill="var(--muted, #94a3b8)"
            >
              {axis.label.toUpperCase()}
            </text>
          );
        })}
      </svg>

      {/* The figures the shape was built from. The chart shows the standing;
          this shows what produced it, so no number on screen is unsourced. */}
      <ul className="min-w-[132px] space-y-1">
        {axes.map((axis) => (
          <li
            key={axis.label}
            className="flex items-baseline justify-between gap-3 border-b border-[var(--rule-2)] pb-1 last:border-0"
          >
            <span className="font-ui text-[9.5px] uppercase tracking-[0.1em] text-[var(--muted)]">
              {axis.label}
              {axis.inverted && (
                <span
                  className="ml-1 opacity-60"
                  title="Lower is better; ranked in reverse"
                >
                  ↓
                </span>
              )}
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className="font-num text-[11.5px] font-semibold text-[var(--ink)]">
                {axis.raw}
              </span>
              <span
                className="font-num text-[9px]"
                style={{ color: tint }}
                title="Percentile within this role"
              >
                {Math.round(axis.value * 100)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
