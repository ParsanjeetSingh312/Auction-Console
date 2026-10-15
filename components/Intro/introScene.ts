/**
 * introScene.ts
 * The opening's stadium, ball and wicket, drawn entirely in three.js.
 *
 * No photograph and no model files: the outfield, the pitch, the stands, the
 * crowd and the floodlight towers are all built here from primitives and
 * canvas textures, so the whole opening is one small chunk with nothing to
 * fetch and nothing to license.
 *
 * The module is deliberately animation-agnostic. It owns the scene and the
 * render loop and exposes a plain `state` object; `StadiumIntro` drives that
 * object from one GSAP timeline. Keeping the choreography out of here means
 * retiming a beat is an edit to a timeline, not to a render loop.
 *
 * World units are metres. The striker's stumps sit at the origin and the
 * pitch runs away from them down -z, so the ground's centre is at
 * z = -PITCH_LENGTH / 2.
 *
 * **On colour.** The brief is specific: the floodlights carry a small blue
 * reflection and the ground keeps its own colours. So the blue lives only in
 * things that are light rather than surface — the halo round each lamp bank,
 * the faint beam under it, the haze on the horizon — and every light that
 * actually falls on the grass is a neutral, slightly warm white. Tinting the
 * key lights blue would have turned the outfield teal.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

import { createMatchBall, createWoodenWicket } from "./cricketGear";
import { createStadiumDetail, standTexture } from "./stadiumDetail";
import { createStrikeSparks } from "./strikeSparks";


export type IntroTier = 1 | 2 | 3;

/* ---------------------------------------------------------------- layout -- */

const PITCH_LENGTH = 20.12;
const PITCH_WIDTH = 3.05;
const PITCH_Z = -PITCH_LENGTH / 2;
const FIELD_RADIUS = 66;
const STAND_INNER = 71;
const TOWER_RADIUS = 118;
const MAST_HEIGHT = 62;

const STUMP_HEIGHT = 0.711;
const STUMP_RADIUS = 0.0175;
/** Centre to centre. The wicket is 22.86cm across its outer edges. */
const STUMP_SPACING = 0.0968;
const BALL_RADIUS = 0.036;

/** The delivery: released over the wicket, pitching short of a length. */
const RELEASE = new THREE.Vector3(0.42, 2.15, -18.7);
const BOUNCE = new THREE.Vector3(0.12, BALL_RADIUS, -4.3);
const IMPACT = new THREE.Vector3(0.0, 0.41, -(STUMP_RADIUS + BALL_RADIUS));
/** Share of the delivery's time spent before it pitches. */
const BOUNCE_AT = 0.76;

/**
 * The delivery opening's clock, in seconds of the ball's own time: the film
 * starts at `start`, the ball leaves the bowler's crease at `release` (zero),
 * is in the stumps `flight` later, and after the strike ricochets off them and
 * climbs back up the pitch on a parabola, high over the bowler's end and out
 * through the top of the frame. The rise is cinema, not physics: launched hard
 * under a heavy gravity so the climb fits in a couple of seconds.
 */
export const DELIVERY = {
  start: -1.1,
  release: 0,
  flight: 0.55,
  get strike() {
    return this.release + this.flight;
  },
  rise: { vx: -1.0, vy: 64.7, vz: -14.1, g: 38.1 },
} as const;

/** Six towers, at the corners of a hexagon turned so none stands dead behind the bowler's end. */
const TOWER_ANGLES = [30, 90, 150, 210, 270, 330].map((d) => THREE.MathUtils.degToRad(d));

/* ----------------------------------------------------------------- state -- */

export interface IntroState {
  /** Camera position and the point it looks at. Tweened by the timeline. */
  cam: { x: number; y: number; z: number };
  look: { x: number; y: number; z: number };
  fov: number;
  /** 0..1 camera shake, decays from the strike. */
  shake: number;
  /** 0..1 slow orbit of the whole ground once the opening has settled. */
  drift: number;
  /** Physics time multiplier: 1 is real time, 0.06 is the slow-motion strike. */
  timeScale: number;
  /** -1 hides the ball; 0..1 is its progress from release to the stumps. */
  delivery: number;
  /** Tone-mapping exposure: the lights coming up from black. */
  exposure: number;
  /**
   * Delivery opening only. The ball's clock, set by the film: its flight and
   * its rise are functions of it, so the film can be scrubbed and slowed
   * without the ball ever drifting off its path.
   */
  clip: number;
  /**
   * Delivery opening only. How much `cam` and `look` are offsets from the
   * ball rather than world positions: 0 is the world, 1 rides with the ball.
   */
  camFrom: { ball: number };
  lookFrom: { ball: number };
  /**
   * Delivery opening only: 0 takes the ball out of the sky once it has gone
   * at the top of its arc, so it never falls back into a frozen frame.
   */
  ballOn: number;
  /** Delivery opening only: 0..1, a star of light where the ball is. */
  glint: number;
}

export interface DropBallOptions {
  /**
   * Where the ball should land, asked every frame: a point in viewport pixels
   * and the radius it should have there. Null cancels the drop.
   */
  locate: () => { x: number; y: number; r: number } | null;
  /** Seconds from the top of the screen to the target. */
  duration?: number;
  onArrive: () => void;
}

export interface IntroStage {
  state: IntroState;
  /** Break the wicket: hand the stumps, bails and ball to the physics. */
  strike(): void;
  /** Stand the wicket back up for a replay. */
  reset(): void;
  /**
   * Freeze the stadium into a still (false) or start it moving again (true).
   * A frozen stage draws nothing per frame, so it can sit behind a scrolling
   * page for free.
   */
  setLive(on: boolean): void;
  /**
   * Break the wicket in a franchise's colours: LED bails, a spark burst and a
   * light flash in `primary`, with `secondary` mixed into the sparks. Null
   * restores the opening's red LEDs and turns the sparks off.
   */
  setTeamColors(primary: string | null, secondary?: string | null, led?: string | null, intensity?: number): void;
  /**
   * Delivery opening only: bring the ball back down out of the sky onto a
   * point on screen, then hide it. The landing uses it to set the ball onto
   * the top of the trophy.
   */
  dropBall(options: DropBallOptions): void;
  dispose(): void;
  /** For tuning from the console: draw calls and triangles last frame. */
  debug(): { calls: number; triangles: number; frames: number; internals: unknown };
  /**
   * Stop the clock and draw one frame of exactly `dt` seconds. For capturing
   * frames deterministically while tuning; the opening never calls it.
   */
  advance(dt: number): void;
}

export interface IntroStageOptions {
  tier: IntroTier;
  /**
   * "strike" (the default): the wicket alone, the ball arriving from off
   * screen. "delivery": the ball is launched from the far crease in a glint
   * of light, the far wicket standing behind it, and its flight, the strike
   * and its climb are all driven by the film's clock.
   */
  opening?: "strike" | "delivery";
  /** Called after the first frame has actually been drawn. */
  onReady?: () => void;
}

/* ------------------------------------------------------------- textures -- */

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  return { c, ctx };
}

/** Deterministic noise, so every replay and every screenshot is the same ground. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The outfield: mown in broad bands along the pitch with a lighter cross-cut,
 * which is the checked pattern a groundsman leaves on a match-day square. Real
 * grass greens, picked against how turf reads under metal-halide floods —
 * slightly yellow in the light band, deep and cool in the dark one.
 */
function grassTexture(size: number, R: number) {
  const { c, ctx } = canvas(size, size);
  const rand = rng(7);
  const px = size / (2 * R);
  const toX = (x: number) => (x / R + 1) * 0.5 * size;
  const toY = (z: number) => (z / R + 1) * 0.5 * size; // z relative to the ground centre

  ctx.fillStyle = "#2f6a29";
  ctx.fillRect(0, 0, size, size);

  // Lengthwise bands.
  const band = 9.5;
  for (let i = -8; i < 8; i++) {
    if (i % 2 === 0) continue;
    ctx.fillStyle = "#3b7d32";
    ctx.fillRect(toX(i * band - band / 2), 0, band * px, size);
  }
  // The cross-cut, weaker, so the bands still lead the eye down the pitch.
  ctx.globalAlpha = 0.32;
  for (let i = -8; i < 8; i++) {
    if (i % 2 === 0) continue;
    ctx.fillStyle = "#4a8a3a";
    ctx.fillRect(0, toY(i * band - band / 2), size, band * px);
  }
  ctx.globalAlpha = 1;

  // The square: the prepared block the pitch is cut from, a shade drier.
  ctx.fillStyle = "rgba(122,140,72,0.35)";
  ctx.fillRect(toX(-11), toY(-17), 22 * px, 34 * px);

  // Grain, so the bands do not read as flat paint at the close-up.
  for (let i = 0; i < size * 30; i++) {
    const light = rand() > 0.5;
    ctx.fillStyle = light ? "rgba(140,190,90,0.07)" : "rgba(8,30,8,0.10)";
    ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 2, 1 + rand() * 2);
  }

  // The thirty-yard circle, as painted dashes.
  ctx.strokeStyle = "rgba(240,244,236,0.75)";
  ctx.lineWidth = Math.max(1.5, 0.12 * px);
  ctx.setLineDash([1.2 * px, 1.6 * px]);
  ctx.beginPath();
  // Two semicircles joined by straights round each set of stumps, as the Laws draw it.
  const r30 = 27.43;
  const half = PITCH_LENGTH / 2;
  ctx.arc(toX(0), toY(-half), r30 * px, Math.PI, 0);
  ctx.lineTo(toX(r30), toY(half));
  ctx.arc(toX(0), toY(half), r30 * px, 0, Math.PI);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // Beyond the rope the grass is the worn, darker apron in front of the boards.
  ctx.fillStyle = "rgba(10,28,12,0.55)";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size, 0, Math.PI * 2);
  ctx.arc(size / 2, size / 2, FIELD_RADIUS * px, 0, Math.PI * 2, true);
  ctx.fill("evenodd");

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The strip itself: rolled clay, worn at each end where the bowlers land. */
function pitchTexture() {
  const W = 256;
  const H = 2048;
  const LEN = 24; // the plane runs 1.94m past each set of stumps
  const { c, ctx } = canvas(W, H);
  const rand = rng(11);
  const z0 = PITCH_Z - LEN / 2;
  const y = (z: number) => ((z - z0) / LEN) * H;
  const x = (m: number) => ((m + PITCH_WIDTH / 2) / PITCH_WIDTH) * W;
  const ppm = H / LEN;

  ctx.fillStyle = "#bba273";
  ctx.fillRect(0, 0, W, H);
  // A faint mown stripe down the middle, where the grass is left longest.
  ctx.fillStyle = "rgba(120,140,70,0.16)";
  ctx.fillRect(x(-0.9), 0, x(0.9) - x(-0.9), H);
  for (let i = 0; i < 14000; i++) {
    ctx.fillStyle = rand() > 0.55 ? "rgba(90,70,40,0.12)" : "rgba(236,222,180,0.10)";
    ctx.fillRect(rand() * W, rand() * H, 1 + rand() * 3, 1 + rand() * 3);
  }
  // Footmarks and the scuffed length in front of each popping crease.
  for (const end of [0, -PITCH_LENGTH]) {
    const dir = end === 0 ? -1 : 1;
    for (let i = 0; i < 260; i++) {
      const zz = end + dir * (0.6 + rand() * 3.4);
      ctx.fillStyle = `rgba(110,82,48,${0.08 + rand() * 0.14})`;
      ctx.beginPath();
      ctx.ellipse(x((rand() - 0.5) * 2.2), y(zz), 3 + rand() * 7, 3 + rand() * 9, rand() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Creases, in whitewash, 5cm wide.
  ctx.fillStyle = "#f4f2ea";
  const lw = 0.05 * ppm;
  for (const end of [0, -PITCH_LENGTH]) {
    const toward = end === 0 ? -1 : 1; // towards the other end
    const popping = end + toward * 1.22;
    // Bowling crease through the stumps.
    ctx.fillRect(x(-1.32), y(end) - lw / 2, x(1.32) - x(-1.32), lw);
    // Popping crease, right across the strip.
    ctx.fillRect(0, y(popping) - lw / 2, W, lw);
    // Return creases.
    for (const side of [-1.32, 1.32]) {
      const a = y(popping);
      const b = y(end - toward * 1.22);
      ctx.fillRect(x(side) - lw / 2, Math.min(a, b), lw, Math.abs(b - a));
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** A four-point star with a soft core: a glint of light on the ball. */
function starTexture() {
  const S = 256;
  const { c, ctx } = canvas(S, S);
  const core = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  core.addColorStop(0, "rgba(255,255,255,1)");
  core.addColorStop(0.08, "rgba(255,255,255,0.8)");
  core.addColorStop(0.3, "rgba(200,220,255,0.12)");
  core.addColorStop(1, "rgba(200,220,255,0)");
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, S, S);
  for (const [w, h] of [
    [S, 5],
    [5, S],
  ]) {
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect((S - w) / 2, (S - h) / 2, w, h);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A soft round sprite: lamp halos, sparks, dust. */
function glowTexture() {
  const { c, ctx } = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.22, "rgba(255,255,255,0.55)");
  g.addColorStop(0.55, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * LED hoarding: panels of brand copy, the way the boundary boards of an IPL
 * ground cycle sponsors. Only this product's own words, never anyone else's
 * marks.
 */
function boardTexture(lines: Array<{ text: string; ink: string; ground: string }>, panelW: number, h: number) {
  const { c, ctx } = canvas(panelW * lines.length, h);
  lines.forEach((line, i) => {
    ctx.fillStyle = line.ground;
    ctx.fillRect(i * panelW, 0, panelW, h);
    ctx.fillStyle = line.ink;
    ctx.font = `${Math.round(h * 0.62)}px "Russo One", Impact, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(line.text, i * panelW + panelW / 2, h * 0.54);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/* ---------------------------------------------------------------- shaders -- */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, -0.2, 1.0);
    vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, h));
    // The light the floods throw up into the haze, held low and cool.
    col += uGlow * exp(-max(h, 0.0) * 9.0) * 0.9;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const CROWD_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aPhase;
  attribute float aFlash;
  uniform float uTime;
  uniform float uScale;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float flash = step(0.5, aFlash);
    // Phone torches pulse; everyone else only shifts in their seat.
    float tw = mix(0.86 + 0.14 * sin(uTime * 0.9 + aPhase * 40.0),
                   0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * 1.7 + aPhase * 6.2831), 3.0),
                   flash);
    vColor = aColor * tw * mix(1.0, 2.0, flash);
    gl_PointSize = uScale * mix(1.0, 0.55, flash) / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CROWD_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vColor, smoothstep(0.5, 0.18, d));
  }
`;

/** A floodlight's beam: brightest down its axis, gone by the time it reaches the turf. */
const BEAM_VERT = /* glsl */ `
  varying float vAlong;
  varying float vFacing;
  void main() {
    vAlong = uv.y;
    vec3 n = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;

const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlong;
  varying float vFacing;
  void main() {
    float a = uOpacity * pow(vAlong, 2.2) * pow(vFacing, 1.6);
    gl_FragColor = vec4(uColor * a, a);
  }
`;

const STREAK_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float a = uOpacity * pow(vUv.y, 1.8);
    gl_FragColor = vec4(uColor * a, a);
  }
`;

const STREAK_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* --------------------------------------------------------------- physics -- */

interface Body {
  obj: THREE.Object3D;
  /** Local axis the piece is long along, and its half-length. */
  axis: THREE.Vector3;
  half: number;
  radius: number;
  v: THREE.Vector3;
  w: THREE.Vector3;
  home: { p: THREE.Vector3; q: THREE.Quaternion };
  live: boolean;
}

const GRAVITY = 9.81;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A rod on a floor, integrated by hand. Not a physics engine and not trying to
 * be one: enough to make a stump cartwheel, land on its spike, and fall flat
 * the way a real one does, in a dozen lines and with no dependency.
 */
function stepBody(b: Body, dt: number) {
  if (!b.live) return;
  b.v.y -= GRAVITY * dt;
  b.obj.position.addScaledVector(b.v, dt);

  const spin = b.w.length();
  if (spin > 1e-6) {
    _q.setFromAxisAngle(_a.copy(b.w).divideScalar(spin), spin * dt);
    b.obj.quaternion.premultiply(_q);
  }

  // Lowest point of the rod, including its thickness.
  _a.copy(b.axis).applyQuaternion(b.obj.quaternion);
  const lowEnd = _a.y > 0 ? -1 : 1;
  const low = b.obj.position.y + lowEnd * _a.y * b.half - b.radius;
  if (low < 0) {
    b.obj.position.y -= low;
    if (b.v.y < 0) b.v.y *= -0.28;
    b.v.x *= 0.82;
    b.v.z *= 0.82;
    b.w.multiplyScalar(0.8);

    // Topple: gravity about the contact point, as for a rod pivoting on its end.
    const up = Math.abs(_a.y);
    if (b.half > 0.02 && up > 0.04) {
      // Direction the raised end falls: away from vertical, outward.
      const sign = _a.y > 0 ? 1 : -1;
      _b.set(sign * _a.x, 0, sign * _a.z);
      if (_b.lengthSq() < 1e-6) _b.set(1, 0, 0.4);
      _b.normalize();
      const sinT = Math.sqrt(1 - up * up);
      const alpha = ((3 * GRAVITY) / (4 * b.half)) * Math.max(sinT, 0.15);
      // Axis that tips the rod's upper end along _b: up × b.
      const axis = _a.copy(UP).cross(_b);
      b.w.addScaledVector(axis, alpha * dt);
    }
    if (b.v.lengthSq() < 0.004 && b.w.lengthSq() < 0.02 && up < 0.05) b.live = false;
  }
}

/* ------------------------------------------------------------------ stage -- */

export function createIntroStage(host: HTMLElement, { tier, onReady, opening = "strike" }: IntroStageOptions): IntroStage {
  const cast = opening === "delivery";
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(x: T) => {
    disposables.push(x);
    return x;
  };

  const renderer = new THREE.WebGLRenderer({
    antialias: false, // the composer's own multisampled target does this
    powerPreference: "high-performance",
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier === 3 ? 1.75 : tier === 2 ? 1.5 : 1.25));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0;
  renderer.shadowMap.enabled = tier >= 2;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2("#081226", 0.0042);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 1200);

  /* ---- sky ---- */
  const sky = new THREE.Mesh(
    track(new THREE.SphereGeometry(600, 32, 16)),
    track(
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uZenith: { value: new THREE.Color("#01030a") },
          uHorizon: { value: new THREE.Color("#08122a") },
          uGlow: { value: new THREE.Color("#142f66") },
        },
      }),
    ),
  );
  sky.position.z = PITCH_Z;
  scene.add(sky);

  /* ---- ground ---- */
  const groundR = STAND_INNER + 1;
  const grassMap = track(grassTexture(tier === 1 ? 1024 : 2048, groundR));
  grassMap.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const ground = new THREE.Mesh(
    track(new THREE.CircleGeometry(groundR, 160)),
    track(new THREE.MeshStandardMaterial({ map: grassMap, roughness: 0.96, metalness: 0 })),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = PITCH_Z;
  ground.receiveShadow = true;
  scene.add(ground);

  const pitch = new THREE.Mesh(
    track(new THREE.PlaneGeometry(PITCH_WIDTH, 24)),
    track(
      new THREE.MeshStandardMaterial({
        map: track(pitchTexture()),
        roughness: 0.92,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    ),
  );
  pitch.rotation.x = -Math.PI / 2;
  pitch.position.set(0, 0.002, PITCH_Z);
  pitch.receiveShadow = true;
  scene.add(pitch);

  /* ---- boundary: cushion rope and LED boards ---- */
  const rope = new THREE.Mesh(
    track(new THREE.TorusGeometry(FIELD_RADIUS - 0.5, 0.11, 8, 256)),
    track(new THREE.MeshStandardMaterial({ color: "#1d3f9a", roughness: 0.55 })),
  );
  rope.rotation.x = Math.PI / 2;
  rope.position.set(0, 0.1, PITCH_Z);
  scene.add(rope);

  const boardMap = track(
    boardTexture(
      [
        { text: "AUCTONIQ", ink: "#ffb36b", ground: "#160b04" },
        { text: "IPL 2026", ink: "#9cc0ff", ground: "#050c1f" },
        { text: "MEGA AUCTION", ink: "#f2f5ff", ground: "#0a1430" },
        { text: "AUCTONIQ", ink: "#7fe7f5", ground: "#04161a" },
        { text: "LIVE BIDDING", ink: "#ffd27a", ground: "#141004" },
      ],
      512,
      64,
    ),
  );
  boardMap.repeat.set(-8, 1); // seen from inside, so mirrored back to read
  const boards = new THREE.Mesh(
    track(new THREE.CylinderGeometry(FIELD_RADIUS + 1.2, FIELD_RADIUS + 1.2, 0.9, 256, 1, true)),
    track(new THREE.MeshBasicMaterial({ map: boardMap, side: THREE.BackSide, color: new THREE.Color(1.6, 1.6, 1.6) })),
  );
  boards.position.set(0, 0.45, PITCH_Z);
  scene.add(boards);

  /* ---- stands ---- */
  // One profile, lathed: pitch-side wall, lower tier, concourse, upper tier, back wall.
  const profile = [
    [STAND_INNER, 0],
    [STAND_INNER, 1.4],
    [86, 10.2],
    [88.2, 10.6],
    [88.2, 12.8],
    [108, 27],
    [110, 27.4],
    [110.5, 31],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  // Seat rows, aisles, the concourse and the lit entrances, one band of the
  // texture per segment of the profile.
  const standMat = track(
    new THREE.MeshStandardMaterial({ map: track(standTexture(profile.length - 1)), roughness: 0.92, side: THREE.DoubleSide }),
  );
  const stands = new THREE.Mesh(track(new THREE.LatheGeometry(profile, 192)), standMat);
  stands.position.z = PITCH_Z;
  scene.add(stands);

  // Ribbon board round the concourse.
  const ribbonMap = track(
    boardTexture(
      [
        { text: "AUCTONIQ  ·  IPL 2026 MEGA AUCTION", ink: "#ffb36b", ground: "#07070c" },
        { text: "EVERY NAME HAS A PRICE", ink: "#9cc0ff", ground: "#05070f" },
      ],
      1024,
      64,
    ),
  );
  ribbonMap.repeat.set(-6, 1);
  const ribbon = new THREE.Mesh(
    track(new THREE.CylinderGeometry(88.1, 88.1, 2.0, 256, 1, true)),
    track(new THREE.MeshBasicMaterial({ map: ribbonMap, side: THREE.BackSide, color: new THREE.Color(1.3, 1.3, 1.3) })),
  );
  ribbon.position.set(0, 11.7, PITCH_Z);
  scene.add(ribbon);

  // Roof canopies, one between each pair of towers.
  const roofMat = track(new THREE.MeshStandardMaterial({ color: "#141a26", roughness: 0.7, metalness: 0.3, side: THREE.DoubleSide }));
  const roofProfile = [new THREE.Vector2(111, 30.5), new THREE.Vector2(98, 33.2), new THREE.Vector2(86, 34.6)];
  for (const a of TOWER_ANGLES) {
    const start = a + THREE.MathUtils.degToRad(7);
    const len = THREE.MathUtils.degToRad(46);
    const roof = new THREE.Mesh(track(new THREE.LatheGeometry(roofProfile, 48, start, len)), roofMat);
    roof.position.z = PITCH_Z;
    scene.add(roof);
  }

  /* ---- crowd ---- */
  const crowdCount = tier === 3 ? 30000 : tier === 2 ? 22000 : 12000;
  const crowdPos = new Float32Array(crowdCount * 3);
  const crowdCol = new Float32Array(crowdCount * 3);
  const crowdPhase = new Float32Array(crowdCount);
  const crowdFlash = new Float32Array(crowdCount);
  {
    const rand = rng(23);
    // Franchise colours, held dim: the stands sit outside the floods' throw.
    const shirts = ["#1d4fb8", "#f2c230", "#f07a23", "#5b2d8e", "#d42a2a", "#3fa3e0", "#d8dde6", "#1a2c5a", "#e04f8a"].map(
      (h) => new THREE.Color(h),
    );
    const tiers = [
      { r0: STAND_INNER + 1, y0: 1.8, r1: 85.5, y1: 9.9 },
      { r0: 88.8, y0: 13.2, r1: 107.5, y1: 26.6 },
    ];
    const c = new THREE.Color();
    for (let i = 0; i < crowdCount; i++) {
      const t = tiers[rand() < 0.45 ? 0 : 1];
      const s = rand();
      const r = t.r0 + (t.r1 - t.r0) * s;
      const y = t.y0 + (t.y1 - t.y0) * s + 0.45;
      const a = rand() * Math.PI * 2;
      crowdPos[i * 3] = Math.sin(a) * r;
      crowdPos[i * 3 + 1] = y;
      crowdPos[i * 3 + 2] = Math.cos(a) * r + PITCH_Z;
      const flash = rand() < 0.012;
      crowdFlash[i] = flash ? 1 : 0;
      crowdPhase[i] = rand();
      if (flash) c.set("#dfe9ff");
      else c.copy(shirts[Math.floor(rand() * shirts.length)]).multiplyScalar(0.2 + rand() * 0.26);
      crowdCol[i * 3] = c.r;
      crowdCol[i * 3 + 1] = c.g;
      crowdCol[i * 3 + 2] = c.b;
    }
  }
  const crowdGeo = track(new THREE.BufferGeometry());
  crowdGeo.setAttribute("position", new THREE.BufferAttribute(crowdPos, 3));
  crowdGeo.setAttribute("aColor", new THREE.BufferAttribute(crowdCol, 3));
  crowdGeo.setAttribute("aPhase", new THREE.BufferAttribute(crowdPhase, 1));
  crowdGeo.setAttribute("aFlash", new THREE.BufferAttribute(crowdFlash, 1));
  const crowdMat = track(
    new THREE.ShaderMaterial({
      vertexShader: CROWD_VERT,
      fragmentShader: CROWD_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uScale: { value: 300 } },
    }),
  );
  const crowd = new THREE.Points(crowdGeo, crowdMat);
  crowd.frustumCulled = false;
  scene.add(crowd);

  /* ---- floodlight towers ---- */
  const glow = track(glowTexture());
  const mastMat = track(new THREE.MeshStandardMaterial({ color: "#2a3242", roughness: 0.6, metalness: 0.5 }));
  const frameMat = track(new THREE.MeshStandardMaterial({ color: "#151b26", roughness: 0.7, metalness: 0.4 }));
  // HDR white with the faintest cool cast: the lamp faces themselves.
  const lampMat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.9, 3.5) }));
  const haloMat = track(
    new THREE.SpriteMaterial({
      map: glow,
      color: new THREE.Color("#4f7fe8"),
      transparent: true,
      opacity: 0.24,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const coreMat = track(
    new THREE.SpriteMaterial({
      map: glow,
      color: new THREE.Color("#dfe8ff"),
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const beamMat =
    tier >= 2
      ? track(
          new THREE.ShaderMaterial({
            vertexShader: BEAM_VERT,
            fragmentShader: BEAM_FRAG,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            uniforms: { uColor: { value: new THREE.Color("#86a8ff") }, uOpacity: { value: tier === 3 ? 0.065 : 0.045 } },
          }),
        )
      : null;

  const mastGeo = track(new THREE.CylinderGeometry(0.7, 1.5, MAST_HEIGHT, 12));
  const frameGeo = track(new THREE.BoxGeometry(15, 8.5, 0.7));
  const lampGeo = track(new THREE.PlaneGeometry(0.95, 0.95));
  const COLS = 12;
  const ROWS = 6;
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, TOWER_ANGLES.length * COLS * ROWS);
  lamps.frustumCulled = false;
  let lampIndex = 0;
  const towerHeads: THREE.Object3D[] = [];
  const centre = new THREE.Vector3(0, 0, PITCH_Z);

  TOWER_ANGLES.forEach((a) => {
    const base = new THREE.Vector3(Math.sin(a) * TOWER_RADIUS, 0, Math.cos(a) * TOWER_RADIUS + PITCH_Z);
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.set(base.x, MAST_HEIGHT / 2, base.z);
    scene.add(mast);

    const head = new THREE.Group();
    head.position.set(base.x, MAST_HEIGHT + 2, base.z);
    head.lookAt(centre.x, -10, centre.z);
    scene.add(head);
    towerHeads.push(head);

    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.position.z = -0.45;
    head.add(frame);

    const m = new THREE.Matrix4();
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        const local = new THREE.Vector3((c - (COLS - 1) / 2) * 1.18, (r - (ROWS - 1) / 2) * 1.25, 0.02);
        head.updateMatrixWorld(true);
        m.compose(local.applyMatrix4(head.matrixWorld), head.quaternion, new THREE.Vector3(1, 1, 1));
        lamps.setMatrixAt(lampIndex++, m);
      }

    // The blue reflection: a wide, soft halo, cool and low, round each bank.
    const halo = new THREE.Sprite(haloMat);
    halo.scale.setScalar(64);
    halo.position.set(0, 0, 1.5);
    head.add(halo);
    const core = new THREE.Sprite(coreMat);
    core.scale.setScalar(13);
    core.position.set(0, 0, 1.2);
    head.add(core);

    if (beamMat) {
      const length = head.position.distanceTo(new THREE.Vector3(centre.x, 0, centre.z));
      const beamGeo = track(new THREE.ConeGeometry(34, length, 40, 1, true));
      beamGeo.rotateX(-Math.PI / 2);
      beamGeo.translate(0, 0, length / 2);
      const beam = new THREE.Mesh(beamGeo, beamMat);
      head.add(beam);
    }
  });
  lamps.instanceMatrix.needsUpdate = true;
  scene.add(lamps);

  // The finish: seats' LED edges, roof trusses and downlights, sightscreens,
  // lamp glare and a pool of light on the middle.
  const detail = createStadiumDetail({
    tier,
    centre: new THREE.Vector3(0, 0, PITCH_Z),
    wall: { r: STAND_INNER, top: 1.4 },
    concourse: { r: 88.2, bottom: 10.6, top: 12.8 },
    roof: { front: 86, frontY: 34.6, back: 111, backY: 30.5 },
    towerAngles: TOWER_ANGLES,
    roofArc: { from: THREE.MathUtils.degToRad(7), span: THREE.MathUtils.degToRad(46) },
    lampHeads: towerHeads,
    boundary: FIELD_RADIUS,
    glow,
  });
  track(detail);
  scene.add(detail.group);

  /* ---- light that actually falls on the ground: neutral, slightly warm ---- */
  scene.add(new THREE.HemisphereLight("#a9bde0", "#0d1a0c", 0.55));
  const key = new THREE.DirectionalLight("#fff3e2", 2.1);
  key.position.set(-26, 46, 24);
  key.target.position.set(0, 0, -1);
  if (tier >= 2) {
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = key.shadow.camera;
    s.left = -3.5;
    s.right = 3.5;
    s.top = 3.5;
    s.bottom = -3.5;
    s.near = 20;
    s.far = 110;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
  }
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight("#f4f7ff", 1.1);
  fill.position.set(40, 40, -60);
  scene.add(fill);
  const rim = new THREE.DirectionalLight("#fff6ea", 0.9);
  rim.position.set(30, 30, 50);
  scene.add(rim);

  /* ---- the wicket ---- */
  const stumpMat = track(new THREE.MeshStandardMaterial({ color: "#f3efe4", roughness: 0.42 }));
  // The LED sections: the top of each stump and both bails. They light red when
  // the bails leave their grooves, which is what an IPL wicket actually does.
  const ledMat = track(
    new THREE.MeshStandardMaterial({
      color: "#1a2238",
      roughness: 0.35,
      emissive: new THREE.Color("#ff1e1e"),
      emissiveIntensity: 0,
    }),
  );
  const shaftGeo = track(new THREE.CylinderGeometry(STUMP_RADIUS, STUMP_RADIUS, STUMP_HEIGHT - 0.12, 24));
  const capGeo = track(new THREE.CylinderGeometry(STUMP_RADIUS * 1.02, STUMP_RADIUS * 1.02, 0.12, 24));
  const domeGeo = track(new THREE.SphereGeometry(STUMP_RADIUS * 1.02, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2));
  const spikeGeo = track(new THREE.ConeGeometry(STUMP_RADIUS, 0.14, 16));
  const bodies: Body[] = [];

  const wicket = new THREE.Group();
  scene.add(wicket);
  // The delivery opening holds the camera on the wicket close up: turned ash
  // stumps and bails, not the LED set the strike opening and the marquee use.
  const gear = cast ? createWoodenWicket(STUMP_HEIGHT, STUMP_RADIUS) : null;
  if (gear) track(gear);

  [-1, 0, 1].forEach((i) => {
    let g: THREE.Group;
    if (gear) g = gear.stump();
    else {
      g = new THREE.Group();
      const shaft = new THREE.Mesh(shaftGeo, stumpMat);
      shaft.position.y = -0.06;
      const cap = new THREE.Mesh(capGeo, ledMat);
      cap.position.y = STUMP_HEIGHT / 2 - 0.06;
      const dome = new THREE.Mesh(domeGeo, ledMat);
      dome.position.y = STUMP_HEIGHT / 2;
      const spike = new THREE.Mesh(spikeGeo, stumpMat);
      spike.rotation.x = Math.PI;
      spike.position.y = -STUMP_HEIGHT / 2 - 0.07;
      for (const part of [shaft, cap, dome, spike]) {
        part.castShadow = true;
        g.add(part);
      }
    }
    g.position.set(i * STUMP_SPACING, STUMP_HEIGHT / 2, 0);
    wicket.add(g);
    bodies.push({
      obj: g,
      axis: new THREE.Vector3(0, 1, 0),
      half: STUMP_HEIGHT / 2,
      radius: STUMP_RADIUS,
      v: new THREE.Vector3(),
      w: new THREE.Vector3(),
      home: { p: g.position.clone(), q: g.quaternion.clone() },
      live: false,
    });
  });

  const bailGeo = track(new THREE.CapsuleGeometry(0.0085, 0.092, 4, 12));
  bailGeo.rotateZ(Math.PI / 2);
  [-1, 1].forEach((side) => {
    const bail = gear ? gear.bail() : new THREE.Mesh(bailGeo, ledMat);
    bail.castShadow = true;
    bail.position.set((side * STUMP_SPACING) / 2, STUMP_HEIGHT + 0.009, 0);
    // Long spigot outwards, barrels meeting over the middle stump.
    if (gear && side > 0) bail.rotation.y = Math.PI;
    wicket.add(bail);
    bodies.push({
      obj: bail,
      axis: new THREE.Vector3(1, 0, 0),
      half: 0.055,
      radius: 0.0085,
      v: new THREE.Vector3(),
      w: new THREE.Vector3(),
      home: { p: bail.position.clone(), q: bail.quaternion.clone() },
      live: false,
    });
  });

  const zingLight = new THREE.PointLight("#ff2a2a", 0, 2.4, 2);
  zingLight.position.set(0, STUMP_HEIGHT, 0.05);
  scene.add(zingLight);

  // The bowler's end, for the delivery opening: the same wicket, standing
  // still, its LEDs dark.
  if (cast) {
    const far = new THREE.Group();
    [-1, 0, 1].forEach((i) => {
      const g = gear!.stump();
      g.position.set(i * STUMP_SPACING, STUMP_HEIGHT / 2, 0);
      far.add(g);
    });
    [-1, 1].forEach((side) => {
      const bail = gear!.bail();
      bail.position.set((side * STUMP_SPACING) / 2, STUMP_HEIGHT + 0.009, 0);
      if (side > 0) bail.rotation.y = Math.PI;
      far.add(bail);
    });
    far.position.z = -PITCH_LENGTH;
    scene.add(far);
  }

  /* ---- the ball ---- */
  // A white ball: this is a night T20.
  const ball = new THREE.Group();
  const ballMat = track(new THREE.MeshStandardMaterial({ color: "#f6f5ef", roughness: 0.32, emissive: "#ffffff", emissiveIntensity: 0.18 }));
  const ballMesh = new THREE.Mesh(track(new THREE.SphereGeometry(BALL_RADIUS, 32, 24)), ballMat);
  ballMesh.castShadow = true;
  const seam = new THREE.Mesh(
    track(new THREE.TorusGeometry(BALL_RADIUS * 1.001, 0.0022, 6, 48)),
    track(new THREE.MeshStandardMaterial({ color: "#9aa0a8", roughness: 0.5 })),
  );
  // The delivery opening shows the ball close up, hanging in the air: the
  // stitched match ball in place of the plain sphere.
  const match = cast ? createMatchBall(BALL_RADIUS, tier) : null;
  if (match) {
    track(match);
    // Seam upright, angled a touch towards the slips.
    match.group.rotation.y = 0.26;
    ball.add(match.group);
  } else ball.add(ballMesh, seam);
  /** The ball's surface, lit a little from within while it falls to the trophy. */
  const ballSkin = match ? match.leather : ballMat;
  const skinGlow = ballSkin.emissiveIntensity;
  ball.visible = false;
  scene.add(ball);

  const streakGeo = track(new THREE.CylinderGeometry(BALL_RADIUS * 0.95, 0.002, 1, 16, 1, true));
  streakGeo.translate(0, -0.5, 0);
  const streakMat = track(
    new THREE.ShaderMaterial({
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color("#d8e6ff") }, uOpacity: { value: 0.9 } },
    }),
  );
  const streak = new THREE.Mesh(streakGeo, streakMat);
  streak.visible = false;
  scene.add(streak);

  const ballBody: Body = {
    obj: ball,
    axis: new THREE.Vector3(0, 1, 0),
    half: 0,
    radius: BALL_RADIUS,
    v: new THREE.Vector3(),
    w: new THREE.Vector3(),
    home: { p: RELEASE.clone(), q: new THREE.Quaternion() },
    live: false,
  };

  /* ---- debris: clay, turf and splinters of light ---- */
  const DEBRIS = tier === 1 ? 70 : 140;
  const debrisPos = new Float32Array(DEBRIS * 3);
  const debrisCol = new Float32Array(DEBRIS * 3);
  const debrisVel = new Float32Array(DEBRIS * 3);
  {
    const rand = rng(31);
    const c = new THREE.Color();
    for (let i = 0; i < DEBRIS; i++) {
      const pick = rand();
      c.set(pick < 0.5 ? "#c4a874" : pick < 0.82 ? "#5f9440" : "#ffffff");
      if (pick >= 0.82) c.multiplyScalar(2.2);
      debrisCol.set([c.r, c.g, c.b], i * 3);
    }
  }
  const debrisGeo = track(new THREE.BufferGeometry());
  debrisGeo.setAttribute("position", new THREE.BufferAttribute(debrisPos, 3));
  debrisGeo.setAttribute("color", new THREE.BufferAttribute(debrisCol, 3));
  const debrisMat = track(
    new THREE.PointsMaterial({
      size: 0.035,
      map: glow,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      opacity: 0,
    }),
  );
  const debris = new THREE.Points(debrisGeo, debrisMat);
  debris.frustumCulled = false;
  scene.add(debris);

  /* ---- sparks: a team-coloured burst where the ball meets the stumps ----
     Off unless `setTeamColors` has been given a team: the site's opening keeps
     its red LED flash and clay debris. The marquee reveal turns them on, so a
     Bengaluru player breaks the wicket in red and a Chennai one in yellow.
     HDR colours (multiplied past 1) so the bloom pass lifts them into light. */
  const SPARKS = tier === 1 ? 90 : 220;
  const sparkPos = new Float32Array(SPARKS * 3);
  const sparkVel = new Float32Array(SPARKS * 3);
  const sparkCol = new Float32Array(SPARKS * 3);
  const sparkGeo = track(new THREE.BufferGeometry());
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute("color", new THREE.BufferAttribute(sparkCol, 3));
  const sparkMat = track(
    new THREE.PointsMaterial({
      size: 0.055,
      map: glow,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    }),
  );
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  scene.add(sparks);
  // Lights the pitch and the flying stumps in the team's colour for an instant.
  const burstLight = new THREE.PointLight("#ffffff", 0, 6, 1.6);
  burstLight.position.copy(IMPACT);
  scene.add(burstLight);
  let sparksOn = false;
  let sparkAge = -1;
  let burstPeak = 9;

  /* ---- the delivery opening: the ball's glow, its glint and its trail ---- */
  /** Where the ball leaves the far crease. */
  const release = RELEASE.clone();
  const ballGlow = new THREE.Sprite(
    track(
      new THREE.SpriteMaterial({
        map: glow,
        color: new THREE.Color("#dfe9ff"),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );
  ballGlow.visible = false;
  scene.add(ballGlow);
  // The ball's last moment in the sky: a four-point star at the top of its arc.
  const starMat = track(
    new THREE.SpriteMaterial({
      map: track(starTexture()),
      color: new THREE.Color(2.2, 2.3, 2.6),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  const star = new THREE.Sprite(starMat);
  star.visible = false;
  scene.add(star);
  // The strike's sparks, streaks of cooling metal, for the delivery opening.
  const strikeSparks = cast ? track(createStrikeSparks(tier, glow, starMat.map!)) : null;
  if (strikeSparks) scene.add(strikeSparks.group);
  // The arc it climbs on, drawn behind it as a tapering ribbon of light, so
  // the parabola reads as a shape and not just a moving point.
  const TRAIL = 28;
  const trailPos = new Float32Array(TRAIL * 2 * 3);
  const trailCol = new Float32Array(TRAIL * 2 * 3);
  const trailGeo = track(new THREE.BufferGeometry());
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(trailCol, 3));
  {
    const idx: number[] = [];
    for (let i = 0; i < TRAIL - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    trailGeo.setIndex(idx);
    for (let i = 0; i < TRAIL; i++) {
      const k = Math.pow(1 - i / (TRAIL - 1), 1.6);
      trailCol.set([0.85 * k, 0.92 * k, 1.1 * k, 0.85 * k, 0.92 * k, 1.1 * k], i * 6);
    }
  }
  const trailMat = track(
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  // A puff of clay where the ball pitches: a function of the ball's clock, so
  // it scrubs with everything else.
  const PUFF = 56;
  const puffPos = new Float32Array(PUFF * 3);
  const puffCol = new Float32Array(PUFF * 3);
  const puffVel: number[] = [];
  {
    const rand = rng(43);
    const c = new THREE.Color();
    for (let i = 0; i < PUFF; i++) {
      c.set(rand() < 0.7 ? "#dcc79c" : "#b39a6c").multiplyScalar(0.95 + rand() * 0.3);
      puffCol.set([c.r, c.g, c.b], i * 3);
      const a = rand() * Math.PI * 2;
      const sp = 0.5 + rand() * 1.6;
      // Mostly on along the line of the ball, a little up and out.
      puffVel.push(Math.cos(a) * sp * 0.45, 0.35 + rand() * 0.9, Math.abs(Math.sin(a)) * sp + 0.6);
    }
  }
  const puffGeo = track(new THREE.BufferGeometry());
  puffGeo.setAttribute("position", new THREE.BufferAttribute(puffPos, 3).setUsage(THREE.DynamicDrawUsage));
  puffGeo.setAttribute("color", new THREE.BufferAttribute(puffCol, 3));
  const puffMat = track(
    new THREE.PointsMaterial({ size: 0.06, map: glow, vertexColors: true, transparent: true, depthWrite: false, opacity: 0 }),
  );
  const puff = new THREE.Points(puffGeo, puffMat);
  puff.frustumCulled = false;
  puff.visible = false;
  scene.add(puff);
  /** Where on screen (NDC) the climbing ball was last seen, for its return. */
  let lastSeen: THREE.Vector2 | null = null;
  const ndc = new THREE.Vector3();

  const trail = new THREE.Mesh(trailGeo, trailMat);
  trail.frustumCulled = false;
  trail.visible = false;
  scene.add(trail);
  function setTeamColors(primary: string | null, secondary?: string | null, led?: string | null, intensity = 1) {
    if (!primary) {
      sparksOn = false;
      ledMat.emissive.set("#ff1e1e");
      zingLight.color.set("#ff2a2a");
      return;
    }
    sparksOn = true;
    ledMat.emissive.set(led || primary);
    zingLight.color.set(led || primary);
    burstLight.color.set(primary);
    const a = new THREE.Color(primary);
    const b = new THREE.Color(secondary || "#ffffff");
    const white = new THREE.Color("#ffffff");
    const rand = rng(97);
    const c = new THREE.Color();
    for (let i = 0; i < SPARKS; i++) {
      const pick = rand();
      if (pick < 0.66) c.copy(a).multiplyScalar(3.2 * intensity);
      else if (pick < 0.86) c.copy(b).multiplyScalar(2.6 * intensity);
      else c.copy(white).multiplyScalar(3 * intensity);
      sparkCol.set([c.r, c.g, c.b], i * 3);
    }
    (sparkGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    burstPeak = 9 * intensity;
    sparkMat.size = 0.055 * (0.55 + 0.45 * intensity);
  }

  // Compile every program the film will need now, while the visitor is still
  // on the gate. Drawn for the first time mid-film, the ball, its glow and
  // trail, the glint and the clay puff would each stall the frame they
  // appear on while the GPU built their shaders, and on a cold shader cache
  // that is hundreds of milliseconds, right on the press of Enter.
  {
    const parts: THREE.Object3D[] = [ball, streak, ballGlow, star, trail, puff];
    if (strikeSparks) parts.push(strikeSparks.group);
    const hidden = parts.filter((o) => !o.visible);
    for (const o of hidden) o.visible = true;
    renderer.compile(scene, camera);
    // compile() also assumes drawing to the screen, which builds different
    // programs from the ones the composer's render target needs. So draw the
    // film's pieces once, for real, into a small offscreen target, in front
    // of a camera aimed at them and inside the key light's shadow.
    {
      const moved = [ball, ballGlow, star, streak].map((o) => [o, o.position.clone()] as const);
      for (const [o] of moved) o.position.set(0, 0.4, 0);
      const cam = camera.clone();
      cam.position.set(0, 0.6, 2.5);
      cam.lookAt(0, 0.4, 0);
      cam.updateMatrixWorld();
      const probe = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType });
      renderer.setRenderTarget(probe);
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      probe.dispose();
      for (const [o, at] of moved) o.position.copy(at);
    }
    for (const o of hidden) o.visible = false;
  }

  /* ---- post ---- */
  // The composer's own half-float target, deliberately without MSAA samples:
  // a multisampled half-float target resolves to solid black on Intel GPUs
  // under ANGLE/D3D11, which is most Windows laptops. SMAA does the edges.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.5, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const smaa = tier >= 2 ? new SMAAPass() : null;
  if (smaa) composer.addPass(smaa);

  /* ---- state ---- */
  const state: IntroState = {
    cam: { x: 3.0, y: 0.62, z: 3.1 },
    look: { x: -0.25, y: 0.42, z: -6 },
    fov: 32,
    shake: 0,
    drift: 0,
    timeScale: 1,
    delivery: -1,
    exposure: 0,
    clip: DELIVERY.start,
    camFrom: { ball: 0 },
    lookFrom: { ball: 0 },
    ballOn: 1,
    glint: 0,
  };

  let simTime = 0;
  let struckAt = -1;
  /** Delivery opening: the ball's clock at the strike, or -1. */
  let struckClip = -1;
  let drop: (Required<DropBallOptions> & { t: number; started: boolean }) | null = null;
  let ballScale = 1;
  let debrisAge = -1;
  let driftAngle = 0;
  let width = 1;
  let height = 1;
  let fovApplied = -1;

  const deliveryPoint = (u: number, out: THREE.Vector3) => {
    if (u <= BOUNCE_AT) {
      const s = u / BOUNCE_AT;
      out.lerpVectors(release, BOUNCE, s);
      out.y = BOUNCE.y + (release.y - BOUNCE.y) * Math.pow(1 - s, 1.18);
    } else {
      const s = (u - BOUNCE_AT) / (1 - BOUNCE_AT);
      out.lerpVectors(BOUNCE, IMPACT, s);
      out.y = BOUNCE.y + (IMPACT.y - BOUNCE.y) * (1 - (1 - s) * (1 - s));
    }
    return out;
  };

  const applyFov = () => {
    // Hold the horizontal framing on a portrait screen, so the wicket and the
    // ground do not crop away on a phone.
    const aspect = width / height;
    const designAspect = 16 / 9;
    let fov = state.fov;
    if (aspect < designAspect) {
      const h = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(state.fov) / 2) * designAspect);
      fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / aspect));
      fov = Math.min(fov, 78);
    }
    camera.fov = fov;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    // Crowd points are sized in metres.
    const bufferH = height * renderer.getPixelRatio();
    crowdMat.uniforms.uScale.value = (0.4 * bufferH) / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
    strikeSparks?.resize(bufferH, fov);
    fovApplied = state.fov;
  };

  /** False once frozen into a still: nothing draws except after a resize. */
  let live = true;

  const resize = () => {
    const rect = host.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    const pr = renderer.getPixelRatio();
    bloom.resolution.set(width * pr * 0.5, height * pr * 0.5);
    applyFov();
    // Resizing clears the canvas, so a frozen stadium redraws its one frame.
    if (!live) draw(0);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  /* ---- loop ---- */
  const p = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const look = new THREE.Vector3();
  const focus = new THREE.Vector3();
  const KEY_OFFSET = new THREE.Vector3(-26, 46, 25);
  const ray = new THREE.Vector3();
  const trailA = new THREE.Vector3();
  const trailB = new THREE.Vector3();

  /** The climb after the strike, `t` seconds of ball time after it. */
  const risePoint = (t: number, out: THREE.Vector3) => {
    const r = DELIVERY.rise;
    const k = Math.max(0, t);
    return out.set(IMPACT.x + r.vx * k, IMPACT.y + r.vy * k - 0.5 * r.g * k * k, IMPACT.z + r.vz * k);
  };

  /** Viewport pixels to a point `d` metres down that pixel's line of sight. */
  const alongRay = (x: number, y: number, d: number, rect: DOMRect, out: THREE.Vector3) => {
    ray.set(((x - rect.left) / rect.width) * 2 - 1, -(((y - rect.top) / rect.height) * 2 - 1), 0.5);
    ray.unproject(camera).sub(camera.position).normalize();
    return out.copy(camera.position).addScaledVector(ray, d);
  };

  /** Falls, accelerating, then is caught and set down over the last frames. */
  const fall = (s: number) =>
    s < 0.8 ? 0.92 * Math.pow(s / 0.8, 2.1) : 0.92 + 0.08 * (1 - Math.pow(1 - (s - 0.8) / 0.2, 3));

  /** The ball's way down from the sky to the target on screen. */
  function placeDrop(dt: number) {
    if (!drop) return;
    const rect = host.getBoundingClientRect();
    const target = drop.locate();
    if (!target || rect.width < 1) {
      endDrop();
      return;
    }
    // Out of the night above the top of the screen, a little to one side,
    // growing as it falls towards the lens.
    const D0 = 42;
    const D1 = 6;
    const pxPerM = rect.height / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    ballScale = (target.r * D1) / pxPerM / BALL_RADIUS;
    // From where the climbing ball left the top of the frame, if it did, so
    // the ball that comes down is plainly the one that went up.
    const sx = lastSeen ? rect.left + ((lastSeen.x + 1) / 2) * rect.width : target.x + rect.width * 0.05;
    const sy = rect.top - rect.height * 0.06;
    drop.started = true;
    drop.t += dt;
    const s = Math.min(1, drop.t / drop.duration);
    const e = fall(s);
    const x = sx + (target.x - sx) * e;
    const y = sy + (target.y - sy) * e;
    const d = D0 * Math.pow(D1 / D0, e);
    alongRay(x, y, d, rect, ball.position);
    ball.visible = true;
    // Lit a little from within: it falls behind the landing's scrim and
    // must still arrive as white as the ball the trophy takes from it.
    ballSkin.emissiveIntensity = 0.62;
    ball.rotation.x -= dt * 9;
    // The trail points back up the way it came.
    const eb = Math.max(0, e - 0.03);
    alongRay(sx + (target.x - sx) * eb, sy + (target.y - sy) * eb, D0 * Math.pow(D1 / D0, eb), rect, prev);
    dir.subVectors(ball.position, prev);
    if (s < 0.9 && dir.lengthSq() > 1e-8) {
      const len = Math.min(dir.length() * 2.2, BALL_RADIUS * ballScale * 12);
      streak.visible = true;
      streak.position.copy(ball.position);
      streak.quaternion.setFromUnitVectors(UP, dir.normalize());
      streak.scale.set(ballScale, len, ballScale);
    } else streak.visible = false;
    if (s >= 1) endDrop();
  }

  function endDrop() {
    const done = drop;
    drop = null;
    ballSkin.emissiveIntensity = skinGlow;
    ball.visible = false;
    streak.visible = false;
    ballGlow.visible = false;
    done?.onArrive();
  }

  function dropBall(options: DropBallOptions) {
    if (!cast) {
      options.onArrive();
      return;
    }
    drop = { duration: 1.15, ...options, t: 0, started: false };
  }
  const pivot = new THREE.Vector3(0, 0, PITCH_Z);
  const clock = new THREE.Clock();
  let frame = 0;
  let first = true;
  let frames = 0;

  function tick() {
    frame = requestAnimationFrame(tick);
    draw(Math.min(clock.getDelta(), 1 / 30));
  }

  function draw(dt: number) {
    const sdt = dt * state.timeScale;
    simTime += sdt;

    renderer.toneMappingExposure = state.exposure;
    if (state.fov !== fovApplied) applyFov();
    crowdMat.uniforms.uTime.value += dt;

    if (cast) {
      // The delivery opening: everything the ball does is a function of its
      // clock: waiting at the far crease, down the pitch, up past the roof.
      const c = state.clip;
      ballScale = 1;
      if (drop) {
        // Placed below, once the camera is.
      } else if (struckClip >= 0) {
        risePoint(c - struckClip, p);
        risePoint(c - struckClip - 0.018, prev);
        ball.visible = true;
        ball.position.copy(p);
      } else if (c >= DELIVERY.release) {
        const u = Math.min((c - DELIVERY.release) / DELIVERY.flight, 1);
        deliveryPoint(u, p);
        deliveryPoint(Math.max(u - 0.03, 0), prev);
        ball.visible = true;
        ball.position.copy(p);
      } else {
        // Not yet released: unseen, waiting where it will appear.
        p.copy(release);
        prev.copy(release);
        ball.visible = false;
        ball.position.copy(p);
      }
      ball.rotation.x -= sdt * 38;
      if (!drop && state.ballOn < 0.5) ball.visible = false;
      dir.subVectors(p, prev);
      const len = dir.length();
      if (ball.visible && !drop && c >= DELIVERY.release && len > 0.02) {
        streak.visible = true;
        streak.position.copy(p);
        streak.quaternion.setFromUnitVectors(UP, dir.normalize());
        streak.scale.set(1, Math.min(len * 1.7, 2.8), 1);
      } else streak.visible = false;
    } else if (!ballBody.live) {
      // Ball on its delivery, until the strike hands it to the physics.
      if (state.delivery >= 0) {
        ball.visible = true;
        deliveryPoint(Math.min(state.delivery, 1), p);
        deliveryPoint(Math.max(Math.min(state.delivery, 1) - 0.035, 0), prev);
        ball.position.copy(p);
        ball.rotation.x -= dt * 38;
        dir.subVectors(p, prev);
        const len = dir.length();
        if (len > 1e-4 && state.delivery < 1) {
          streak.visible = true;
          streak.position.copy(p);
          streak.quaternion.setFromUnitVectors(UP, dir.normalize());
          streak.scale.set(1, Math.min(len * 2.4, 2.6), 1);
        } else streak.visible = false;
      } else {
        ball.visible = false;
        streak.visible = false;
      }
    } else {
      streak.visible = false;
    }

    // Physics, in slow-motion time.
    if (struckAt >= 0) {
      const steps = 3;
      for (let s = 0; s < steps; s++) {
        for (const b of bodies) stepBody(b, sdt / steps);
        stepBody(ballBody, sdt / steps);
      }
      ball.rotation.x -= sdt * 30;

      // LED wicket: on the instant the bails lift, flashing, then a steady glow.
      const since = simTime - struckAt;
      const flashing = since < 2.6 ? (Math.floor(since * 7) % 2 === 0 ? 1 : 0.15) : 0.55;
      ledMat.emissiveIntensity = 3.2 * flashing;
      zingLight.intensity = cast ? 0 : 2.2 * flashing;
      zingLight.position.copy(bodies[1].obj.position).setY(Math.max(bodies[1].obj.position.y, 0.2));
    }

    if (debrisAge >= 0) {
      debrisAge += sdt;
      const pos = debrisGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < DEBRIS; i++) {
        debrisVel[i * 3 + 1] -= GRAVITY * sdt;
        for (let k = 0; k < 3; k++) debrisPos[i * 3 + k] += debrisVel[i * 3 + k] * sdt;
        if (debrisPos[i * 3 + 1] < 0.004) {
          debrisPos[i * 3 + 1] = 0.004;
          debrisVel[i * 3] *= 0.6;
          debrisVel[i * 3 + 1] *= -0.2;
          debrisVel[i * 3 + 2] *= 0.6;
        }
      }
      pos.needsUpdate = true;
      debrisMat.opacity = Math.max(0, 1 - debrisAge / 1.6);
    }

    if (sparkAge >= 0) {
      sparkAge += sdt;
      // Sparks float and slow rather than fall like clay: light drag, light
      // gravity, so in slow motion they hang round the wicket as a starburst.
      const drag = Math.exp(-2.4 * sdt);
      for (let i = 0; i < SPARKS; i++) {
        sparkVel[i * 3] *= drag;
        sparkVel[i * 3 + 1] = sparkVel[i * 3 + 1] * drag - 2.2 * sdt;
        sparkVel[i * 3 + 2] *= drag;
        for (let k = 0; k < 3; k++) sparkPos[i * 3 + k] += sparkVel[i * 3 + k] * sdt;
      }
      (sparkGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      // The delivery opening has its own sparks; this burst only lights them.
      sparkMat.opacity = strikeSparks ? 0 : Math.max(0, 1 - sparkAge / 1.4);
      // The delivery opening's light follows its flash, in real time; the
      // stumps would otherwise glow on through the slow motion.
      burstLight.intensity = strikeSparks ? 1.4 * strikeSparks.flash() : burstPeak * Math.max(0, 1 - sparkAge / 0.5);
    }

    // Camera: the tweened shot, a decaying shake, and the slow drift round the ground.
    driftAngle += dt * 0.035 * state.drift;
    p.set(state.cam.x, state.cam.y, state.cam.z);
    look.set(state.look.x, state.look.y, state.look.z);
    if (cast) {
      p.addScaledVector(ball.position, state.camFrom.ball);
      look.addScaledVector(ball.position, state.lookFrom.ball);

      // The key light's shadow follows the action: the far wicket, then the
      // ball down the pitch, then the wicket it breaks.
      if (key.castShadow) {
        if (struckClip >= 0 || drop || state.clip >= DELIVERY.strike) focus.set(0, 0, -1);
        else if (state.clip >= DELIVERY.release) focus.set(ball.position.x, 0, Math.min(ball.position.z, -1));
        else focus.set(0, 0, -PITCH_LENGTH + 1);
        key.position.copy(focus).add(KEY_OFFSET);
        key.target.position.copy(focus);
        key.target.updateMatrixWorld();
      }
    }
    if (driftAngle !== 0) {
      p.sub(pivot).applyAxisAngle(UP, driftAngle).add(pivot);
      look.sub(pivot).applyAxisAngle(UP, driftAngle).add(pivot);
    }
    if (state.shake > 0) {
      const t = performance.now() / 1000;
      const k = state.shake * state.shake * 0.05;
      p.x += Math.sin(t * 71.3) * k;
      p.y += Math.sin(t * 89.1 + 1.3) * k;
      look.x += Math.sin(t * 53.7 + 2.1) * k * 0.6;
    }
    camera.position.copy(p);
    camera.lookAt(look);

    if (cast) {
      camera.updateMatrixWorld();
      if (drop) placeDrop(dt);
      // Keep a ball far from the lens a few pixels wide, with a soft halo, so
      // the climb reads as a bright point rather than vanishing.
      if (ball.visible) {
        const dist = Math.max(0.01, camera.position.distanceTo(ball.position));
        const pxPerM = height / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        const px = ((BALL_RADIUS * ballScale) / dist) * pxPerM;
        if (!drop && px < 2.2) ballScale *= 2.2 / px;
        ball.scale.setScalar(ballScale);
        if (!drop) streak.scale.x = streak.scale.z = ballScale;
        const climbing = struckClip >= 0 && !drop;
        ballGlow.visible = state.clip >= DELIVERY.release || !!drop;
        ballGlow.position.copy(ball.position);
        ballGlow.scale.setScalar(BALL_RADIUS * ballScale * (climbing ? 16 : 7));
        // Close to the lens the halo only hides the leather and the seam.
        const near = THREE.MathUtils.smoothstep(dist, 1.6, 5);
        (ballGlow.material as THREE.SpriteMaterial).opacity = climbing ? 0.55 : 0.28 * near;
        if (!drop && struckClip < 0) streakMat.uniforms.uOpacity.value = 0.9 * (0.45 + 0.55 * near);
      } else ballGlow.visible = false;
      // The puff where it pitched.
      const sincePitch = state.clip - (DELIVERY.release + BOUNCE_AT * DELIVERY.flight);
      if (sincePitch >= 0 && sincePitch < 1.1 && !drop) {
        const drag = (1 - Math.exp(-3 * sincePitch)) / 3;
        for (let i = 0; i < PUFF; i++) {
          puffPos[i * 3] = BOUNCE.x + puffVel[i * 3] * drag;
          puffPos[i * 3 + 1] = BOUNCE.y + Math.max(0, puffVel[i * 3 + 1] * drag - 0.9 * sincePitch * sincePitch);
          puffPos[i * 3 + 2] = BOUNCE.z + puffVel[i * 3 + 2] * drag;
        }
        (puffGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        // Soft and billowing: big, faint sprites that spread as they fade.
        puffMat.opacity = 0.85 * Math.pow(1 - sincePitch / 1.1, 1.3);
        puffMat.size = 0.2 + sincePitch * 0.5;
        puff.visible = true;
      } else puff.visible = false;

      // Remember where the climbing ball leaves the frame: it comes back down
      // from there onto the trophy.
      if (struckClip >= 0 && !drop && ball.visible) {
        ndc.copy(ball.position).project(camera);
        if (Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z < 1) lastSeen = new THREE.Vector2(ndc.x, ndc.y);
      }

      // The climb's trail: the last half second of the arc, facing the lens.
      if (struckClip >= 0 && !drop && state.ballOn > 0.5) {
        const tau = state.clip - struckClip;
        const w = BALL_RADIUS * ballScale * 1.25;
        for (let i = 0; i < TRAIL; i++) {
          risePoint(Math.max(0, tau - i * 0.018), trailA);
          risePoint(Math.max(0, tau - i * 0.018 - 0.01), trailB);
          trailB.subVectors(trailA, trailB);
          ray.subVectors(trailA, camera.position);
          trailB.cross(ray).normalize().multiplyScalar(w * (1 - (i / TRAIL) * 0.85));
          trailPos.set([trailA.x + trailB.x, trailA.y + trailB.y, trailA.z + trailB.z, trailA.x - trailB.x, trailA.y - trailB.y, trailA.z - trailB.z], i * 6);
        }
        (trailGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        // Only once the ball is away from the lens: up close a ribbon of light
        // that wide is a beam across the frame, not a trail.
        const away = camera.position.distanceTo(trailA.copy(ball.position));
        trailMat.opacity = THREE.MathUtils.smoothstep(away, 6, 16) * 0.85;
        trail.visible = tau > 0.02 && trailMat.opacity > 0.01;
        // The streak too: right by the lens it would be a bar across the frame.
        streakMat.uniforms.uOpacity.value = 0.9 * THREE.MathUtils.smoothstep(away, 3, 9);
      } else {
        trail.visible = false;
        streakMat.uniforms.uOpacity.value = 0.9;
      }
      // The glint marks both ends of the ball's flight: its launch from the
      // far crease and the top of its climb.
      if (state.glint > 0.001) {
        const dist = camera.position.distanceTo(p);
        star.visible = true;
        star.position.copy(p);
        // Bigger at the launch: the far crease is a long way off, and the star
        // is the only thing announcing the ball.
        const size = state.clip < DELIVERY.release + 0.2 ? 0.34 : 0.16;
        star.scale.setScalar(dist * size * (0.4 + 0.6 * state.glint));
        starMat.opacity = Math.min(1, state.glint * 1.4);
        starMat.rotation = 0.35 * state.glint;
      } else star.visible = false;
      strikeSparks?.update(sdt, dt, camera);
    }

    composer.render(dt);
    frames++;
    if (first) {
      first = false;
      onReady?.();
    }
  }

  // Stop drawing when the tab is in the background.
  const visibility = () => {
    if (document.visibilityState === "visible" && !frame && live) {
      clock.getDelta();
      tick();
    } else if (document.visibilityState !== "visible" && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
  document.addEventListener("visibilitychange", visibility);
  tick();

  /* ---- the strike ---- */
  function strike() {
    if (struckAt >= 0) return;
    struckAt = simTime;
    const [off, middle, leg] = bodies;
    // Middle stump takes the ball: back hard, and cartwheeling.
    middle.v.set(0.15, 1.9, 6.2);
    middle.w.set(15, 2.5, 1.2);
    off.v.set(-1.25, 1.35, 3.6);
    off.w.set(9.5, -1.0, 5.2);
    leg.v.set(1.15, 1.1, 3.1);
    leg.w.set(8.5, 2.0, -5.6);
    const [bailA, bailB] = [bodies[3], bodies[4]];
    bailA.v.set(-1.6, 4.4, 4.6);
    bailA.w.set(6, 22, 14);
    bailB.v.set(1.7, 4.9, 5.4);
    bailB.w.set(-9, -18, 16);
    for (const b of bodies) b.live = true;

    if (cast) {
      // The ball does not fall with the pieces: it climbs out of the ground.
      struckClip = DELIVERY.strike;
    } else {
      ball.position.copy(IMPACT);
      ballBody.v.set(0.5, 1.4, 8.4);
      ballBody.live = true;
    }

    const rand = rng(Math.floor(performance.now()));
    for (let i = 0; i < DEBRIS; i++) {
      debrisPos[i * 3] = IMPACT.x + (rand() - 0.5) * 0.08;
      debrisPos[i * 3 + 1] = rand() < 0.5 ? 0.02 : IMPACT.y + (rand() - 0.5) * 0.1;
      debrisPos[i * 3 + 2] = IMPACT.z + (rand() - 0.5) * 0.06;
      const sp = 1.5 + rand() * 4.5;
      const th = rand() * Math.PI * 2;
      debrisVel[i * 3] = Math.cos(th) * sp * 0.6;
      debrisVel[i * 3 + 1] = 1 + rand() * 4;
      debrisVel[i * 3 + 2] = Math.abs(Math.sin(th)) * sp * 0.9 + 0.6;
    }
    debrisAge = 0;
    debrisMat.opacity = 1;

    if (strikeSparks) strikeSparks.burst(IMPACT, new THREE.Vector3(0, 0.15, 1));
    if (sparksOn) {
      for (let i = 0; i < SPARKS; i++) {
        sparkPos.set([IMPACT.x, IMPACT.y, IMPACT.z], i * 3);
        // A sphere of directions, biased back and up: the burst follows the ball.
        const u = rand() * 2 - 1;
        const th = rand() * Math.PI * 2;
        const r = Math.sqrt(1 - u * u);
        const sp = 2.5 + rand() * 7.5;
        sparkVel[i * 3] = r * Math.cos(th) * sp;
        sparkVel[i * 3 + 1] = Math.abs(u) * sp * 0.9 + 0.8;
        sparkVel[i * 3 + 2] = r * Math.sin(th) * sp + 1.5;
      }
      (sparkGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      sparkAge = 0;
      sparkMat.opacity = 1;
    }
  }

  function reset() {
    struckAt = -1;
    struckClip = -1;
    drop = null;
    lastSeen = null;
    puff.visible = false;
    strikeSparks?.reset();
    ballGlow.visible = false;
    trail.visible = false;
    ball.scale.setScalar(1);
    debrisAge = -1;
    debrisMat.opacity = 0;
    driftAngle = 0;
    for (const b of [...bodies, ballBody]) {
      b.live = false;
      b.v.set(0, 0, 0);
      b.w.set(0, 0, 0);
      b.obj.position.copy(b.home.p);
      b.obj.quaternion.copy(b.home.q);
    }
    ledMat.emissiveIntensity = 0;
    zingLight.intensity = 0;
    sparkAge = -1;
    sparkMat.opacity = 0;
    burstLight.intensity = 0;
  }

  function dispose() {
    cancelAnimationFrame(frame);
    frame = 0;
    document.removeEventListener("visibilitychange", visibility);
    ro.disconnect();
    for (const d of disposables) d.dispose();
    lamps.dispose();
    smaa?.dispose();
    composer.dispose();
    bloom.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  const debug = () => ({
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    frames,
    internals: { renderer, scene, camera, composer },
  });

  const advance = (dt: number) => {
    cancelAnimationFrame(frame);
    frame = 0;
    document.removeEventListener("visibilitychange", visibility);
    draw(dt);
  };

  const setLive = (on: boolean) => {
    live = on;
    if (!on) {
      cancelAnimationFrame(frame);
      frame = 0;
      draw(0);
    } else if (!frame && document.visibilityState === "visible") {
      clock.getDelta();
      tick();
    }
  };

  return { state, strike, reset, dispose, debug, advance, setLive, setTeamColors, dropBall };
}
