/**
 * deliveryFilm.ts
 * The delivery opening's choreography: one GSAP timeline for the 3D scene
 * and the overlays together.
 *
 *   0.0  lights up; the camera low on the pitch, facing the far crease
 *   1.1  the ball is launched from it in a glint of light, at full pace,
 *        straight at the lens
 *   1.2  time all but stops; the camera goes 180° round the hanging ball
 *        until it looks down the pitch at the stumps: PRESENTING TO YOU
 *   4.2  the camera swings out to the side of the line, the ball still in frame
 *   4.7  time comes back up and the camera tracks with it: it pitches in a
 *        puff of clay and rises into the stumps; flash, shake, sparks
 *   5.8  the ball ricochets up on a parabola and the camera cranes up after
 *        it, until the ball climbs out through the top of the frame
 *   7.8  the camera settles high over the ground, the landing's own frame,
 *        and the landing takes over; the ball comes back down from where it
 *        left the frame onto the top of the trophy (see ballHandoff)
 *
 * **One clock for the ball.** The scene flies the ball from `state.clip`, the
 * ball's own seconds. The slow motion is a plan of time-scale ramps (`PLAN`),
 * and the ball's clock at any moment of the film is that plan integrated, in
 * closed form, so seeking anywhere, a skip included, lands on exactly the
 * ball position that playing through would have reached. The strike, the
 * freeze and the launch are found from the plan rather than guessed, so
 * retiming a ramp moves every beat that depends on it.
 */
import { createTimeline, stagger, utils } from "animejs";
import gsap from "gsap";
import * as THREE from "three";

import { DELIVERY, type IntroStage, type IntroState } from "./introScene";

/**
 * The landing's frame, the same one the strike opening settles on: high
 * behind the striker's end, across the ground to the far floodlights.
 */
export const LANDING: Pick<IntroState, "cam" | "look" | "fov"> = {
  cam: { x: 0, y: 15, z: 31 },
  look: { x: 0, y: 11, z: -42 },
  fov: 48,
};

/* ------------------------------------------------------------- the plan -- */

interface Key {
  t: number;
  /** Time scale at this key. */
  v: number;
  /** Ball clock at this key. */
  clip: number;
}

/** Time-scale keys, eased between with smoothstep, and their integral. */
function makePlan() {
  const keys: Key[] = [{ t: 0, v: 1, clip: DELIVERY.start }];
  const marks: Record<string, number> = {};
  const last = () => keys[keys.length - 1];
  const ramp = (to: number, dur: number) => {
    const k = last();
    keys.push({ t: k.t + dur, v: to, clip: k.clip + (dur * (k.v + to)) / 2 });
  };
  const hold = (dur: number) => {
    const k = last();
    keys.push({ t: k.t + dur, v: k.v, clip: k.clip + dur * k.v });
  };
  const until = (clip: number) => hold((clip - last().clip) / last().v);
  const mark = (name: string) => (marks[name] = last().t);

  until(DELIVERY.release); // the lights come up on the far crease
  until(DELIVERY.release + 0.2 * DELIVERY.flight); // launched, at full pace
  mark("brake");
  ramp(0.012, 0.25); // the ball hangs
  mark("hang");
  hold(3.2); // the camera goes round it; PRESENTING TO YOU
  mark("resume");
  // Not quite full pace into the stumps, so the bounce off the pitch reads.
  ramp(0.6, 0.12);
  until(DELIVERY.strike);
  mark("strike");
  ramp(0.1, 0.06); // the wicket goes in slow motion
  hold(0.75);
  ramp(1, 0.55);
  mark("climb");
  hold(4);

  /** Time scale and ball clock at film time `t`. */
  const sample = (t: number) => {
    let i = 0;
    while (i < keys.length - 2 && t >= keys[i + 1].t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const span = b.t - a.t;
    const u = THREE.MathUtils.clamp((t - a.t) / span, 0, 1);
    const s = u * u * (3 - 2 * u);
    const integral = u * u * u - (u * u * u * u) / 2; // of smoothstep, 0..u
    return {
      v: a.v + (b.v - a.v) * s,
      clip: a.clip + span * (a.v * u + (b.v - a.v) * integral) + (t > b.t ? (t - b.t) * b.v : 0),
    };
  };

  /** Film time at which the ball's clock reaches `clip`. */
  const timeAt = (clip: number) => {
    let lo = 0;
    let hi = last().t;
    for (let n = 0; n < 50; n++) {
      const mid = (lo + hi) / 2;
      if (sample(mid).clip < clip) lo = mid;
      else hi = mid;
    }
    return hi;
  };

  return { keys, marks, sample, timeAt, end: last().t };
}

export const PLAN = makePlan();

/** Beats, in film seconds. */
export const BEATS = {
  release: PLAN.timeAt(DELIVERY.release),
  brake: PLAN.marks.brake,
  hang: PLAN.marks.hang,
  resume: PLAN.marks.resume,
  strike: PLAN.marks.strike,
  climb: PLAN.marks.climb,
  /** The top of the ball's arc: far above the frame by now. */
  apex: PLAN.timeAt(DELIVERY.strike + DELIVERY.rise.vy / DELIVERY.rise.g),
};

// For scrubbing beats from the console while tuning.
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __beats?: unknown }).__beats = { ...BEATS, end: PLAN.end };

/* ---------------------------------------------------------- the caption -- */

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*";

/**
 * PRESENTING TO YOU, as a paused anime.js timeline the film seeks: each
 * letter decodes out of scrambled glyphs, rising into place and coming into
 * focus from the middle outwards; the rule draws out under it; at `outAt` (ms)
 * the letters lift away. Everything is a function of the seek time, the
 * scramble included, so scrubbing the film lands on the same frame as playing.
 */
function presentingCaption(el: FilmElements, outAt: number) {
  const chars = el.presentChars as HTMLElement[];
  const finals = chars.map((c) => c.textContent ?? "");
  const n = chars.length;
  const centre = (n - 1) / 2;
  const STEP = 42;
  const SCRAMBLE = 420;
  const start = chars.map((_, i) => Math.abs(i - centre) * STEP);
  utils.set(chars, { opacity: 0 });
  utils.set(el.presentRule, { scaleX: 0 });

  const at = createTimeline({ autoplay: false, defaults: { ease: "outExpo" } })
    .add(
      chars,
      {
        translateY: ["90%", "0%"],
        opacity: [0, 1],
        filter: ["blur(7px)", "blur(0px)"],
        duration: 760,
        delay: stagger(STEP, { from: "center" }),
      },
      0,
    )
    .add(el.present, { letterSpacing: ["0.62em", "0.38em"], duration: 1700 }, 0)
    .add(el.presentRule, { scaleX: [0, 1], duration: 950 }, 260)
    .add(
      chars,
      { translateY: "-70%", opacity: 0, filter: "blur(5px)", duration: 320, ease: "inQuad", delay: stagger(12, { from: "center" }) },
      outAt,
    )
    .add(el.presentRule, { scaleX: 0, opacity: 0, duration: 300, ease: "inQuad" }, outAt);
  at.seek(0);

  return {
    seek(ms: number) {
      at.seek(ms);
      chars.forEach((c, i) => {
        const real = finals[i];
        const local = ms - start[i];
        let shown = real;
        if (real.trim() && local >= 0 && local < SCRAMBLE) {
          // A new glyph every 45ms, the same ones every time.
          const k = Math.floor(local / 45);
          shown = GLYPHS[(i * 7 + k * 13 + (k * k) % 11) % GLYPHS.length];
        }
        if (c.textContent !== shown) c.textContent = shown;
      });
    },
  };
}

/* ------------------------------------------------------------- the film -- */

export interface FilmElements {
  fade: Element[];
  flash: Element[];
  bars: Element[];
  vignette: Element[];
  present: Element[];
  presentChars: Element[];
  presentRule: Element[];
}

/** Put the scene in the landing's frame: no film, no ball. */
export function settleDelivery(stage: IntroStage) {
  const s = stage.state;
  Object.assign(s.cam, LANDING.cam);
  Object.assign(s.look, LANDING.look);
  s.camFrom.ball = 0;
  s.lookFrom.ball = 0;
  s.fov = LANDING.fov;
  s.exposure = 1.12;
  s.clip = DELIVERY.start;
  s.timeScale = 1;
  s.ballOn = 0;
}

/**
 * Lay the delivery opening onto `tl` and return when to hand over to the
 * landing (film seconds).
 */
export function buildDeliveryFilm(tl: gsap.core.Timeline, stage: IntroStage, el: FilmElements) {
  const s = stage.state;
  // Sparks in gold and white; the LED bails keep their red.
  stage.setTeamColors("#ffb347", "#fff1c9", "#ff1e1e", 0.38);

  // Opening frame, set on the timeline so a replay starts from it too.
  tl.set(s, { exposure: 0, timeScale: 1, drift: 0, shake: 0, fov: 30, ballOn: 1, glint: 0, delivery: -1 }, 0)
    .set(s.camFrom, { ball: 0 }, 0)
    .set(s.lookFrom, { ball: 0 }, 0)
    .set(s.cam, { x: 1.3, y: 1.02, z: -6.0 }, 0)
    .set(s.look, { x: 0.3, y: 1.5, z: -18.7 }, 0)
    .set(el.bars, { scaleY: 1 }, 0)
    .set([...el.vignette, ...el.present], { autoAlpha: 0 }, 0);

  // The ball's clock and the slow motion: one tween across the whole film,
  // ending as the camera comes to rest, so the timeline's own end is the
  // moment the landing can take the ball.
  const filmEnd = BEATS.strike + 3.05;
  const clock = { t: 0 };
  tl.fromTo(
    clock,
    { t: 0 },
    {
      t: filmEnd,
      duration: filmEnd,
      ease: "none",
      immediateRender: true,
      onUpdate: () => {
        const at = PLAN.sample(clock.t);
        s.clip = at.clip;
        s.timeScale = at.v;
      },
    },
    0,
  );

  // Lights up from black.
  tl.to(s, { exposure: 1.12, duration: 1.0, ease: "power2.out" }, 0).fromTo(
    el.fade,
    { autoAlpha: 1 },
    { autoAlpha: 0, duration: 0.9, ease: "power1.out" },
    0,
  );

  /* Shot 1: low on the pitch, facing the far crease, easing in. The ball is
     launched from it in a glint of light and comes straight at the lens. */
  tl.to(s.cam, { x: 1.15, y: 0.98, z: -6.9, duration: BEATS.brake, ease: "sine.inOut" }, 0)
    .fromTo(s, { glint: 0 }, { glint: 1, duration: 0.07, ease: "power2.out", immediateRender: false }, BEATS.release - 0.04)
    .to(s, { glint: 0, duration: 0.32, ease: "power2.in" }, BEATS.release + 0.05);

  /* Shot 2: time all but stops, and the camera goes 180° round the hanging
     ball: from in front of it, the far crease behind it, round to behind
     it, looking down the pitch at the stumps it is going to hit. */
  const meet = BEATS.brake;
  const met = meet + 0.4;
  tl.to(s.camFrom, { ball: 1, duration: met - meet, ease: "power2.inOut" }, meet)
    .to(s.cam, { x: 0.55, y: 0.12, z: 1.75, duration: met - meet, ease: "power2.inOut" }, meet)
    .to(s.lookFrom, { ball: 1, duration: met - meet, ease: "power2.inOut" }, meet)
    .to(s.look, { x: 0, y: 0.02, z: 0, duration: met - meet, ease: "power2.inOut" }, meet);
  const orbit = { a: 0, r: 1.75, h: 0.12, lat: 0.55 };
  const placeOrbit = () => {
    s.cam.x = orbit.lat + Math.sin(orbit.a) * orbit.r;
    s.cam.z = Math.cos(orbit.a) * orbit.r;
    s.cam.y = orbit.h;
  };
  const orbitEnd = met + 1.75;
  tl.fromTo(
    orbit,
    { a: 0, r: 1.75, h: 0.12, lat: 0.55 },
    {
      a: -Math.PI * 0.86,
      r: 1.36,
      h: -0.06,
      lat: 0,
      duration: orbitEnd - met,
      ease: "sine.inOut",
      onUpdate: placeOrbit,
      immediateRender: false,
    },
    met,
  )
    // Coming round, the aim leads off the ball towards the stumps, so the
    // ball settles in the upper left with the wicket beyond it.
    .to(s.look, { x: 0.3, y: -0.14, z: 2.85, duration: 0.85, ease: "sine.inOut" }, orbitEnd - 0.45)
    .to(s, { fov: 29, duration: orbitEnd - meet, ease: "sine.inOut" }, meet)
    .fromTo(el.vignette, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5, ease: "power2.out" }, meet + 0.1)
    .to(el.vignette, { autoAlpha: 0, duration: 0.3, ease: "power2.in" }, BEATS.resume);
  // A last slow drift while the words are up, so the frame never freezes.
  tl.to(s.cam, { x: -0.52, z: -1.28, duration: BEATS.resume - 0.02 - orbitEnd, ease: "sine.inOut" }, orbitEnd);

  const hang = orbitEnd - 0.2;

  // PRESENTING TO YOU, while the ball hangs: an anime.js timeline, decoded
  // out of scrambled glyphs from the middle outwards, seeked by this one.
  const caption = presentingCaption(el, (BEATS.resume - 0.3 - hang) * 1000);
  const words = { t: 0 };
  const captionSpan = BEATS.resume + 0.1 - hang;
  tl.set(el.present, { autoAlpha: 1 }, hang)
    .fromTo(
      words,
      { t: 0 },
      { t: captionSpan, duration: captionSpan, ease: "none", immediateRender: false, onUpdate: () => caption.seek(words.t * 1000) },
      hang,
    )
    .set(el.present, { autoAlpha: 0 }, BEATS.resume + 0.1);

  /* Shot 5: off the ball and out to the side of the line, low, the ball
     still hanging in frame. Time comes back up and the camera tracks along
     with it, so it is seen to drop onto the pitch in a puff of clay, kick up
     off it and go into the stumps as they come into frame. */
  const out = BEATS.resume - 0.55;
  tl.to(s.camFrom, { ball: 0, duration: 0.55, ease: "power2.inOut" }, out)
    .to(s.cam, { x: -4.2, y: 0.62, z: -8.0, duration: 0.55, ease: "power2.inOut" }, out)
    .to(s.lookFrom, { ball: 0, duration: 0.55, ease: "power2.inOut" }, out)
    .to(s.look, { x: 0, y: 0.45, z: -7.9, duration: 0.55, ease: "power2.inOut" }, out)
    .to(s, { fov: 40, duration: 0.55, ease: "power2.inOut" }, out);
  const into = BEATS.strike - BEATS.resume;
  tl.to(s.cam, { x: -2.8, y: 0.52, z: -1.5, duration: into, ease: "power1.in" }, BEATS.resume)
    .to(s.look, { x: 0, y: 0.38, z: -0.6, duration: into, ease: "power1.in" }, BEATS.resume)
    .to(s, { fov: 36, duration: into, ease: "power1.in" }, BEATS.resume);

  // The strike.
  tl.call(() => stage.strike(), undefined, BEATS.strike)
    .fromTo(s, { shake: 1 }, { shake: 0, duration: 0.9, immediateRender: false }, BEATS.strike)
    .fromTo(el.flash, { autoAlpha: 0.14 }, { autoAlpha: 0, duration: 0.35, ease: "power2.out", immediateRender: false }, BEATS.strike);

  /* Shot 6: in slow motion at the broken wicket. The ball pops up out of
     the top of frame; the camera, still on the wicket, starts to ease back
     the way the crane will take it. */
  const pull = BEATS.strike + 0.62;
  tl.to(s.cam, { x: -3.1, y: 0.75, z: -0.9, duration: pull - BEATS.strike - 0.02, ease: "power1.in" }, BEATS.strike + 0.02);

  /* Shot 7: the crane. The ball ricochets back up the pitch; the camera
     rises and pulls back behind the wicket, following it up its arc with
     the far stands and floodlights beneath it, then comes down onto the
     landing's own frame and lets the ball climb on out through the top. */
  const lift = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-3.1, 0.75, -0.9),
      new THREE.Vector3(-5, 3.2, 8),
      new THREE.Vector3(-3, 9, 22),
      new THREE.Vector3(LANDING.cam.x, LANDING.cam.y, LANDING.cam.z),
    ],
    false,
    "centripetal",
  );
  const craneEnd = filmEnd - 0.05;
  const rise = { k: 0 };
  const at = new THREE.Vector3();
  tl.fromTo(
    rise,
    { k: 0 },
    {
      k: 1,
      duration: craneEnd - pull,
      // Away fast while the ball is low and near, so the climb is always seen
      // from far enough back to keep the stands in frame; then a long ease
      // into the landing's frame.
      ease: "power2.out",
      immediateRender: false,
      onUpdate: () => {
        lift.getPoint(rise.k, at);
        s.cam.x = at.x;
        s.cam.y = at.y;
        s.cam.z = at.z;
      },
    },
    pull,
  )
    .to(s, { fov: LANDING.fov, duration: craneEnd - pull, ease: "power2.inOut" }, pull)
    // Up after the ball once the wicket has had its moment, but only part of
    // the way: the aim sits between the ball and the far end, so the stands
    // and the floodlights stay along the bottom of the frame as it climbs.
    .to(s.lookFrom, { ball: 0.72, duration: 0.8, ease: "power2.inOut" }, pull - 0.1)
    .to(s.look, { x: 0, y: 3.9, z: -16.8, duration: 0.8, ease: "power2.inOut" }, pull - 0.1)
    // Then off the ball and down onto the far end; the ball, still climbing,
    // goes out through the top of the frame.
    .to(s.lookFrom, { ball: 0, duration: craneEnd - BEATS.strike - 1.55, ease: "power2.inOut" }, BEATS.strike + 1.55)
    .to(s.look, { ...LANDING.look, duration: craneEnd - BEATS.strike - 1.55, ease: "power2.inOut" }, BEATS.strike + 1.55)
    .fromTo(el.bars, { scaleY: 1 }, { scaleY: 0, duration: 0.8, ease: "power3.inOut", immediateRender: false }, craneEnd - 0.95)
    // Long gone above the frame by the top of its arc: take it out of the
    // sky before it could fall back into the frozen landing.
    .set(s, { ballOn: 0 }, Math.min(BEATS.apex, craneEnd));

  // Hand over to the landing while the camera is still settling.
  return { handoff: craneEnd - 0.55, end: craneEnd };
}
