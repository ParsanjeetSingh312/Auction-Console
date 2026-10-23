/**
 * MarqueeReveal.tsx
 * The moment a marquee player is put on the block.
 *
 * One GSAP timeline, two acts:
 *
 *   1. The strike (three.js, the opening's stadium reused): a white ball at
 *      full pace into the stumps, and the wicket breaking in the player's
 *      franchise colours -- LED bails, a spark burst and a flash of light.
 *   2. The reveal (DOM): a team-colour flash cuts to the card, then three
 *      highlight stats one by one, the tagline, the jersey number in the
 *      team's colour, lightning, and last of all the name.
 *
 * Then it hands back to the bidding screen through `onDone`.
 *
 * The beats, in seconds:
 *
 *   0.00  lights up, camera low behind the wicket
 *   0.30  ball released; in the stumps at 0.90 -- sparks, slow motion
 *   2.25  team-colour flash; the card takes over
 *   2.75  stat one, 3.35 stat two, 3.95 stat three (each counts up)
 *   4.70  tagline       5.30  jersey number       6.00  lightning
 *   6.50  name          8.60  out to the bidding screen (done at ~9.2)
 *
 * The stage is built once when this mounts and reused for every player, so
 * putting a player up never waits on a stadium being built; between reveals
 * it is frozen and draws nothing. Reduced motion skips the film and shows the
 * finished card for a moment instead.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import gsap from "gsap";

import { useQuality } from "../3D/rig/quality";
import { createIntroStage, type IntroStage } from "../Intro/introScene";
import type { MarqueePlayer } from "./marqueePlayers";
import "./marquee.css";
import { livePlayerNow, overlayStats, prefetchLivePool } from "../../console/statsApi";

export interface MarqueeRevealProps {
  /** The player to reveal. A new object (or a new `runKey`) plays it. */
  player: MarqueePlayer | null;
  /** Bump to replay the same player. */
  runKey?: number;
  /** Called when the reveal has handed back to the bidding screen. */
  onDone: () => void;
  /**
   * Seconds into the reveal to start from. The live room starts every client's
   * reveal from the room's own clock, so a franchise whose frame arrived late,
   * or who joined mid-reveal, sees the same moment as everyone else.
   */
  startAt?: number;
  /**
   * Offer Skip (and Escape). Off in the live room: the room is holding the lot
   * for the reveal, so skipping would only show a block nobody can bid on yet.
   */
  skippable?: boolean;
}

/** The reveal's length, in seconds. The room holds a marquee lot slightly longer. */
export const MARQUEE_REVEAL_SECONDS = 9.2;

const fmt = (value: number, decimals = 0) =>
  value.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/**
 * A jagged bolt from above the top edge down to (x, y), with one fork, in
 * screen pixels.
 *
 * Pixels rather than a stretched 0-100 viewBox: a dash animation measures the
 * path in the same units it draws it, and a non-uniformly scaled path drew as
 * dashes instead of a line.
 */
function boltPath(seed: number, x: number, y: number, w: number): string {
  let s = seed;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const startX = x + (rand() - 0.5) * w * 0.22;
  const steps = 12;
  const jitter = w * 0.03;
  const pts: Array<[number, number]> = [[startX, -10]];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    pts.push([
      startX + (x - startX) * t + (rand() - 0.5) * jitter * (1 - t * 0.55),
      -10 + (y + 10) * t,
    ]);
  }
  const main = "M " + pts.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join(" L ");

  // A fork off the middle of the bolt, angled away and shorter.
  const [fx, fy] = pts[Math.floor(steps * (0.35 + rand() * 0.2))];
  const dir = rand() < 0.5 ? -1 : 1;
  const fork: string[] = [`M ${fx.toFixed(1)} ${fy.toFixed(1)}`];
  let cx = fx;
  let cy = fy;
  for (let i = 0; i < 4; i++) {
    cx += dir * (w * 0.012 + rand() * w * 0.02);
    cy += 14 + rand() * 26;
    fork.push(`L ${cx.toFixed(1)} ${cy.toFixed(1)}`);
  }
  return `${main} ${fork.join(" ")}`;
}

export default function MarqueeReveal({
  player,
  runKey = 0,
  onDone,
  startAt = 0,
  skippable = true,
}: MarqueeRevealProps) {
  const quality = useQuality();
  // Warm the live pool as soon as the reveal mounts, well before a player is put up.
  useEffect(() => prefetchLivePool(), []);
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const stageRef = useRef<IntroStage | null>(null);
  const tlRef = useRef<gsap.core.Timeline | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const [failed, setFailed] = useState(false);

  // The stage: built once, frozen until a player is put up.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    try {
      const stage = createIntroStage(el, { tier: quality.tier });
      stage.setLive(false);
      stageRef.current = stage;
      if (import.meta.env.DEV) (window as unknown as { __marquee?: unknown }).__marquee = { stage };
      return () => {
        stage.dispose();
        stageRef.current = null;
      };
    } catch (error) {
      console.warn("[MarqueeReveal] WebGL unavailable; the reveal plays without the strike.", error);
      setFailed(true);
      return undefined;
    }
  }, [quality.tier]);

  const finish = useCallback(() => {
    const tl = tlRef.current;
    if (tl) tl.progress(1);
  }, []);

  useLayoutEffect(() => {
    const scope = root.current;
    if (!player || !scope) return;
    const stage = stageRef.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const ctx = gsap.context(() => {
      const q = gsap.utils.selector(scope);
      const done = () => {
        stage?.setLive(false);
        gsap.set(scope, { autoAlpha: 0 });
        doneRef.current();
      };

      gsap.set(scope, { autoAlpha: 1 });
      // Where the jersey number sits, measured before any tween transforms it,
      // so the lightning can be aimed at it.
      const numeralEl = q(".mq-jersey span")[0] as HTMLElement | undefined;
      const numeralRect = numeralEl ? numeralEl.getBoundingClientRect() : null;
      gsap.set(q(".mq-card, .mq-backdrop, .mq-flash, .mq-flicker"), { autoAlpha: 0 });
      gsap.set(q(".mq-stage"), { autoAlpha: 1, filter: "blur(0px) brightness(1)" });

      // The figures the entry was written with, replaced by the pool's current
      // career where it has loaded. Read once, at the moment the reveal plays,
      // so a pool arriving mid-animation cannot restart it.
      const liveStats = overlayStats(player.stats, livePlayerNow(player.poolName));

      if (reduced) {
        gsap.set(q(".mq-card, .mq-backdrop"), { autoAlpha: 1 });
        gsap.set(q(".mq-stage"), { autoAlpha: 0 });
        q(".mq-stat-value").forEach((el, i) => {
          el.textContent = fmt(liveStats[i].value, liveStats[i].decimals);
        });
        const t = gsap.delayedCall(3, done);
        tlRef.current = gsap.timeline().add(t);
        return;
      }

      const tl = gsap.timeline({ defaults: { ease: "power2.out" }, onComplete: done });
      tlRef.current = tl;
      if (import.meta.env.DEV) {
        (window as unknown as { __marquee?: Record<string, unknown> }).__marquee = { stage, tl };
      }

      /* ---------------- act one: the strike ---------------- */
      if (stage && !failed) {
        const s = stage.state;
        stage.reset();
        stage.setTeamColors(player.team.primary, player.team.secondary);
        stage.setLive(true);
        const orbit = { a: Math.atan2(1.2, 3.2), r: Math.hypot(1.2, 3.2), h: 0.55 };

        tl.set(s, { exposure: 0, delivery: -1, timeScale: 1, drift: 0, shake: 0, fov: 30 }, 0)
          .set(s.cam, { x: 1.7, y: 0.62, z: 3.9 }, 0)
          .set(s.look, { x: -1.1, y: 0.42, z: -5.5 }, 0)
          .to(s, { exposure: 1.12, duration: 0.4 }, 0)
          .to(s.cam, { x: 1.2, y: 0.55, z: 3.2, duration: 0.9, ease: "power1.inOut" }, 0)
          .to(s.look, { x: -0.9, y: 0.42, z: -5, duration: 0.9, ease: "power1.inOut" }, 0)
          .set(s, { delivery: 0 }, 0.3)
          .to(s, { delivery: 1, duration: 0.6, ease: "none" }, 0.3)
          .call(() => stage.strike(), undefined, 0.9)
          .to(s, { timeScale: 0.06, duration: 0.1 }, 0.9)
          .fromTo(s, { shake: 1 }, { shake: 0, duration: 0.7, immediateRender: false }, 0.9)
          .fromTo(q(".mq-flash"), { autoAlpha: 0.5 }, { autoAlpha: 0, duration: 0.4, immediateRender: false }, 0.9)
          .to(orbit, {
            a: -0.6, r: 2.5, h: 0.9, duration: 1.4, ease: "sine.inOut",
            onUpdate: () => {
              s.cam.x = Math.sin(orbit.a) * orbit.r;
              s.cam.z = Math.cos(orbit.a) * orbit.r;
              s.cam.y = orbit.h;
            },
          }, 0.92)
          .to(s.look, { x: 0, y: 0.45, z: 0.3, duration: 1.4, ease: "sine.inOut" }, 0.92)
          .to(s, { timeScale: 0.5, duration: 0.3, ease: "power2.in" }, 2.0);
      }

      /* ---------------- the cut ---------------- */
      tl.to(q(".mq-flash"), { autoAlpha: 1, duration: 0.18, ease: "power2.in" }, 2.25)
        .set(q(".mq-backdrop, .mq-card"), { autoAlpha: 1 }, 2.45)
        .set(q(".mq-stage"), { filter: "blur(10px) brightness(0.45)" }, 2.45)
        .call(() => stage?.setLive(false), undefined, 2.5)
        .to(q(".mq-flash"), { autoAlpha: 0, duration: 0.5 }, 2.45);

      /* ---------------- act two: the card ---------------- */
      // Everything in the card starts hidden; each beat brings in its own part.
      tl.set(q(".mq-meta, .mq-stat, .mq-tagline, .mq-jersey, .mq-first, .mq-last-char"), { autoAlpha: 0 }, 0);

      tl.fromTo(q(".mq-meta"), { y: -12, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.5 }, 2.6);

      // Stats, one by one, each counting up to the pool's figure.
      q(".mq-stat").forEach((row, i) => {
        const at = 2.75 + i * 0.6;
        const valueEl = row.querySelector<HTMLElement>(".mq-stat-value");
        const stat = liveStats[i];
        const counter = { v: 0 };
        tl.fromTo(row, { x: -48, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.55, ease: "expo.out" }, at)
          .fromTo(
            counter,
            { v: 0 },
            {
              v: stat.value,
              duration: 0.75,
              ease: "power3.out",
              onUpdate: () => {
                if (valueEl) valueEl.textContent = fmt(counter.v, stat.decimals);
              },
            },
            at,
          );
      });

      // The tagline slams in.
      tl.fromTo(
        q(".mq-tagline"),
        { scale: 1.7, autoAlpha: 0, letterSpacing: "0.4em" },
        { scale: 1, autoAlpha: 1, letterSpacing: "0.02em", duration: 0.55, ease: "expo.out" },
        4.7,
      ).fromTo(q(".mq-card-inner"), { x: -6 }, { x: 0, duration: 0.35, ease: "elastic.out(1, 0.3)" }, 4.82);

      // The jersey number, in the team's colour.
      tl.fromTo(
        q(".mq-jersey"),
        { scale: 1.45, autoAlpha: 0, filter: "blur(18px)" },
        { scale: 1, autoAlpha: 1, filter: "blur(0px)", duration: 0.75, ease: "expo.out" },
        5.3,
      );

      // Lightning: bolts strike the number, the screen flickers, sparks fly.
      // Built here, in pixels, aimed at where the number actually sits.
      const svg = scope.querySelector<SVGSVGElement>(".mq-bolts");
      if (svg) {
        const W = scope.clientWidth;
        const H = scope.clientHeight;
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        const numeral = numeralRect;
        const tx = numeral ? numeral.left + numeral.width / 2 : W * 0.78;
        const ty = numeral ? numeral.top + numeral.height * 0.42 : H * 0.45;
        const ns = "http://www.w3.org/2000/svg";
        svg.replaceChildren();
        [-1, 0, 1].forEach((offset, i) => {
          const d = boltPath(
            player.jersey * 31 + runKey * 7 + i * 101,
            tx + offset * W * 0.06,
            ty + Math.abs(offset) * H * 0.08,
            W,
          );
          const g = document.createElementNS(ns, "g");
          for (const cls of ["glow", "core"]) {
            const path = document.createElementNS(ns, "path");
            path.setAttribute("class", cls);
            path.setAttribute("d", d);
            g.appendChild(path);
          }
          svg.appendChild(g);
          const paths = [...g.querySelectorAll("path")];
          const len = paths[0].getTotalLength();
          gsap.set(paths, { strokeDasharray: len, strokeDashoffset: len });
          gsap.set(g, { autoAlpha: 0 });
          const at = 6.0 + i * 0.07;
          tl.set(g, { autoAlpha: 1 }, at)
            .to(paths, { strokeDashoffset: 0, duration: 0.13, ease: "none" }, at)
            .to(g, { autoAlpha: 0.2, duration: 0.05, repeat: 3, yoyo: true, ease: "steps(1)" }, at + 0.14)
            .to(g, { autoAlpha: 0, duration: 0.3 }, at + 0.45);
        });
      }
      tl.to(q(".mq-flicker"), { autoAlpha: 0.55, duration: 0.05, repeat: 5, yoyo: true, ease: "steps(1)" }, 6.0)
        .set(q(".mq-flicker"), { autoAlpha: 0 }, 6.4)
        .fromTo(q(".mq-card-inner"), { y: -5 }, { y: 0, duration: 0.4, ease: "elastic.out(1, 0.25)" }, 6.02)
        .fromTo(q(".mq-jersey"), { scale: 1.06 }, { scale: 1, duration: 0.5, ease: "power3.out" }, 6.02);

      q(".mq-spark").forEach((el, i) => {
        const angle = (i / 36) * Math.PI * 2 + Math.random() * 0.3;
        const dist = 120 + Math.random() * 260;
        tl.fromTo(
          el,
          { x: 0, y: 0, scale: 1, autoAlpha: 1 },
          {
            x: Math.cos(angle) * dist,
            y: Math.sin(angle) * dist + 80,
            scale: 0.2,
            autoAlpha: 0,
            duration: 0.9 + Math.random() * 0.5,
            ease: "power3.out",
          },
          6.05,
        );
      });

      // The name: first name up, then the surname letter by letter.
      tl.fromTo(q(".mq-first"), { y: 18, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.5 }, 6.5)
        .fromTo(
          q(".mq-last-char"),
          { yPercent: 105, autoAlpha: 0 },
          { yPercent: 0, autoAlpha: 1, duration: 0.7, ease: "expo.out", stagger: 0.05 },
          6.6,
        )
        .fromTo(q(".mq-last"), { scale: 1.05 }, { scale: 1, duration: 0.9, ease: "power2.out" }, 7.1);

      /* ---------------- out, to the bidding screen ---------------- */
      tl.to(q(".mq-card"), { scale: 0.97, autoAlpha: 0, duration: 0.55, ease: "power2.in" }, 8.6)
        .to(q(".mq-backdrop, .mq-stage"), { autoAlpha: 0, duration: 0.6, ease: "power2.in" }, 8.6);

      // Join late, in step with the room. Seeked with events on, so a reveal
      // joined after the strike still has its wicket broken.
      if (startAt > 0.05) tl.seek(Math.min(startAt, tl.duration()), false);
    }, scope);

    return () => {
      ctx.revert();
      tlRef.current = null;
      // Cut short (the lot left the block mid-reveal): stop drawing.
      stageRef.current?.setLive(false);
    };
    // startAt is read once, when a reveal begins; a later value must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, runKey, failed]);

  useEffect(() => {
    if (!player || !skippable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player, finish, skippable]);

  const p = player;
  return (
    <div
      ref={root}
      className="marquee"
      aria-hidden={!p}
      style={
        p
          ? ({ "--team": p.team.primary, "--team2": p.team.secondary } as CSSProperties)
          : undefined
      }
    >
      <div ref={host} className="mq-stage" aria-hidden />
      <div className="mq-backdrop" aria-hidden />

      {p && (
        <>
          <svg className="mq-bolts" aria-hidden />

          <section className="mq-card" aria-label={`${p.firstName} ${p.surname}, ${p.tagline}`}>
            <div className="mq-card-inner">
              <div className="mq-jersey" aria-hidden>
                <span>{p.jersey}</span>
                <div className="mq-sparks">
                  {Array.from({ length: 36 }, (_, i) => (
                    <i key={i} className="mq-spark" />
                  ))}
                </div>
              </div>

              <p className="mq-meta">
                <i aria-hidden /> {p.team.city} · {p.role}
              </p>

              <ul className="mq-stats">
                {p.stats.map((stat) => (
                  <li key={stat.label} className="mq-stat">
                    <b className="mq-stat-value">0</b>
                    <span>{stat.label}</span>
                  </li>
                ))}
              </ul>

              <p className="mq-tagline">{p.tagline}</p>

              <h2 className="mq-name">
                <span className="mq-first">{p.firstName}</span>
                <span className="mq-last" aria-label={p.surname}>
                  {p.surname.split("").map((ch, i) => (
                    <span key={i} className="mq-last-mask" aria-hidden>
                      <span className="mq-last-char">{ch}</span>
                    </span>
                  ))}
                </span>
              </h2>
            </div>
          </section>

          <div className="mq-flicker" aria-hidden />
          <div className="mq-flash" aria-hidden />
          {skippable && (
            <button type="button" className="mq-skip" onClick={finish}>
              Skip
            </button>
          )}
        </>
      )}
    </div>
  );
}
