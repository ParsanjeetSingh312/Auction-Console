/**
 * ScoutEmblem.tsx
 * SCOUT's mark: a ball smashing through the stumps inside a cyan and gold
 * ring, drawn and animated in SVG.
 *
 * Redrawn from the reference artwork rather than shipped as the picture. A
 * raster can only hover; this plays — the ball comes in on its trail, the
 * stumps take the hit, the bails fly, sparks and dust burst and the rings
 * flash, then it resets and goes again. It is also sharp at every size, from
 * the 56px launcher to the prototype's hero.
 *
 * Two variants share one drawing:
 *   "full" — adds the perspective floor, the axis lines, dust and shards.
 *   "mark" — the rings, stumps, bails, ball and sparks only, for small sizes
 *            where the extra detail would turn to noise.
 *
 * Everything moves on CSS keyframes in scoutEmblem.css, all on one cycle, so
 * the beats stay in step without a JS clock. Reduced motion stops every
 * animation and leaves a composed still: the ball in the stumps, rings lit.
 */
import { useId } from "react";

import "./scoutEmblem.css";

export interface ScoutEmblemProps {
  variant?: "full" | "mark";
  className?: string;
  /** Seconds per cycle. */
  cycle?: number;
  /** Pause the loop, e.g. while a panel covers the emblem. */
  paused?: boolean;
}

/** Spark directions, in degrees: a ring that is not quite even reads as an impact. */
const SPARKS = [8, 38, 64, 97, 128, 152, 187, 214, 243, 271, 300, 332];
/** Dust puffs: angle, distance, radius. */
const DUST: [number, number, number][] = [
  [20, 34, 9], [70, 30, 11], [120, 36, 8], [165, 32, 12],
  [210, 34, 9], [255, 28, 10], [300, 36, 11], [340, 30, 8],
];
/** Splinters off the broken stump: angle, distance, rotation, length. */
const SPLINTERS: [number, number, number, number][] = [
  [-150, 22, -60, 13], [-120, 28, -25, 10], [-75, 30, 15, 15], [-40, 26, 50, 11],
  [-10, 24, 80, 9], [190, 20, -95, 9], [-100, 16, -10, 7],
];
/** Stump shards: angle, distance, rotation. */
const SHARDS: [number, number, number][] = [
  [-30, 64, 140], [-150, 70, -120], [200, 58, 200], [-80, 74, -90], [40, 60, 160],
];

export default function ScoutEmblem({
  variant = "full",
  className = "",
  cycle = 3.8,
  paused = false,
}: ScoutEmblemProps) {
  // useId returns ":r0:"; colons inside url(#...) are not reliable, so strip them.
  const uid = useId().replace(/:/g, "");
  const id = (name: string) => `se-${uid}-${name}`;
  const full = variant === "full";

  return (
    <svg
      viewBox="0 0 240 240"
      className={`se ${full ? "se-full" : "se-mark"} ${className}`}
      data-paused={paused ? "" : undefined}
      style={{ ["--se-cycle" as string]: `${cycle}s` }}
      aria-hidden
      focusable="false"
    >
      <defs>
        <radialGradient id={id("ball")} cx="36%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#ff9a8a" />
          <stop offset="30%" stopColor="#e11d2e" />
          <stop offset="75%" stopColor="#8b0f17" />
          <stop offset="100%" stopColor="#3f050a" />
        </radialGradient>
        <linearGradient id={id("stump")} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#7a5a30" />
          <stop offset="30%" stopColor="#e9d5ad" />
          <stop offset="50%" stopColor="#fff4dc" />
          <stop offset="78%" stopColor="#d2b483" />
          <stop offset="100%" stopColor="#6e4f28" />
        </linearGradient>
        <linearGradient id={id("bail")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff4dc" />
          <stop offset="100%" stopColor="#b8925a" />
        </linearGradient>
        <radialGradient id={id("flash")}>
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="35%" stopColor="#fde68a" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id("dust")}>
          <stop offset="0%" stopColor="#e2e8f0" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#94a3b8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id("floor")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.35" />
        </linearGradient>
        <filter id={id("glow")} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id={id("soft")} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
      </defs>

      {full && (
        <g className="se-backdrop">
          {/* Perspective floor */}
          <g stroke={`url(#${id("floor")})`} strokeWidth="0.8">
            {[-120, -80, -40, 0, 40, 80, 120].map((dx) => (
              <line key={dx} x1={120 + dx * 0.35} y1="178" x2={120 + dx * 1.6} y2="240" />
            ))}
            {[186, 196, 210, 228].map((y) => (
              <line key={y} x1="0" y1={y} x2="240" y2={y} />
            ))}
          </g>
          {/* Axis lines, as on a scout's plot */}
          <g className="se-axis" stroke="#f59e0b" strokeOpacity="0.28" strokeWidth="0.6">
            <line x1="120" y1="0" x2="120" y2="240" />
            <line x1="0" y1="124" x2="240" y2="124" />
          </g>
        </g>
      )}

      {/* Rings: a steady base, plus a turning highlight on each */}
      <g className="se-rings">
        <circle cx="120" cy="124" r="104" fill="none" stroke="#22d3ee" strokeWidth="2.4" opacity="0.85" filter={`url(#${id("glow")})`} />
        <circle className="se-ring-spin-a" cx="120" cy="124" r="104" fill="none" stroke="#a5f3fc" strokeWidth="3" strokeDasharray="70 140 24 420" strokeLinecap="round" />
        <circle cx="120" cy="124" r="91" fill="none" stroke="#f59e0b" strokeWidth="3.4" opacity="0.9" filter={`url(#${id("glow")})`} />
        <circle className="se-ring-spin-b" cx="120" cy="124" r="91" fill="none" stroke="#fde68a" strokeWidth="3.6" strokeDasharray="110 90 30 340" strokeLinecap="round" />
      </g>

      {/* Speed lines crossing the frame, lower left to upper right */}
      <g className="se-speed" stroke="#67e8f9" strokeLinecap="round" fill="none">
        <path d="M14 196 L226 72" strokeWidth="1.2" strokeDasharray="30 18 6 22" />
        <path d="M30 210 L232 92" strokeWidth="0.8" strokeDasharray="18 26 4 30" />
        {full && <path d="M6 172 L214 58" strokeWidth="0.7" strokeDasharray="12 30 3 20" />}
      </g>

      {/*
        Stumps: outer two, then the middle one in front, as in the reference.

        The middle stump is two pieces that share one jagged break line, so it
        reads as a single stump until the ball arrives. The break sits just
        above where the ball comes to rest, so the splintered ends stay in view
        once the top half has snapped away.
      */}
      <g className="se-stumps">
        <rect className="se-stump se-stump-l" x="77" y="66" width="13" height="144" rx="6.5" fill={`url(#${id("stump")})`} />
        <rect className="se-stump se-stump-r" x="150" y="66" width="13" height="144" rx="6.5" fill={`url(#${id("stump")})`} />
        {/* Whole until the ball arrives, so the break line never shows early. */}
        <rect className="se-stump se-stump-whole" x="113.5" y="66" width="13" height="144" rx="6.5" fill={`url(#${id("stump")})`} />
        <path
          className="se-stump se-stump-bot"
          d="M113.5 101 L116 97 L118.5 103 L121 96.5 L123.5 102 L126.5 98 L126.5 203.5 A6.5 6.5 0 0 1 113.5 203.5 Z"
          fill={`url(#${id("stump")})`}
        />
        <path
          className="se-stump-top"
          d="M113.5 72.5 A6.5 6.5 0 0 1 126.5 72.5 L126.5 98 L123.5 102 L121 96.5 L118.5 103 L116 97 L113.5 101 Z"
          fill={`url(#${id("stump")})`}
        />
      </g>

      {/* Splinters from the break, held in the air while the wicket is down */}
      <g className="se-splinters">
        {SPLINTERS.map(([a, d, rot, len], i) => {
          const rad = (a * Math.PI) / 180;
          return (
            <rect
              key={i}
              className="se-splinter"
              x="119"
              y={100 - len / 2}
              width="2.2"
              height={len}
              rx="1"
              fill={i % 2 ? "#f5e6c8" : "#d9bd8c"}
              style={{
                ["--sx" as string]: `${Math.cos(rad) * d}px`,
                ["--sy" as string]: `${Math.sin(rad) * d}px`,
                ["--sr" as string]: `${rot}deg`,
              }}
            />
          );
        })}
      </g>

      {/* Bails, resting across the tops */}
      <g className="se-bail se-bail-l">
        <rect x="83" y="58" width="37" height="7" rx="3.5" fill={`url(#${id("bail")})`} />
        <rect x="97" y="56.5" width="9" height="10" rx="3" fill="#f5e6c8" />
      </g>
      <g className="se-bail se-bail-r">
        <rect x="120" y="58" width="37" height="7" rx="3.5" fill={`url(#${id("bail")})`} />
        <rect x="134" y="56.5" width="9" height="10" rx="3" fill="#f5e6c8" />
      </g>

      {/* Ball trail */}
      <path className="se-trail" d="M262 34 Q190 70 122 120" fill="none" stroke="#fca5a5" strokeWidth="5" strokeLinecap="round" opacity="0" />

      {/* Impact */}
      <circle className="se-flash" cx="120" cy="122" r="48" fill={`url(#${id("flash")})`} />
      {full && (
        <g className="se-dust" filter={`url(#${id("soft")})`}>
          {DUST.map(([a, d, r]) => {
            const rad = (a * Math.PI) / 180;
            return (
              <circle
                key={a}
                cx={120 + Math.cos(rad) * d}
                cy={122 + Math.sin(rad) * d}
                r={r}
                fill={`url(#${id("dust")})`}
              />
            );
          })}
        </g>
      )}
      <g className="se-sparks" stroke="#fb923c" strokeWidth="2" strokeLinecap="round">
        {SPARKS.map((a, i) => {
          const rad = (a * Math.PI) / 180;
          const r0 = 26 + (i % 3) * 4;
          const r1 = r0 + 12 + (i % 2) * 8;
          return (
            <line
              key={a}
              x1={120 + Math.cos(rad) * r0}
              y1={122 + Math.sin(rad) * r0}
              x2={120 + Math.cos(rad) * r1}
              y2={122 + Math.sin(rad) * r1}
              stroke={i % 4 === 0 ? "#fde68a" : undefined}
            />
          );
        })}
      </g>
      {full && (
        <g className="se-shards">
          {SHARDS.map(([a, d, rot], i) => {
            const rad = (a * Math.PI) / 180;
            return (
              <rect
                key={i}
                className="se-shard"
                x="117"
                y="119"
                width="6"
                height="3"
                rx="1"
                fill="#e9d5ad"
                style={{
                  ["--sx" as string]: `${Math.cos(rad) * d}px`,
                  ["--sy" as string]: `${Math.sin(rad) * d}px`,
                  ["--sr" as string]: `${rot}deg`,
                }}
              />
            );
          })}
        </g>
      )}

      {/* The ball. Outer group flies in; inner group spins the seam. */}
      <g className="se-ball">
        <circle cx="120" cy="122" r="26" fill="#ef4444" opacity="0.28" filter={`url(#${id("soft")})`} />
        <circle cx="120" cy="122" r="19" fill={`url(#${id("ball")})`} />
        <g className="se-seam">
          <path d="M106 109 Q120 122 106 135" fill="none" stroke="#fde2e2" strokeWidth="1.3" strokeDasharray="2.2 2" />
          <path d="M134 109 Q120 122 134 135" fill="none" stroke="#fde2e2" strokeWidth="1.3" strokeDasharray="2.2 2" />
        </g>
        <ellipse cx="113" cy="114" rx="5" ry="3.2" fill="#ffffff" opacity="0.35" />
      </g>
    </svg>
  );
}
