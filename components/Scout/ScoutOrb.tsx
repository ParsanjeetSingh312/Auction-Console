/**
 * ScoutOrb.tsx
 * SCOUT's ask-and-answer surface: an input pill that is hit for six, a cricket
 * ball that hovers and spins while SCOUT thinks, and an answer card that
 * unfolds out of a gold medallion.
 *
 * Built on the "AI thinking orb and input" component (MorphOrb). Its runtime is
 * kept as it was — the phase machine, the timeline engine and its tracks, the
 * abort handling, reduced motion — because that is the part that is hard to
 * get right. What changed:
 *
 *   - The look is SCOUT's, not the original's: navy broadcast glass, floodlight
 *     sheen, pitch stripes, a franchise-colour ticker, a gold boundary-rope
 *     border. The original styles were not part of the source handed over, so
 *     scoutOrb.css is written from scratch against the variables the runtime
 *     drives.
 *   - The dotted thinking orb is a cricket ball on canvas: red leather, a
 *     stitched seam that spins, a hover over its own shadow, and an orbit of
 *     stat lights that run a different pattern for each thinking label. It
 *     reads the same parameters (k, alpha, spin, sweep, vortex…) so every track
 *     still drives it.
 *   - "Done" is gold rather than green.
 *   - The answer card is as wide as the pill and as tall as its answer (capped
 *     at 60% of the viewport, then it scrolls) — SCOUT's answers are longer
 *     than the original's fixed 320×108 card holds. Line breaks survive.
 *   - Optional suggestion chips above the pill, and an `onPhaseChange` hook so
 *     the page around it can react.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import "./scoutOrb.css";

/* ───────────────────────────── copy ───────────────────────────── */
const COPY = {
  placeholder: "Ask SCOUT about any player, team or purse…",
  labels: ["Scouting", "Searching the pool", "Reading the form", "Building the answer"],
  done: "Got it",
  answerTitle: "SCOUT",
  answerTag: "Scout report",
  answerBody: "SCOUT came back empty on that one. Try naming a player, a team or a role.",
  reset: "Ask another",
  send: "Send",
};

export type ScoutOrbPhase =
  | "idle" | "launch" | "assemble" | "think" | "resolve" | "condense" | "unfold" | "answered" | "reset";
type Phase = ScoutOrbPhase;

export interface ScoutOrbProps {
  /**
   * Answer the question. Resolve with the answer text, or with nothing when
   * the answer is rendered through `answer` instead.
   */
  onSubmit?: (text: string) => Promise<string | void> | string | void;
  minThinkMs?: number;
  speed?: number;
  /** Prompts shown above the pill while idle; clicking one fills the input. */
  suggestions?: string[];
  /** Clicking a suggestion asks it straight away instead of filling the input. */
  submitSuggestions?: boolean;
  onPhaseChange?: (phase: ScoutOrbPhase) => void;
  /**
   * False while the surface is hidden: it then neither takes focus nor answers
   * Escape, so a closed panel cannot steal either from the page.
   */
  active?: boolean;
  /** Controlled input, for a draft that outlives the component's own state. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Live status under the ball. Replaces the cycling labels when set. */
  statusText?: string;
  /** Which light pattern the orbit runs (0-3), e.g. one per agent. */
  program?: number;
  /** Rendered under the status while SCOUT thinks: the agent rail. */
  belowStatus?: React.ReactNode;
  /** A rich answer for the card. Replaces the word-by-word text when set. */
  answer?: React.ReactNode;
  /** "Ask another" was pressed, or the answer returned to the pill on its own. */
  onReset?: () => void;
  /**
   * Return to the pill by itself this many ms after the answer has played in,
   * instead of waiting for "Ask another" (which is then not shown). The caller
   * keeps the answer somewhere readable — SCOUT files it into its transcript.
   */
  autoReturnMs?: number;
  /** Escape abandoned the turn (mid-thought, or from the answer card). */
  onCancel?: () => void;
}

/* ─────────────────────────── geometry ─────────────────────────── */
const PILL_H = 60, BALL_SMALL = 60, ORB_D = 132, CANVAS = 220;
const CARD_H = 108;
const FLY_D = 138;
const BALL_R = 44;
/**
 * The stage's size. Measured from the component's own root rather than the
 * window, so the same runtime works full-screen and inside SCOUT's side sheet.
 */
interface Box { w: number; h: number }
const pillW = (b: Box) => Math.min(540, b.w - 32);
const cardW = (b: Box) => Math.min(600, b.w - 32);
const homeDy = (b: Box) => b.h * 0.54 - 96; // pill centre is 96px above the stage bottom; stage centre is at top:46%
const maxCardH = (b: Box) => Math.max(CARD_H, Math.round(b.h * 0.6));

/* ───────────────────────── math + easing ───────────────────────── */
type Ease = (t: number) => number;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4);
const TAU = Math.PI * 2;

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) return t;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const e = sx(t);
      if (Math.abs(e - x) < 1e-6) break;
      if (x > e) lo = t; else hi = t;
      t = (hi - lo) / 2 + lo;
    }
    return t;
  };
  return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : sy(solve(x)));
}

const E = {
  out: cubicBezier(0.22, 1, 0.36, 1),
  io: cubicBezier(0.65, 0, 0.35, 1),
  in: cubicBezier(0.4, 0, 1, 1),
  fly: cubicBezier(0.5, 0, 0.1, 1),
  grow: cubicBezier(0.3, 0, 0.2, 1),
  vortex: cubicBezier(0.6, 0, 0.2, 1),
  spring: cubicBezier(0.34, 1.4, 0.64, 1),
  card: cubicBezier(0.65, 0, 0.2, 1),
  lin: (t: number) => t,
};

const bez = (t: number, p0: number, c: number, p2: number) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * c + t * t * p2;

/* ───────────────────────── timeline data ───────────────────────── */
interface Track { ch: string; from: number; to: number; t0: number; t1: number; ease?: Ease }
const T = (ch: string, from: number, to: number, t0: number, t1: number, ease: Ease = E.io): Track => ({ ch, from, to, t0, t1, ease });

interface Geo { pw: number; cw: number; ch: number; H: number; dir: number }

const launchTracks = (g: Geo): Track[] => [
  T("w", g.pw, g.pw - 12, 0, 100, E.out),
  T("oInput", 1, 0, 0, 160, E.in),
  T("inScale", 1, 0.6, 0, 160, E.in),
  T("oGlow", 1, 0, 0, 300, E.out),
  T("oAur", 1, 0, 0, 300, E.out),
  T("w", g.pw - 12, BALL_SMALL, 100, 560, E.io),
  T("h", PILL_H, PILL_H + 6, 380, 500, E.out),
  T("h", PILL_H + 6, BALL_SMALL, 500, 620, E.out),
  T("oPill", 1, 0, 300, 560, E.out),
  T("oBall", 0, 1, 300, 560, E.out),
  T("u", 0, 1, 620, 1500, E.fly),
  T("w", BALL_SMALL, FLY_D, 620, 1300, E.grow),
  T("h", BALL_SMALL, FLY_D, 620, 1300, E.grow),
  T("w", FLY_D, ORB_D, 1300, 1500, E.out),
  T("h", FLY_D, ORB_D, 1300, 1500, E.out),
  T("cHalo", 0, 0.6, 620, 1500, E.out),
  T("trail", 0, 1, 700, 800, E.out),
  T("trail", 1, 0, 1300, 1500, E.in),
];

const ASSEMBLE: Track[] = [
  T("oRing", 1, 0, 0, 300, E.out),
  T("oBall", 1, 0, 0, 260, E.out),
  T("orb.k", 0, 1, 0, 800, E.out),
  T("orb.alpha", 0, 1, 0, 800, E.out),
  T("orb.spin", 0, 0.9, 0, 800, E.out),
  T("orb.pop", 1, 1.05, 0, 420, E.out),
  T("orb.pop", 1.05, 1, 420, 800, E.io),
  T("sOp", 0, 1, 300, 620, E.out),
  T("sTy", 6, 0, 300, 620, E.out),
];

const RESOLVE: Track[] = [
  T("orb.sweep", 0, 1, 0, 700, E.io),
  T("orb.spin", 0.9, 0.3, 0, 700, E.out),
  T("orb.gain", 1, 0, 0, 700, E.out),
  T("orb.floor", 0, 0.95, 400, 900, E.out),
  T("orb.rad", 0, 0.15, 400, 900, E.out),
  T("orb.pop", 1, 1.04, 600, 800, E.out),
  T("orb.pop", 1.04, 1, 800, 900, E.out),
];

const CONDENSE: Track[] = [
  T("orb.pop", 1, 1.06, 0, 120, E.out),
  T("sOp", 1, 0, 0, 160, E.in),
  T("sTy", 0, -6, 0, 160, E.in),
  T("orb.k", 1, 0, 120, 640, E.vortex),
  T("orb.vortex", 0, 1.6, 120, 640, E.vortex),
  T("oGreen", 0, 1, 260, 700, E.spring),
  T("gs", 0.55, 1, 260, 700, E.spring),
  T("pulse", 0, 1, 320, 760, E.out),
  T("oHalo", 0, 0.35, 380, 700, E.out),
  T("orb.alpha", 1, 0, 500, 800, E.out),
];

const unfoldTracks = (g: Geo, tw: number): Track[] => [
  T("w", ORB_D, 124, 0, 90, E.in),
  T("h", ORB_D, 124, 0, 90, E.in),
  T("w", 124, g.cw, 90, 700, E.card),
  T("h", 124, g.ch, 90, 700, E.out),
  T("r", ORB_D / 2, 20, 90, 700, E.io),
  T("oGreen", 1, 0, 200, 560, E.out),
  T("oCard", 0, 1, 200, 560, E.out),
  T("oHalo", 0.35, 0, 300, 700, E.out),
  T("cHalo", 0.6, 0.22, 300, 700, E.out),
  T("hOp", 0, 1, 520, 840, E.out),
  T("dotS", 0, 1, 520, 840, E.spring),
  T("wp", 0, 1, 600, 600 + tw, E.lin),
  T("bloom", 1, 0.625, 700, 1200, E.io),
];

/* reduced-motion: pure cross-fades */
const R_OUT: Track[] = [
  T("oInput", 1, 0, 0, 140, E.out),
  T("oPill", 1, 0, 0, 200, E.out),
  T("oGlow", 1, 0, 0, 200, E.out),
  T("oAur", 1, 0, 0, 200, E.out),
  T("oRing", 1, 0, 0, 200, E.out),
];
const R_IN: Track[] = [
  T("orb.alpha", 0, 1, 0, 200, E.out),
  T("sOp", 0, 1, 0, 200, E.out),
  T("cHalo", 0, 0.6, 0, 200, E.out),
];
const R_RESOLVE: Track[] = [T("orb.sweep", 0, 1, 0, 250, E.io), T("orb.floor", 0, 0.95, 0, 250, E.out)];
const R_CONDENSE: Track[] = [
  T("oGreen", 0, 1, 0, 250, E.out),
  T("orb.alpha", 1, 0, 0, 250, E.out),
  T("sOp", 1, 0, 0, 250, E.out),
];
const R_GREEN_OUT: Track[] = [T("oGreen", 1, 0, 0, 120, E.out)];
const rCardIn = (tw: number): Track[] => [
  T("oCard", 0, 1, 0, 250, E.out),
  T("hOp", 0, 1, 0, 250, E.out),
  T("wp", 0, 1, 0, tw, E.lin),
  T("bloom", 1, 0.625, 0, 250, E.out),
];

const FADE = ["oGlow", "oAur", "oPill", "oBall", "oGreen", "oCard", "oRing", "oInput", "oHalo", "sOp", "orb.alpha", "trail"];

const INIT: Record<string, number> = {
  h: PILL_H, r: 999, oGlow: 1, oHalo: 0, oPill: 1, oBall: 0, oGreen: 0, oCard: 0, oRing: 1, oInput: 1, inScale: 1, oAur: 1,
  gs: 0.55, cs: 1, hOp: 0, dotS: 0, bloom: 1, u: 0, yOff: 0, trail: 0, pulse: -1, sOp: 0, sTy: 6, cHalo: 0, wp: 0,
  "orb.k": 0, "orb.alpha": 0, "orb.spin": 0, "orb.pop": 1, "orb.sweep": 0, "orb.vortex": 0, "orb.gain": 1, "orb.floor": 0, "orb.rad": 0,
};

/* ─────────────────────────── async utils ─────────────────────────── */
const ABORT = Symbol("abort");

function sleep(ms: number, sig: AbortSignal) {
  return new Promise<void>((res) => {
    if (sig.aborted) return res();
    let id = 0;
    const onAbort = () => { window.clearTimeout(id); res(); };
    id = window.setTimeout(() => { sig.removeEventListener("abort", onAbort); res(); }, Math.max(0, ms));
    sig.addEventListener("abort", onAbort, { once: true });
  });
}

function abortable<V>(p: Promise<V>, sig: AbortSignal) {
  return new Promise<V | undefined>((res) => {
    if (sig.aborted) return res(undefined);
    const onAbort = () => res(undefined);
    sig.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { sig.removeEventListener("abort", onAbort); res(v); },
      () => { sig.removeEventListener("abort", onAbort); res(undefined); }
    );
  });
}

/* ───────────────────────────── cricket ball ───────────────────────────── */
/*
 * Ball-local coordinates: unit sphere. The seam is the great circle in the
 * x = 0 plane, with a stitch row either side of it. It is tilted, spun about
 * the vertical axis and pitched toward the viewer, so the seam sweeps across
 * the face of the ball as it turns.
 */
const SEAM_N = 84;
const SEAM_TILT = 0.5, VIEW_PITCH = 0.32;
const STITCH_X = 0.09;
const SPECKS = (() => {
  const rand = mulberry32(11);
  const out: [number, number, number][] = [];
  for (let i = 0; i < 110; i++) {
    const y = rand() * 2 - 1, a = rand() * TAU, r = Math.sqrt(1 - y * y);
    out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return out;
})();
/* The orbit: stat lights on a tilted ring around the ball. */
const ORBIT_N = 54, ORBIT_R = 1.62, ORBIT_TILT = 0.3;

interface OrbParams {
  k: number; alpha: number; spin: number; rot: number; sweep: number; pop: number;
  vortex: number; gain: number; floor: number; rad: number; prog: number;
}
const ORB_KEYS = ["k", "alpha", "spin", "sweep", "pop", "vortex", "gain", "floor", "rad"] as const;

const rgba = (r: number, g: number, b: number, a: number) =>
  `rgba(${r | 0},${g | 0},${b | 0},${a <= 0 ? 0 : a >= 1 ? 1 : a.toFixed(3)})`;

function createBall(canvas: HTMLCanvasElement, getSpeed: () => number, isReduced: () => boolean) {
  const P: OrbParams = { k: 0, alpha: 0, spin: 0, rot: 0, sweep: 0, pop: 1, vortex: 0, gain: 1, floor: 0, rad: 0, prog: 0 };
  const ctx = canvas.getContext("2d");
  const lit = new Float32Array(ORBIT_N);
  const pw = [1, 0, 0, 0];
  let time = 0, orbitRot = 0, raf = 0, last = 0, dead = false;

  const reset = () => {
    P.k = 0; P.alpha = 0; P.spin = 0; P.rot = 0; P.sweep = 0; P.pop = 1; P.vortex = 0; P.gain = 1; P.floor = 0; P.rad = 0; P.prog = 0;
    lit.fill(0);
    pw[0] = 1; pw[1] = 0; pw[2] = 0; pw[3] = 0;
    time = isReduced() ? 1.2 : 0;
    orbitRot = 0;
  };
  reset();

  if (!ctx) return { P, ensure() {}, reset, destroy() {} };

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(CANVAS * dpr);
  canvas.height = Math.round(CANVAS * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const C0 = CANVAS / 2;
  const cT = Math.cos(SEAM_TILT), sT = Math.sin(SEAM_TILT);
  const cP = Math.cos(VIEW_PITCH), sP = Math.sin(VIEW_PITCH);
  const out = { x: 0, y: 0, z: 0 };
  /** Ball-local point → view space, for the current spin. */
  const xf = (x: number, y: number, z: number, cR: number, sR: number) => {
    const x1 = x * cT - y * sT, y1 = x * sT + y * cT, z1 = z;
    const x2 = x1 * cR + z1 * sR, z2 = -x1 * sR + z1 * cR;
    out.x = x2;
    out.y = y1 * cP - z2 * sP;
    out.z = y1 * sP + z2 * cP;
  };

  const drawSeamRow = (rowX: number, cx: number, cy: number, R: number, cR: number, sR: number, dashed: boolean, col: [number, number, number], width: number, a: number) => {
    const rr = Math.sqrt(1 - rowX * rowX);
    ctx.lineCap = "round";
    let px = 0, py = 0, pz = -1;
    for (let i = 0; i <= SEAM_N; i++) {
      const t = (i / SEAM_N) * TAU;
      xf(rowX, Math.cos(t) * rr, Math.sin(t) * rr, cR, sR);
      const sx = cx + out.x * R, sy = cy - out.y * R, sz = out.z;
      if (i > 0 && sz > 0 && pz > 0 && (!dashed || i % 2 === 0)) {
        ctx.strokeStyle = rgba(col[0], col[1], col[2], a * (0.35 + 0.65 * Math.min(sz, pz)));
        ctx.lineWidth = width * (0.55 + 0.45 * Math.min(sz, pz));
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(sx, sy);
        ctx.stroke();
      }
      px = sx; py = sy; pz = sz;
    }
  };

  const orbitDot = (j: number, front: boolean, cx: number, cy: number, R: number, ko: number, a: number) => {
    const ang = (j / ORBIT_N) * TAU + orbitRot;
    const ro = ORBIT_R * (0.35 + 0.65 * ko);
    const ox = Math.cos(ang) * ro, oz = Math.sin(ang) * ro;
    const tilt = ORBIT_TILT + Math.sin(time * 0.7) * 0.06;
    const vy = -oz * Math.sin(tilt), vz = oz * Math.cos(tilt);
    if ((vz > 0) !== front) return;
    const depth = (vz / ro + 1) / 2;
    const l = lit[j];
    const g = clamp01(P.sweep * 1.3 - (j / ORBIT_N) * 0.3);
    let al = 0.18 + 0.4 * depth + 0.7 * l * (1 - g) + g * (0.55 + 0.35 * depth);
    al = Math.max(al, P.floor * (0.6 + 0.4 * depth));
    const lg = Math.max(l, g);
    // pale floodlight blue → gold
    const r = lerp(186, 251, lg), gg = lerp(230, 191, lg), b = lerp(253, 36, lg);
    ctx.fillStyle = rgba(r, gg, b, al * a);
    ctx.beginPath();
    ctx.arc(cx + ox * R, cy + vy * R, (1.1 + 1.3 * depth + 1.3 * l) * (1 + P.rad), 0, TAU);
    ctx.fill();
  };

  const draw = (dt: number) => {
    ctx.clearRect(0, 0, CANVAS, CANVAS);
    time += dt;
    P.rot += P.spin * dt * 3.4;
    orbitRot += dt * (0.55 + P.vortex * 4);

    /* light programs, one per thinking label, cross-faded */
    const stepW = dt / 0.35;
    for (let q = 0; q < 4; q++) {
      const d = (q === P.prog ? 1 : 0) - pw[q];
      pw[q] += Math.abs(d) <= stepW ? d : d > 0 ? stepW : -stepW;
    }
    const decay = Math.exp(-dt / 0.45);
    const h0 = (time * 16) % ORBIT_N, h1 = (time * 26) % ORBIT_N;
    const fill = (time * 0.55) % 1;
    for (let j = 0; j < ORBIT_N; j++) {
      let pulse = 0;
      if (pw[0] > 0.001) { // Scouting: one light running the ring
        let dd = Math.abs(j - h0); if (dd > ORBIT_N - dd) dd = ORBIT_N - dd;
        const v = Math.max(0, 1 - dd / 6); pulse = Math.max(pulse, v * v * pw[0]);
      }
      if (pw[1] > 0.001) { // Searching: two lights, opposite, faster
        let d1 = Math.abs(j - h1); if (d1 > ORBIT_N - d1) d1 = ORBIT_N - d1;
        let d2 = Math.abs(j - ((h1 + ORBIT_N / 2) % ORBIT_N)); if (d2 > ORBIT_N - d2) d2 = ORBIT_N - d2;
        const v = Math.max(0, 1 - Math.min(d1, d2) / 4); pulse = Math.max(pulse, v * v * pw[1]);
      }
      if (pw[2] > 0.001) { // Reading the form: a ripple
        const v = Math.pow(Math.sin(time * 3.2 + j * 0.7) * 0.5 + 0.5, 4); pulse = Math.max(pulse, v * pw[2]);
      }
      if (pw[3] > 0.001) { // Building: the ring fills like an over
        const p = j / ORBIT_N, e = fill - p;
        const v = e > 0 ? (e < 0.06 ? 1 : 0.55) : 0; pulse = Math.max(pulse, v * pw[3]);
      }
      lit[j] = Math.max(lit[j] * decay, pulse * P.gain);
    }

    const ek = E.out(clamp01(P.k)) * P.pop;
    if (ek <= 0.001) return;
    const a = P.alpha;
    const bob = isReduced() ? 0 : Math.sin(time * 1.9) * 4.5 * ek;
    const R = BALL_R * ek;
    const cx = C0, cy = C0 - 6 + bob;
    const cR = Math.cos(P.rot + P.vortex * 2), sR = Math.sin(P.rot + P.vortex * 2);
    const ko = clamp01(P.k);

    /* shadow on the turf below: smaller and darker as the ball dips */
    const sh = 1 - bob / 20;
    ctx.fillStyle = rgba(0, 0, 0, 0.42 * a * ek * (0.8 + 0.2 * (1 - sh)));
    ctx.beginPath();
    ctx.ellipse(C0, C0 + BALL_R + 22, R * 0.78 * sh, R * 0.16 * sh, 0, 0, TAU);
    ctx.fill();

    /* floodlight halo, gold once SCOUT has the answer */
    const halo = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.75);
    halo.addColorStop(0, rgba(lerp(103, 251, P.sweep), lerp(232, 191, P.sweep), lerp(249, 36, P.sweep), (0.16 + 0.22 * P.sweep) * a));
    halo.addColorStop(1, rgba(0, 0, 0, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.75, 0, TAU);
    ctx.fill();

    for (let j = 0; j < ORBIT_N; j++) orbitDot(j, false, cx, cy, R, ko, a);

    /* leather */
    const body = ctx.createRadialGradient(cx - R * 0.38, cy - R * 0.42, R * 0.08, cx, cy, R);
    body.addColorStop(0, rgba(255, 128, 110, a));
    body.addColorStop(0.28, rgba(222, 32, 44, a));
    body.addColorStop(0.72, rgba(140, 12, 22, a));
    body.addColorStop(1, rgba(54, 4, 8, a));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();

    /* scuffs in the leather, turning with the ball */
    for (const [x, y, z] of SPECKS) {
      xf(x, y, z, cR, sR);
      if (out.z < 0.25) continue;
      ctx.fillStyle = rgba(40, 0, 4, 0.22 * a * out.z);
      ctx.fillRect(cx + out.x * R, cy - out.y * R, 1.2, 1.2);
    }

    /* the seam: cream, turning gold on "Got it" */
    const sc: [number, number, number] = [lerp(246, 252, P.sweep), lerp(230, 200, P.sweep), lerp(204, 60, P.sweep)];
    drawSeamRow(0, cx, cy, R, cR, sR, false, [120, 10, 18], 3.4 * ek, a * 0.8);
    drawSeamRow(-STITCH_X, cx, cy, R, cR, sR, true, sc, 2 * ek, a);
    drawSeamRow(STITCH_X, cx, cy, R, cR, sR, true, sc, 2 * ek, a);

    /* gloss and a floodlight rim */
    const gloss = ctx.createRadialGradient(cx - R * 0.4, cy - R * 0.45, 0, cx - R * 0.4, cy - R * 0.45, R * 0.6);
    gloss.addColorStop(0, rgba(255, 255, 255, 0.42 * a));
    gloss.addColorStop(1, rgba(255, 255, 255, 0));
    ctx.fillStyle = gloss;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = rgba(lerp(125, 251, P.sweep), lerp(211, 191, P.sweep), lerp(252, 36, P.sweep), (0.45 + 0.4 * P.sweep) * a);
    if (R > 2) {
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(cx, cy, R - 0.6, -0.25 * Math.PI, 0.55 * Math.PI);
      ctx.stroke();
    }

    for (let j = 0; j < ORBIT_N; j++) orbitDot(j, true, cx, cy, R, ko, a);
  };

  const frame = (now: number) => {
    raf = 0;
    if (dead) return;
    const dt = isReduced() ? 0 : Math.max(0, Math.min(0.05, (now - last) / 1000)) * getSpeed();
    last = now;
    draw(dt);
    if (P.alpha > 0.002) raf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, CANVAS, CANVAS);
  };

  const ensure = () => {
    if (raf || dead || P.alpha <= 0.002) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };

  const destroy = () => {
    dead = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  return { P, ensure, reset, destroy };
}

/* ───────────────────────────── runtime ───────────────────────────── */
/** What the answer reveals one by one: words, or the blocks of a rich answer. */
const REVEAL = ".mo-w, [data-reveal]";

interface UI {
  setPhase(p: Phase): void;
  swapLabel(name: string): void;
  resetLabel(): void;
  setAnswer(s: string): void;
  measure(s: string, width: number): number;
  revealCount(): number;
  clearInput(): void;
  live(s: string): void;
  lock(on: boolean): void;
  idleReady(): void;
  focusAnswer(): void;
}
interface Env {
  root: HTMLElement; mover: HTMLElement; actor: HTMLElement; form: HTMLElement; ghosts: HTMLElement[];
  canvas: HTMLCanvasElement; pulse: HTMLElement; status: HTMLElement;
  getBody: () => HTMLElement | null;
  ui: UI; getSpeed: () => number; isReduced: () => boolean;
}
interface RunCfg {
  onSubmit: (text: string) => Promise<string | void> | string | void;
  minThink: number;
  /** The label follows the caller (live agent status) instead of cycling. */
  liveLabels: boolean;
}
interface Runtime {
  start(text: string, cfg: RunCfg): boolean;
  escape(): void;
  reset(): void;
  hard(): void;
  home(): void;
  busy(): boolean;
  setProgram(n: number): void;
  destroy(): void;
}
interface Sample { t: number; x: number; y: number; d: number }

function sampleAt(h: Sample[], t: number, out: Sample) {
  const n = h.length;
  const copy = (s: Sample) => { out.x = s.x; out.y = s.y; out.d = s.d; };
  if (n === 0) { out.x = 0; out.y = 0; out.d = 0; return; }
  if (t <= h[0].t) return copy(h[0]);
  for (let i = n - 1; i > 0; i--) {
    const a = h[i - 1], b = h[i];
    if (t >= a.t) {
      if (t >= b.t) return copy(b);
      const k = (t - a.t) / (b.t - a.t || 1);
      out.x = lerp(a.x, b.x, k); out.y = lerp(a.y, b.y, k); out.d = lerp(a.d, b.d, k);
      return;
    }
  }
  copy(h[n - 1]);
}

function createRuntime(env: Env): Runtime {
  const { actor, mover, root, status, pulse, ghosts, form } = env;
  const life = new AbortController();
  const box = (): Box => ({
    w: root.clientWidth || window.innerWidth,
    h: root.clientHeight || window.innerHeight,
  });
  const geo: Geo = { pw: pillW(box()), cw: cardW(box()), ch: CARD_H, H: homeDy(box()), dir: -1 };
  const orb = createBall(env.canvas, env.getSpeed, env.isReduced);
  const vals: Record<string, number> = {};
  const dirty = new Set<string>();
  const CH: Record<string, (v: number) => void> = {};

  let current: AbortController | null = null;
  let idleCtl: AbortController | null = null;
  let busy = false, idling = false, epoch = 0;
  let curX = 0, curY = 0, curD = BALL_SMALL, trailVis = 0, ghostsShown = false;
  let wStagger = 45, wDur = 320;
  const hist: Sample[] = [];
  const tmp: Sample = { t: 0, x: 0, y: 0, d: 0 };

  const child = () => {
    const ac = new AbortController();
    if (life.signal.aborted) ac.abort();
    else life.signal.addEventListener("abort", () => ac.abort(), { once: true });
    return ac;
  };

  /* ── flight path + comet trail ── */
  const renderTrail = () => {
    if (trailVis <= 0.001) {
      if (ghostsShown) { ghosts.forEach((g) => (g.style.opacity = "0")); ghostsShown = false; }
      return;
    }
    ghostsShown = true;
    const now = performance.now();
    for (let i = 0; i < ghosts.length; i++) {
      sampleAt(hist, now - (i + 1) * 45, tmp);
      const k = (tmp.d * (1 - 0.08 * (i + 1))) / 100;
      const g = ghosts[i];
      g.style.transform = `translate3d(${(tmp.x - curX).toFixed(2)}px,${(tmp.y - curY).toFixed(2)}px,0) translate(-50%,-50%) scale(${k.toFixed(3)})`;
      g.style.opacity = (0.32 * Math.pow(1 - i / 6, 1.5) * trailVis).toFixed(3);
    }
  };

  const applyPath = () => {
    const u = vals.u ?? 0, H = geo.H;
    curX = bez(u, 0, geo.dir * 0.3 * H, 0);
    curY = bez(u, H, 0.6 * H, 0) + (vals.yOff ?? 0);
    mover.style.transform = `translate3d(${curX.toFixed(2)}px,${curY.toFixed(2)}px,0)`;
    const now = performance.now();
    hist.push({ t: now, x: curX, y: curY, d: curD });
    while (hist.length > 2 && hist[0].t < now - 500) hist.shift();
    renderTrail();
  };

  /* ── answer words ── */
  const applyWords = (v: number) => {
    const body = env.getBody();
    if (!body) return;
    const nodes = body.querySelectorAll<HTMLElement>(REVEAL);
    const total = (nodes.length - 1) * wStagger + wDur;
    const time = v * total;
    const reduced = env.isReduced();
    nodes.forEach((el, i) => {
      const p = E.out(clamp01((time - i * wStagger) / wDur));
      el.style.opacity = fmt(p);
      el.style.transform = p >= 0.999 || reduced ? "none" : `translateY(${fmt((1 - p) * 4)}px)`;
      el.style.filter = p >= 0.999 || reduced ? "none" : `blur(${fmt((1 - p) * 4)}px)`;
    });
  };

  /* ── channels ── */
  ["oGlow", "oHalo", "oPill", "oBall", "oGreen", "oCard", "oRing", "oInput", "oAur", "gs", "cs", "hOp", "dotS", "bloom"].forEach((n) => {
    CH[n] = (v) => actor.style.setProperty("--" + n, fmt(v));
  });
  ["w", "h", "r"].forEach((n) => {
    CH[n] = (v) => {
      actor.style.setProperty("--" + n, fmt(v) + "px");
      if (n === "w") curD = v;
    };
  });
  CH.inScale = (v) => {
    actor.style.setProperty("--inScale", fmt(v));
    form.style.filter = v >= 0.999 ? "none" : `blur(${fmt((1 - v) * 15)}px)`;
  };
  CH.sOp = (v) => status.style.setProperty("--sOp", fmt(v));
  CH.sTy = (v) => status.style.setProperty("--sTy", fmt(v));
  CH.cHalo = (v) => root.style.setProperty("--oCenter", fmt(v));
  CH.u = () => applyPath();
  CH.yOff = () => applyPath();
  CH.trail = (v) => { trailVis = v; renderTrail(); };
  CH.pulse = (v) => {
    if (v < 0) { pulse.style.opacity = "0"; return; }
    pulse.style.opacity = fmt(0.6 * (1 - v));
    pulse.style.transform = `scale(${fmt(1 + v)})`;
  };
  CH.wp = applyWords;
  ORB_KEYS.forEach((name) => {
    CH["orb." + name] = (v) => {
      orb.P[name] = v;
      if (name === "alpha") orb.ensure();
    };
  });

  const set = (ch: string, v: number) => { vals[ch] = v; dirty.add(ch); };
  const flush = () => { dirty.forEach((ch) => CH[ch]?.(vals[ch])); dirty.clear(); };
  const setNow = (ch: string, v: number) => { vals[ch] = v; CH[ch]?.(v); };
  const resetChannels = () => {
    setNow("w", geo.pw);
    for (const ch of Object.keys(INIT)) setNow(ch, INIT[ch]);
  };

  /* ── timeline engine ── */
  const play = (tracks: Track[], sig: AbortSignal) =>
    new Promise<void>((res) => {
      if (sig.aborted) return res();
      const end = tracks.reduce((m, k) => Math.max(m, k.t1), 0);
      const done = new Set<Track>();
      let raf = 0, t = 0, last = performance.now();
      const onAbort = () => { cancelAnimationFrame(raf); res(); };
      const finish = () => { sig.removeEventListener("abort", onAbort); res(); };
      const step = (now: number) => {
        const dt = Math.max(0, Math.min(100, now - last));
        last = now;
        t += dt * env.getSpeed();
        for (const k of tracks) {
          if (done.has(k) || t < k.t0) continue;
          const p = Math.min(1, (t - k.t0) / Math.max(1, k.t1 - k.t0));
          set(k.ch, k.from + (k.to - k.from) * (k.ease ?? E.io)(p));
          if (p === 1) done.add(k);
        }
        flush(); // one DOM write pass per frame
        if (t >= end) finish(); else raf = requestAnimationFrame(step);
      };
      sig.addEventListener("abort", onAbort, { once: true });
      raf = requestAnimationFrame(step);
    });

  /* ── thinking labels ── */
  const labelLoop = async (sig: AbortSignal, ctl: { stop: boolean }) => {
    let i = 0;
    for (;;) {
      await sleep(1150 / env.getSpeed(), sig);
      if (sig.aborted || ctl.stop) return;
      i = (i + 1) % COPY.labels.length;
      orb.P.prog = i % 4;
      env.ui.swapLabel(COPY.labels[i]);
    }
  };

  /* ── orchestrator ── */
  const run = async (text: string, sig: AbortSignal, cfg: RunCfg) => {
    const reduced = env.isReduced();
    const go = async (tracks: Track[]) => {
      await play(tracks, sig);
      if (sig.aborted) throw ABORT;
    };
    try {
      env.ui.setPhase("launch");
      hist.length = 0;
      if (!reduced) {
        await go(launchTracks(geo));
        setNow("r", ORB_D / 2);
        env.ui.setPhase("assemble");
        await go(ASSEMBLE);
      } else {
        await go(R_OUT);
        setNow("u", 1); setNow("w", ORB_D); setNow("h", ORB_D); setNow("r", ORB_D / 2);
        setNow("sTy", 0); setNow("orb.k", 1); setNow("orb.spin", 0);
        env.ui.setPhase("assemble");
        await go(R_IN);
      }

      /* think — until the answer settled AND the minimum time elapsed */
      env.ui.setPhase("think");
      env.ui.live(COPY.labels[0]);
      const ctl = { stop: false };
      if (!cfg.liveLabels) void labelLoop(sig, ctl);
      const t0 = performance.now();
      const pending = Promise.resolve()
        .then(() => cfg.onSubmit(text))
        .then((b) => (typeof b === "string" && b.trim() ? b : cfg.liveLabels ? "" : COPY.answerBody), () => COPY.answerBody);
      const got = await abortable(pending, sig);
      if (sig.aborted) throw ABORT;
      const body = got ?? COPY.answerBody;
      await sleep(cfg.minThink / env.getSpeed() - (performance.now() - t0), sig);
      ctl.stop = true;
      if (sig.aborted) throw ABORT;

      const words = body.split(/\s+/).filter(Boolean);
      const n = Math.max(1, env.ui.revealCount() || words.length);

      // Size the card to its answer once, here, rather than reading layout in frames.
      geo.cw = cardW(box());
      geo.ch = Math.min(maxCardH(box()), Math.max(CARD_H, env.ui.measure(body, geo.cw)));

      if (!reduced) {
        env.ui.setPhase("resolve");
        env.ui.swapLabel(COPY.done);
        await go(RESOLVE);

        env.ui.setPhase("condense");
        await go(CONDENSE);

        env.ui.setPhase("unfold");
        wDur = 320;
        wStagger = n > 1 ? Math.min(45, 900 / (n - 1)) : 0;
        env.ui.setAnswer(body);
        await go(unfoldTracks(geo, (n - 1) * wStagger + wDur));
      } else {
        env.ui.setPhase("resolve");
        env.ui.swapLabel(COPY.done);
        await go(R_RESOLVE);
        await sleep(350 / env.getSpeed(), sig);
        if (sig.aborted) throw ABORT;

        env.ui.setPhase("condense");
        setNow("gs", 1);
        await go(R_CONDENSE);

        env.ui.setPhase("unfold");
        wDur = 250;
        wStagger = 0;
        env.ui.setAnswer(body);
        await go(R_GREEN_OUT);
        setNow("w", geo.cw); setNow("h", geo.ch); setNow("r", 20); setNow("dotS", 1);
        await go(rCardIn(wDur));
      }

      env.ui.setPhase("answered");
      env.ui.live("Answer ready: " + body);
      env.ui.focusAnswer();
    } catch (e) {
      if (e === ABORT) return;
      hard();
    }
  };

  /* ── return to the idle pill ── */
  const toIdle = async (kind: "reset" | "esc") => {
    if (idling) return;
    idling = true;
    const my = ++epoch;
    const ac = child();
    idleCtl = ac;
    const sig = ac.signal;
    const outMs = kind === "reset" ? 240 : 200;
    const inMs = kind === "reset" ? 420 : 200;
    env.ui.setPhase("reset");

    const out: Track[] = [T("cHalo", vals.cHalo ?? 0, 0, 0, outMs, E.out)];
    for (const ch of FADE) {
      const v = vals[ch] ?? 0;
      if (v > 0.001) out.push(T(ch, v, 0, 0, outMs, E.out));
    }
    if (kind === "reset") out.push(T("cs", 1, 0.98, 0, outMs, E.out));
    await play(out, sig);
    if (sig.aborted || my !== epoch) return;

    setNow("pulse", -1);
    env.ui.setAnswer("");
    env.ui.resetLabel();
    env.ui.clearInput();
    orb.reset();
    hist.length = 0;
    geo.pw = pillW(box()); geo.cw = cardW(box()); geo.H = homeDy(box());
    resetChannels();
    const pillCh = ["oPill", "oInput", "oGlow", "oAur", "oRing"];
    pillCh.forEach((ch) => setNow(ch, 0));
    setNow("yOff", kind === "reset" ? 8 : 0);
    const inn: Track[] = pillCh.map((ch) => T(ch, 0, 1, 0, inMs, E.out));
    if (kind === "reset") inn.push(T("yOff", 8, 0, 0, inMs, E.out));
    await play(inn, sig);
    if (sig.aborted || my !== epoch) return;

    resetChannels();
    current = null; idleCtl = null; busy = false; idling = false;
    env.ui.lock(false);
    env.ui.setPhase("idle");
    env.ui.idleReady();
  };

  function hard() {
    epoch++;
    current?.abort(); current = null;
    idleCtl?.abort(); idleCtl = null;
    orb.reset();
    hist.length = 0;
    env.ui.setAnswer("");
    env.ui.resetLabel();
    geo.pw = pillW(box()); geo.cw = cardW(box()); geo.H = homeDy(box());
    resetChannels();
    setNow("pulse", -1);
    busy = false; idling = false;
    env.ui.lock(false);
    env.ui.setPhase("idle");
    env.ui.idleReady();
  }

  resetChannels();

  return {
    start(text, cfg) {
      if (busy) return false;
      busy = true;
      geo.pw = pillW(box()); geo.cw = cardW(box()); geo.H = homeDy(box()); // snapshot once, never read layout in frames
      geo.dir = -geo.dir;
      orb.reset();
      setNow("u", 0);
      const ac = child();
      current = ac;
      env.ui.lock(true);
      void run(text, ac.signal, cfg);
      return true;
    },
    escape() {
      if (!busy || idling) return;
      current?.abort();
      void toIdle("esc");
    },
    reset() {
      if (!busy || idling) return;
      void toIdle("reset");
    },
    hard,
    home() {
      if (busy) return;
      geo.pw = pillW(box()); geo.cw = cardW(box()); geo.H = homeDy(box());
      setNow("w", geo.pw);
      setNow("u", 0);
    },
    busy: () => busy,
    setProgram(n) {
      orb.P.prog = ((n % 4) + 4) % 4;
    },
    destroy() {
      life.abort();
      orb.destroy();
    },
  };
}

/* ───────────────────────────── answer text ───────────────────────────── */
/** Lines of words. Words animate one by one; lines keep their breaks. */
function toLines(s: string) {
  return s
    .split(/\n+/)
    .map((line) => line.split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

function AnswerText({ text }: { text: string }) {
  let k = 0;
  return (
    <>
      {toLines(text).map((words, li) => (
        <span className="mo-line" key={li}>
          {words.map((w) => (
            <React.Fragment key={k++}>
              <span className="mo-w">{w}</span>{" "}
            </React.Fragment>
          ))}
        </span>
      ))}
    </>
  );
}

/* ───────────────────────────── component ───────────────────────────── */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export default function ScoutOrb(props: ScoutOrbProps) {
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [innerValue, setInnerValue] = useState("");
  const controlled = props.value !== undefined;
  const value = controlled ? (props.value as string) : innerValue;
  const setValue = (v: string) => {
    if (props.onValueChange) props.onValueChange(v);
    if (!controlled) setInnerValue(v);
  };
  const setValueRef = useRef(setValue);
  setValueRef.current = setValue;
  const [lbl, setLbl] = useState<{ cur: string; prev: string | null; n: number }>({ cur: COPY.labels[0], prev: null, n: 0 });
  const [answer, setAnswer] = useState("");
  const [dbgSpeed, setDbgSpeed] = useState(1);
  const [debug] = useState(() => typeof window !== "undefined" && /[?&]debug(?:[=&]|$)/.test(window.location.search));

  const rootRef = useRef<HTMLDivElement>(null);
  const moverRef = useRef<HTMLDivElement>(null);
  const actorRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pulseRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const measureBodyRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const ghostRefs = useRef<(HTMLSpanElement | null)[]>([]);

  const propsRef = useRef(props);
  propsRef.current = props;
  const activeRef = useRef(props.active ?? true);
  activeRef.current = props.active ?? true;
  const rich = props.answer !== undefined && props.answer !== null;
  const speedRef = useRef(1);
  speedRef.current = Math.max(0.05, (props.speed ?? 1) * dbgSpeed);
  const phaseRef = useRef<Phase>("idle");
  const reducedRef = useRef(false);
  const rtRef = useRef<Runtime | null>(null);
  const lastTextRef = useRef("");
  const timers = useRef<{ typing?: number; shake?: number; flash?: number }>({});

  useIsoLayoutEffect(() => {
    const root = rootRef.current, mover = moverRef.current, actor = actorRef.current, canvas = canvasRef.current;
    const pulse = pulseRef.current, status = statusRef.current, form = formRef.current;
    const ghosts = ghostRefs.current.filter((g): g is HTMLSpanElement => !!g);
    if (!root || !mover || !actor || !canvas || !pulse || !status || !form) return;

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedRef.current = mq.matches;
    const onMq = (e: MediaQueryListEvent) => { reducedRef.current = e.matches; };
    mq.addEventListener("change", onMq);

    const rt = createRuntime({
      root, mover, actor, form, ghosts, canvas, pulse, status,
      getBody: () => bodyRef.current,
      getSpeed: () => speedRef.current,
      isReduced: () => reducedRef.current,
      ui: {
        setPhase: (p) => { phaseRef.current = p; setPhaseState(p); propsRef.current.onPhaseChange?.(p); },
        swapLabel: (name) => setLbl((l) => (l.cur === name ? l : { cur: name, prev: l.cur, n: l.n + 1 })),
        resetLabel: () => setLbl((l) => ({ cur: propsRef.current.statusText ?? COPY.labels[0], prev: null, n: l.n + 1 })),
        setAnswer: (s) => setAnswer(s),
        measure: (s, width) => {
          const m = measureRef.current, mb = measureBodyRef.current;
          if (!m || !mb) return CARD_H;
          m.style.width = width + "px";
          // A rich answer is already rendered in the twin; just read it.
          const p = propsRef.current;
          if (p.answer !== undefined && p.answer !== null) {
            return Math.ceil(m.getBoundingClientRect().height) + 4;
          }
          // Same structure as the real card -- one block per line -- so the
          // gaps between lines are counted too.
          mb.replaceChildren(
            ...toLines(s).map((words) => {
              const line = document.createElement("span");
              line.className = "mo-line";
              line.textContent = words.join(" ");
              return line;
            }),
          );
          return Math.ceil(m.getBoundingClientRect().height) + 4;
        },
        revealCount: () => bodyRef.current?.querySelectorAll(REVEAL).length ?? 0,
        clearInput: () => setValueRef.current(""),
        live: (s) => { if (liveRef.current) liveRef.current.textContent = s; },
        lock: (on) => { form.toggleAttribute("inert", on); },
        idleReady: () => { if (activeRef.current) inputRef.current?.focus({ preventScroll: true }); },
        focusAnswer: () => { answerRef.current?.focus({ preventScroll: true }); },
      },
    });
    rtRef.current = rt;

    /*
      Escape belongs to the turn while there is one. Listened for in the
      capture phase and stopped there, so a page-level Escape handler (SCOUT's
      own "close the panel") does not also fire and shut the panel on a
      question the user only meant to abandon. Idle, it passes straight through.
    */
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (e.key === "Escape" && phaseRef.current !== "idle" && phaseRef.current !== "reset") {
        e.preventDefault();
        e.stopPropagation();
        propsRef.current.onCancel?.();
        rt.escape();
      }
    };
    // The stage resizes with its container, not only the window.
    const ro = new ResizeObserver(() => {
      if (phaseRef.current === "idle" && !rt.busy()) rt.home();
    });
    ro.observe(root);
    window.addEventListener("keydown", onKey, true);
    if (activeRef.current) inputRef.current?.focus({ preventScroll: true });

    return () => {
      window.removeEventListener("keydown", onKey, true);
      ro.disconnect();
      mq.removeEventListener("change", onMq);
      window.clearTimeout(timers.current.typing);
      window.clearTimeout(timers.current.shake);
      window.clearTimeout(timers.current.flash);
      rt.destroy();
      rtRef.current = null;
    };
  }, []);

  const defaultSubmit = () =>
    new Promise<string>((res) => {
      window.setTimeout(() => res(COPY.answerBody), 4600 / speedRef.current);
    });
  const makeCfg = (): RunCfg => ({
    onSubmit: propsRef.current.onSubmit ?? defaultSubmit,
    minThink: propsRef.current.minThinkMs ?? 3450,
    liveLabels: propsRef.current.statusText !== undefined,
  });

  /* Live status: the label follows the agent that is actually working. */
  useEffect(() => {
    if (props.statusText === undefined) return;
    if (phase !== "assemble" && phase !== "think") return;
    const next = props.statusText;
    setLbl((l) => (l.cur === next ? l : { cur: next, prev: l.cur, n: l.n + 1 }));
  }, [props.statusText, phase]);

  useEffect(() => {
    rtRef.current?.setProgram(props.program ?? 0);
  }, [props.program]);

  /* With auto-return, the answered card hands back to the pill on its own. */
  useEffect(() => {
    if (phase !== "answered" || props.autoReturnMs === undefined) return;
    const id = window.setTimeout(() => {
      if (phaseRef.current !== "answered") return;
      propsRef.current.onReset?.();
      rtRef.current?.reset();
    }, props.autoReturnMs);
    return () => window.clearTimeout(id);
  }, [phase, props.autoReturnMs]);

  /* Opening the surface puts the cursor in the pill, as the old composer did. */
  useEffect(() => {
    if (!props.active || phaseRef.current !== "idle") return;
    const id = window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(id);
  }, [props.active]);

  const shake = () => {
    const a = actorRef.current;
    if (!a) return;
    a.removeAttribute("data-shake");
    void a.offsetWidth;
    a.setAttribute("data-shake", "");
    a.setAttribute("data-flash", "");
    window.clearTimeout(timers.current.shake);
    window.clearTimeout(timers.current.flash);
    timers.current.shake = window.setTimeout(() => a.removeAttribute("data-shake"), 260);
    timers.current.flash = window.setTimeout(() => a.removeAttribute("data-flash"), 200);
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
    const a = actorRef.current;
    if (!a) return;
    a.setAttribute("data-typing", "");
    window.clearTimeout(timers.current.typing);
    timers.current.typing = window.setTimeout(() => a.removeAttribute("data-typing"), 300);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && (e.shiftKey || e.nativeEvent.isComposing)) e.preventDefault();
  };

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const rt = rtRef.current;
    if (!rt || rt.busy() || phaseRef.current !== "idle") return;
    const text = value.trim();
    if (!text) { shake(); return; }
    lastTextRef.current = text;
    rt.start(text, makeCfg());
  };

  const onReset = () => {
    if (phaseRef.current !== "answered") return;
    propsRef.current.onReset?.();
    rtRef.current?.reset();
  };

  const pickSuggestion = (s: string) => {
    const rt = rtRef.current;
    if (!rt || phaseRef.current !== "idle") return;
    if (propsRef.current.submitSuggestions && !rt.busy()) {
      lastTextRef.current = s;
      setValue(s);
      rt.start(s, makeCfg());
      return;
    }
    setValue(s);
    inputRef.current?.focus({ preventScroll: true });
  };

  const replay = () => {
    const rt = rtRef.current;
    if (!rt) return;
    const text = lastTextRef.current || "Best uncapped batter";
    lastTextRef.current = text;
    rt.hard();
    setValue(text);
    window.requestAnimationFrame(() => { rt.start(text, makeCfg()); });
  };

  const ready = value.trim().length > 0;

  const labelInner = (name: string) =>
    name === COPY.done ? (
      <span className="mo-lab-done">{name}</span>
    ) : (
      <>
        <span className="mo-lab-t">{name}</span>
        <span className="mo-dots" aria-hidden="true"><i /><i /><i /></span>
      </>
    );

  const answerHead = (
    <div className="mo-a-head">
      <i className="mo-a-dot" aria-hidden="true" />
      <span className="mo-a-title">{COPY.answerTitle}</span>
      <span className="mo-a-tag">{COPY.answerTag}</span>
    </div>
  );

  return (
    <div className="mo-root" data-phase={phase} ref={rootRef}>
      <div className="mo-bg" aria-hidden="true" />
      <div className="mo-halo" aria-hidden="true" />

      <div className="mo-mover" ref={moverRef}>
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className="mo-trail" aria-hidden="true" ref={(el) => { ghostRefs.current[i] = el; }} />
        ))}

        <div className="mo-actor" ref={actorRef}>
          <div className="mo-underglow" aria-hidden="true" />
          <div className="mo-halo-green" aria-hidden="true" />
          <div className="mo-surface" aria-hidden="true">
            <div className="mo-aurora"><i /><i /><i /><i /></div>
          </div>
          <div className="mo-ball" aria-hidden="true" />
          <div className="mo-green" aria-hidden="true" />
          <div className="mo-card" aria-hidden="true" />
          <div className="mo-ring" aria-hidden="true" />

          <form className="mo-input" ref={formRef} onSubmit={onFormSubmit} autoComplete="off">
            {/* A cricket ball, seam and all, where the original had a sparkle. */}
            <svg className="mo-spark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8.2 5.2c2.6 3.6 2.6 10 0 13.6M15.8 5.2c-2.6 3.6-2.6 10 0 13.6" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.4" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              className="mo-field"
              type="text"
              value={value}
              maxLength={200}
              placeholder={COPY.placeholder}
              aria-label="Ask SCOUT"
              spellCheck={false}
              onChange={onChange}
              onKeyDown={onKeyDown}
            />
            <button type="submit" className="mo-send" aria-label={COPY.send} data-ready={ready ? "" : undefined}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5" />
                <path d="M5.5 11.5L12 5l6.5 6.5" />
              </svg>
            </button>
          </form>

          <canvas className="mo-orb" ref={canvasRef} aria-hidden="true" />
          <div className="mo-pulse" ref={pulseRef} aria-hidden="true" />

          <div className="mo-answer" ref={answerRef} tabIndex={-1} role="group" aria-label={COPY.answerTitle}>
            {answerHead}
            <div className="mo-a-body" ref={bodyRef}>
              {rich ? props.answer : <AnswerText text={answer} />}
            </div>
          </div>
        </div>
      </div>

      {/* Off-screen twin of the answer card, used once per answer to size the card. */}
      <div className="mo-answer mo-measure" ref={measureRef} aria-hidden="true">
        {answerHead}
        <div className="mo-a-body" ref={measureBodyRef}>
          {rich ? props.answer : null}
        </div>
      </div>

      {props.suggestions && props.suggestions.length > 0 && (
        <div className="mo-suggest" aria-label="Suggested questions">
          {props.suggestions.map((s) => (
            <button key={s} type="button" className="mo-chip" onClick={() => pickSuggestion(s)} tabIndex={phase === "idle" ? 0 : -1}>
              {s}
            </button>
          ))}
        </div>
      )}

      {props.belowStatus !== undefined && (
        <div className="mo-below">{props.belowStatus}</div>
      )}

      <div className="mo-status" ref={statusRef} aria-hidden="true">
        {lbl.prev !== null && (
          <span key={"p" + lbl.n} className="mo-lab mo-out">{labelInner(lbl.prev)}</span>
        )}
        <span key={"c" + lbl.n} className="mo-lab mo-in">{labelInner(lbl.cur)}</span>
      </div>

      {props.autoReturnMs === undefined && (
        <button type="button" className="mo-reset" onClick={onReset} tabIndex={phase === "answered" ? 0 : -1}>{COPY.reset}</button>
      )}

      <div className="mo-live" ref={liveRef} role="status" aria-live="polite" />

      {debug && (
        <div className="mo-debug">
          <span className="mo-dchip">{phase}</span>
          <label>
            <span>{dbgSpeed.toFixed(2)}×</span>
            <input
              type="range"
              min={0.25}
              max={2}
              step={0.05}
              value={dbgSpeed}
              aria-label="Speed"
              onChange={(e) => setDbgSpeed(parseFloat(e.target.value))}
            />
          </label>
          <button type="button" onClick={replay}>Replay</button>
        </div>
      )}
    </div>
  );
}
