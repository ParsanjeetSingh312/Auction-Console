/**
 * StadiumIntro.tsx
 * The opening: a black screen and one button, then a white ball at full pace,
 * the stumps cartwheeling, the LED bails flashing red — then the camera
 * cranes out over a floodlit ground and the AUCTONIQ wordmark and trophy land
 * in the middle of it.
 *
 * One GSAP timeline drives everything, the 3D scene included. `introScene`
 * exposes a plain state object (camera, slow-motion factor, the ball's
 * progress down the pitch, exposure) and this timeline tweens it exactly as it
 * tweens the DOM, so the strike, the flash, the letterbox and the wordmark are
 * all timed against one clock and can never drift apart.
 *
 * The beats, in seconds after "Enter the auction" is pressed:
 *
 *   0.00  lights come up from black, the camera creeps in low behind the wicket
 *   0.55  the ball is released; 0.7s later it is in the stumps
 *   1.25  strike — flash, shake, slow motion, the camera swings round the wicket
 *   2.55  time comes back up to speed and the pieces fall
 *   2.80  the camera cranes up and out over the ground; the letterbox opens
 *   4.25  the wordmark, then the trophy, then the tagline
 *   ~7.0  settled
 *
 * Three ways to show it:
 *
 * - **The full opening** (default): gate, film, mark.
 * - **`instant`**: no gate and no film — the settled stadium straight away.
 *   For a visitor who has already seen the opening this session.
 * - **`backdrop`**: the mark and every control fade away and the stadium
 *   freezes into a still, so the landing can sit on top of it. A frozen stage
 *   draws nothing per frame, which is what keeps a scrolling page smooth over
 *   it.
 *
 * Reduced motion skips the film: pressing Enter reveals the settled frame.
 */
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import gsap from "gsap";

import { AuctiqMark } from "../Global/AuctiqLogo";
import { useQuality } from "../3D/rig/quality";
import IntroGate from "./IntroGate";
import { ballHandoff } from "./ballHandoff";
import { buildDeliveryFilm, settleDelivery } from "./deliveryFilm";
import { createIntroStage, type IntroStage, type IntroState } from "./introScene";
import "./stadiumIntro.css";

const AuctoniqTrophy = lazy(() => import("../3D/AuctoniqTrophy"));

const WORD = "AUCTONIQ".split("");
const PRESENT = "Presenting to you".split("");

/**
 * The settled frame: high behind the striker's end, looking across the ground
 * with the far floodlight towers in shot.
 */
const WIDE: Pick<IntroState, "cam" | "look" | "fov"> = {
  cam: { x: 0, y: 15, z: 31 },
  look: { x: 0, y: 11, z: -42 },
  fov: 48,
};

/** The opening shot: low, behind and to the off side of the striker's wicket. */
const OPEN = {
  from: { cam: { x: 2.0, y: 0.7, z: 4.4 }, look: { x: -1.4, y: 0.42, z: -6 } },
  to: { cam: { x: 1.2, y: 0.55, z: 3.2 }, look: { x: -0.9, y: 0.42, z: -5 } },
};

export interface StadiumIntroProps {
  /** Fired once the mark has fully landed (or at once, with `instant`). */
  onComplete?: () => void;
  /**
   * What "Skip" does. Left out, it jumps the opening to its settled frame.
   */
  onSkip?: () => void;
  /** Shows a Replay control once the opening has finished. For the lab. */
  replayable?: boolean;
  /** Skip the gate and the film and show the settled stadium straight away. */
  instant?: boolean;
  /** Hide the mark and controls and freeze the stadium behind the landing. */
  backdrop?: boolean;
  /**
   * Land the wordmark and trophy at the end of the film. Off on the landing,
   * which has its own: there the film runs from the strike straight into the
   * site, and `onComplete` fires part-way through the crane so the landing
   * is already fading in as the camera settles.
   */
  mark?: boolean;
  /** Actions shown under the tagline once the mark has landed. */
  children?: ReactNode;
  className?: string;
  /**
   * "strike" (the default): the ball arrives at the wicket from off screen.
   * "delivery": the ball is launched from the far crease in a glint, hangs
   * in the air under PRESENTING TO YOU while the camera goes round it,
   * breaks the wicket, climbs out of sight, and —
   * once the landing is up — falls back out of the sky onto the trophy
   * (see ballHandoff). The delivery opening always runs into the site: it
   * lands no mark of its own.
   */
  opening?: "strike" | "delivery";
}

export default function StadiumIntro({
  onComplete,
  onSkip,
  replayable = false,
  instant = false,
  backdrop = false,
  mark: withMark = true,
  children,
  className = "",
  opening = "strike",
}: StadiumIntroProps) {
  const delivery = opening === "delivery";
  const quality = useQuality();
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const gateRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<IntroStage | null>(null);
  const tlRef = useRef<gsap.core.Timeline | null>(null);
  /** Starts the opening; set by the effect once the scene exists. */
  const enterRef = useRef<(() => void) | null>(null);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;
  /** The visitor skipped: the ball goes straight into the cradle. */
  const skippedRef = useRef(false);

  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  /** The scene is built and ready to play. */
  const [armed, setArmed] = useState(false);
  /** The visitor has pressed Enter and the black gate has gone. */
  const [entered, setEntered] = useState(instant);

  const reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The delivery opening owes the landing a ball: hold the hero's wordmark
  // and the trophy's ball back until it arrives. Laid out before the page
  // paints, so neither is ever seen and then taken away.
  useLayoutEffect(() => {
    // Reduced motion gets the settled landing straight away: nothing held.
    if (!delivery || instant || reduced) return;
    ballHandoff.setPhase("awaiting");
    return () => ballHandoff.setPhase("idle");
  }, [delivery, instant, reduced]);

  // Build the scene, then the timeline against it.
  useLayoutEffect(() => {
    const el = host.current;
    const scope = root.current;
    if (!el || !scope) return;

    let stage: IntroStage | null = null;
    let cancelled = false;
    let readyResolve: () => void = () => {};
    const ready = new Promise<void>((r) => (readyResolve = r));

    try {
      stage = createIntroStage(el, { tier: quality.tier, onReady: () => readyResolve(), opening });
      stageRef.current = stage;
    } catch (error) {
      console.warn("[StadiumIntro] WebGL unavailable, showing the mark alone.", error);
      setFailed(true);
      readyResolve();
    }

    const ctx = gsap.context(() => {
      const q = gsap.utils.selector(scope);
      const letters = q(".intro-letter");
      const word = q(".intro-word");
      const trophy = q(".intro-trophy");
      const tagline = q(".intro-tagline");
      const actions = q(".intro-actions");
      const bars = q(".intro-bar");
      const flash = q(".intro-flash");
      const fade = q(".intro-fade");
      const scrim = q(".intro-scrim");
      const skip = q(".intro-skip");
      const mark = [...letters, ...trophy, ...tagline, ...actions];

      const settle = () => {
        if (!stage) return;
        if (delivery) {
          settleDelivery(stage);
          return;
        }
        Object.assign(stage.state.cam, WIDE.cam);
        Object.assign(stage.state.look, WIDE.look);
        stage.state.fov = WIDE.fov;
        stage.state.exposure = 1.12;
        stage.state.delivery = -1;
      };

      // Returning visitor: the settled stadium, no gate, no film, no mark.
      if (instant) {
        settle();
        gsap.set(bars, { scaleY: 0 });
        gsap.set([...fade, ...flash, ...skip, ...mark], { autoAlpha: 0 });
        gsap.set(scrim, { autoAlpha: 1 });
        ready.then(() => {
          if (cancelled) return;
          setDone(true);
          completeRef.current?.();
        });
        return;
      }

      // Reduced motion, or no WebGL: Enter reveals the settled frame.
      if (reduced || !stage) {
        settle();
        gsap.set(bars, { scaleY: 0 });
        gsap.set([...fade, ...flash, ...skip], { autoAlpha: 0 });
        gsap.set(scrim, { autoAlpha: 1 });
        if (!reduced || !withMark) gsap.set(mark, { autoAlpha: 0, y: 24 });
        enterRef.current = () => {
          if (!reduced && withMark) gsap.to(mark, { autoAlpha: 1, y: 0, duration: 0.9, ease: "expo.out", stagger: 0.06 });
          setDone(true);
          completeRef.current?.();
        };
        setArmed(true);
        return;
      }

      const s = stage.state;
      const st = stage;
      const tl = gsap.timeline({
        paused: true,
        defaults: { ease: "power2.out" },
        onComplete: () => {
          setDone(true);
          if (withMark && !delivery) completeRef.current?.();
        },
      });
      tlRef.current = tl;
      enterRef.current = () => tl.play(0);
      // A handle for scrubbing beats from the console while tuning.
      if (import.meta.env.DEV) (window as unknown as { __intro?: unknown }).__intro = { tl, stage: st };

      if (delivery) {
        const film = buildDeliveryFilm(tl, st, {
          fade,
          flash,
          bars,
          vignette: q(".intro-vignette"),
          present: q(".intro-present"),
          presentChars: q(".intro-present-char"),
          presentRule: q(".intro-present-rule"),
        });
        gsap.set(mark, { autoAlpha: 0 });
        gsap.set(scrim, { autoAlpha: 0 });
        // A call rather than the timeline's end, so a skip still fires it.
        tl.call(() => completeRef.current?.(), undefined, film.handoff);
        const fonts = document.fonts?.ready ?? Promise.resolve();
        Promise.all([ready, Promise.race([fonts, new Promise((r) => setTimeout(r, 1200))])]).then(() => {
          if (!cancelled) setArmed(true);
        });
        return;
      }

      // Opening frame. Set on the timeline so a replay starts from it too.
      const orbit = {
        a: Math.atan2(OPEN.to.cam.x, OPEN.to.cam.z),
        r: Math.hypot(OPEN.to.cam.x, OPEN.to.cam.z),
        h: OPEN.to.cam.y,
      };
      tl.set(s, { exposure: 0, delivery: -1, timeScale: 1, drift: 0, shake: 0, fov: 32 }, 0)
        .set(s.cam, OPEN.from.cam, 0)
        .set(s.look, OPEN.from.look, 0);

      // Lights up, camera creeping in low behind the wicket.
      tl.to(s, { exposure: 1.12, duration: 1.1 }, 0)
        .fromTo(fade, { autoAlpha: 1 }, { autoAlpha: 0, duration: 0.9, ease: "power1.out" }, 0)
        .to(s.cam, { ...OPEN.to.cam, duration: 1.3, ease: "power1.inOut" }, 0)
        .to(s.look, { ...OPEN.to.look, duration: 1.3, ease: "power1.inOut" }, 0);

      // The delivery: linear, because a ball in flight does not ease.
      tl.set(s, { delivery: 0 }, 0.55).to(s, { delivery: 1, duration: 0.7, ease: "none" }, 0.55);

      // Strike.
      tl.call(() => st.strike(), undefined, 1.25)
        .to(s, { timeScale: 0.06, duration: 0.12 }, 1.25)
        .fromTo(s, { shake: 1 }, { shake: 0, duration: 0.8, immediateRender: false }, 1.25)
        .fromTo(flash, { autoAlpha: 0.5 }, { autoAlpha: 0, duration: 0.45, immediateRender: false }, 1.25);

      // Bullet time: swing round the wicket while the pieces hang in the air.
      tl.to(
        orbit,
        {
          a: -0.75,
          r: 2.7,
          h: 1.05,
          duration: 1.5,
          ease: "sine.inOut",
          onUpdate: () => {
            s.cam.x = Math.sin(orbit.a) * orbit.r;
            s.cam.z = Math.cos(orbit.a) * orbit.r;
            s.cam.y = orbit.h;
          },
        },
        1.27,
      ).to(s.look, { x: 0, y: 0.42, z: 0.35, duration: 1.5, ease: "sine.inOut" }, 1.27);

      tl.to(s, { timeScale: 1, duration: 0.7, ease: "power2.in" }, 2.55);

      // The crane out over the ground.
      tl.to(s.cam, { ...WIDE.cam, duration: 2.0, ease: "expo.inOut" }, 2.8)
        .to(s.look, { ...WIDE.look, duration: 2.0, ease: "expo.inOut" }, 2.8)
        .to(s, { fov: WIDE.fov, duration: 2.0, ease: "expo.inOut" }, 2.8)
        .fromTo(bars, { scaleY: 1 }, { scaleY: 0, duration: 0.8, ease: "power3.inOut" }, 3.3);

      if (!withMark) {
        // Straight into the site: the landing starts arriving while the crane
        // is still easing out, so there is no held frame between the two.
        // A call rather than the timeline's own end, so skipping past it with
        // a seek still fires it.
        gsap.set(mark, { autoAlpha: 0 });
        tl.call(() => completeRef.current?.(), undefined, 4.05);
        // Arm the gate as below.
        const fonts = document.fonts?.ready ?? Promise.resolve();
        Promise.all([ready, Promise.race([fonts, new Promise((r) => setTimeout(r, 1200))])]).then(() => {
          if (!cancelled) setArmed(true);
        });
        return;
      }

      tl.fromTo(scrim, { autoAlpha: 0 }, { autoAlpha: 1, duration: 1.1, ease: "power1.inOut" }, 3.9).to(
        s,
        { drift: 1, duration: 2.5, ease: "sine.in" },
        4.6,
      );

      // The mark.
      tl.fromTo(
        letters,
        { yPercent: 105, rotateX: -80, autoAlpha: 0 },
        { yPercent: 0, rotateX: 0, autoAlpha: 1, duration: 1.0, ease: "expo.out", stagger: 0.05 },
        4.25,
      )
        .fromTo(word, { letterSpacing: "0.42em" }, { letterSpacing: "0.06em", duration: 1.4, ease: "expo.out" }, 4.25)
        // Rise and fade only, never scale: the trophy sizes its canvas from its
        // box's on-screen rectangle, so a scale tween would leave it rendering
        // at the shrunken size it measured mid-tween.
        .fromTo(trophy, { y: 120, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 1.5, ease: "expo.out" }, 4.45)
        .fromTo(tagline, { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.8 }, 5.2)
        .fromTo(actions, { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.8 }, 5.45)
        .to(skip, { autoAlpha: 0, duration: 0.3 }, 5.45);

      // Arm the gate once the first frame is on screen and the display face
      // has loaded, so the wordmark never swaps fonts mid-flight. Capped, so a
      // slow font never holds the opening hostage.
      const fonts = document.fonts?.ready ?? Promise.resolve();
      Promise.all([ready, Promise.race([fonts, new Promise((r) => setTimeout(r, 1200))])]).then(() => {
        if (!cancelled) setArmed(true);
      });
    }, scope);

    return () => {
      cancelled = true;
      ctx.revert();
      tlRef.current = null;
      enterRef.current = null;
      stage?.dispose();
      stageRef.current = null;
    };
  }, [quality.tier, reduced, instant, withMark, delivery, opening]);

  // Handing over to the landing: the mark and controls go, the stadium stills.
  useEffect(() => {
    if (!backdrop || !root.current) return;
    const q = gsap.utils.selector(root.current);
    const timers: gsap.core.Tween[] = [];
    const freeze = () => stageRef.current?.setLive(false);

    // The delivery opening's last beat: its ball, gone at the top of its
    // climb, comes back down out of the sky onto the top of the trophy.
    const land = (instant: boolean) => {
      ballHandoff.socket()?.receive({ instant });
      ballHandoff.setPhase("landed");
      timers.push(gsap.delayedCall(0.1, freeze));
    };
    const dropIntoTrophy = () => {
      const stage = stageRef.current;
      if (!stage || skippedRef.current || reduced || !ballHandoff.holding()) return land(true);
      let waited = 0;
      // The trophy's chunk and first frame may still be on their way; give
      // them a moment, never forever.
      const attempt = () => {
        const socket = ballHandoff.socket();
        if (socket && socket.locate()) {
          ballHandoff.setPhase("falling");
          stage.dropBall({
            locate: () => ballHandoff.socket()?.locate() ?? null,
            onArrive: () => land(false),
          });
          return;
        }
        waited += 0.1;
        if (waited > 3) return land(true);
        timers.push(gsap.delayedCall(0.1, attempt));
      };
      attempt();
    };

    const tween = gsap.to(q(".intro-mark, .intro-skip, .intro-bar"), {
      autoAlpha: 0,
      duration: 0.6,
      ease: "power2.inOut",
      // Freeze once the camera has actually come to rest: on the landing the
      // handoff begins while the crane is still finishing.
      onComplete: () => {
        const tl = tlRef.current;
        const left = tl && tl.isActive() ? tl.duration() - tl.time() : 0;
        timers.push(gsap.delayedCall(left + 0.05, delivery && !instant ? dropIntoTrophy : freeze));
      },
    });
    gsap.to(q(".intro-site-scrim"), { autoAlpha: 1, duration: 0.8, ease: "power1.inOut" });
    return () => {
      tween.kill();
      timers.forEach((t) => t.kill());
    };
  }, [backdrop, delivery, instant, reduced]);

  const enter = useCallback(() => {
    if (!armed || entered) return;
    setEntered(true);
    // The opening starts on the press; the gate dissolves into its first,
    // still-black frame, so there is no seam between the two.
    enterRef.current?.();
    gsap.to(gateRef.current, { autoAlpha: 0, duration: 0.45, ease: "power2.inOut" });
  }, [armed, entered]);

  const finish = useCallback(() => {
    const tl = tlRef.current;
    if (!tl) return;
    // Seek with events on, so the strike fires even when it is skipped past.
    tl.seek(tl.duration(), false);
  }, []);

  const skip = useCallback(() => {
    skippedRef.current = true;
    if (onSkip) onSkip();
    else finish();
  }, [onSkip, finish]);

  const replay = useCallback(() => {
    const tl = tlRef.current;
    if (!tl || !stageRef.current) return;
    stageRef.current.reset();
    stageRef.current.setLive(true);
    setDone(false);
    tl.restart();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && entered && !done && !backdrop) skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [skip, entered, done, backdrop]);

  return (
    <section
      ref={root}
      aria-label={backdrop ? undefined : "AUCTONIQ opening"}
      aria-hidden={backdrop || undefined}
      className={`stadium-intro relative h-[100svh] w-full overflow-hidden bg-[#02040b] ${className}`}
    >
      <div ref={host} className="absolute inset-0" aria-hidden />

      {/* Pulls the ground down behind the mark so the wordmark always reads. */}
      <div className="intro-scrim pointer-events-none absolute inset-0 opacity-0" aria-hidden />
      {/* Heavier, for the landing's dense content once it sits on the stadium. */}
      <div className="intro-site-scrim pointer-events-none absolute inset-0 opacity-0" aria-hidden />
      {delivery && (
        <>
          {/* Time stops: the edges of the frame fall away round the ball. */}
          <div className="intro-vignette pointer-events-none absolute inset-0 opacity-0" aria-hidden />
          <div className="intro-present pointer-events-none absolute inset-x-0 opacity-0" aria-hidden>
            <p className="intro-present-line">
              {PRESENT.map((ch, i) => (
                <span key={i} className="intro-present-char">
                  {ch === " " ? "\u00a0" : ch}
                </span>
              ))}
            </p>
            <span className="intro-present-rule" />
          </div>
        </>
      )}
      <div className="intro-flash pointer-events-none absolute inset-0 bg-white opacity-0" aria-hidden />
      <div className="intro-bar intro-bar--top pointer-events-none absolute inset-x-0 top-0 bg-black" aria-hidden />
      <div className="intro-bar intro-bar--bottom pointer-events-none absolute inset-x-0 bottom-0 bg-black" aria-hidden />
      <div className="intro-fade pointer-events-none absolute inset-0 bg-[#02040b]" aria-hidden />

      <div className="intro-mark pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-4">
        <h1
          aria-label="AUCTONIQ"
          className="intro-word font-auctiq text-[clamp(3rem,11vw,8.5rem)] uppercase leading-none tracking-[0.06em] text-neon-orange text-glow-orange"
        >
          {WORD.map((ch, i) => (
            <span key={i} aria-hidden className="intro-letter inline-block">
              {ch}
            </span>
          ))}
        </h1>

        <div className="intro-trophy pointer-events-auto w-full">
          {!instant && withMark && (
            <Suspense fallback={<TrophyFallback />}>
              <AuctoniqTrophy className="trophy-stage--intro" fallback={<TrophyFallback />} />
            </Suspense>
          )}
        </div>

        <p className="intro-tagline -mt-2 text-center font-tech text-[clamp(0.75rem,1.6vw,1rem)] font-medium uppercase tracking-[0.34em] text-neon-cyan">
          Where intelligence meets patience
        </p>

        <div className="intro-actions pointer-events-auto mt-6 flex flex-wrap items-center justify-center gap-3">
          {children}
          {replayable && done && (
            <button type="button" onClick={replay} className="intro-button intro-button--quiet">
              Replay
            </button>
          )}
        </div>
      </div>

      {!failed && !reduced && entered && !instant && !done && (
        <button type="button" onClick={skip} className="intro-skip intro-button intro-button--quiet absolute right-5 top-5 z-10">
          Skip intro
        </button>
      )}

      {/*
        The gate: a black introduction card and one button. The opening plays
        on the press, never on page load, so nobody is ambushed by it and the
        strike always lands on someone who is watching.
      */}
      {!instant && (
        <div ref={gateRef} className="intro-gate absolute inset-0 z-20">
          <IntroGate armed={armed} onEnter={enter} />
        </div>
      )}
    </section>
  );
}

function TrophyFallback() {
  return (
    <div className="grid h-[clamp(220px,40vh,460px)] w-full place-items-center">
      <AuctiqMark className="h-24 w-24 opacity-80" />
    </div>
  );
}
