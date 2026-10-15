/**
 * strikeSparks.ts
 * The burst when the ball hits the stumps, for the delivery opening.
 *
 * A spark, not a firework: one hard flash where the ball meets the stumps,
 * and a small spit of short-lived sparks off the point of contact, each a
 * hot head and a short streak, cooling from white to orange as it dies in a
 * fraction of a second. With them, a ring of dust blown out across the clay
 * at the foot of the stumps.
 *
 * Integrated in the film's own time (`sdt`), so in the slow motion after the
 * strike they hang and drift, then fall when time comes back up.
 */
import * as THREE from "three";

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

const HEAD_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uScale;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(1.5, aSize * uScale / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const HEAD_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vColor * a * a, a);
  }
`;

/** Heat to colour: white-hot, yellow, orange, cooling red, gone. */
function heat(t: number, out: THREE.Color) {
  // t: 0 just struck .. 1 cold.
  if (t < 0.08) return out.setRGB(1, 0.92, 0.75).lerp(new THREE.Color(1, 0.74, 0.32), t / 0.08);
  if (t < 0.4) return out.setRGB(1, 0.74, 0.32).lerp(new THREE.Color(1, 0.4, 0.08), (t - 0.08) / 0.32);
  return out.setRGB(1, 0.4, 0.08).lerp(new THREE.Color(0.45, 0.07, 0.02), Math.min(1, (t - 0.4) / 0.6));
}

export interface StrikeSparks {
  group: THREE.Group;
  /** Set it off at `at`, the ball travelling along `dir`. */
  burst(at: THREE.Vector3, dir: THREE.Vector3): void;
  /**
   * Advance the sparks by `sdt` seconds of film time and the flash by `dt`
   * seconds of real time: a flash is a moment of light, not a thing that
   * hangs in the slow motion. `camera` sizes it.
   */
  update(sdt: number, dt: number, camera: THREE.Camera): void;
  /** 0..1, how bright the flash is now: the scene's impact light follows it. */
  flash(): number;
  /** Point sizes are in metres: give them the frame's pixel scale. */
  resize(bufferHeight: number, fovDeg: number): void;
  reset(): void;
  dispose(): void;
}

export function createStrikeSparks(tier: 1 | 2 | 3, glow: THREE.Texture, star: THREE.Texture): StrikeSparks {
  const N = tier === 1 ? 18 : tier === 2 ? 28 : 36;
  const group = new THREE.Group();
  const pos = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  const life = new Float32Array(N);
  const size = new Float32Array(N);
  const col = new Float32Array(N * 3);
  const linePos = new Float32Array(N * 6);
  const lineCol = new Float32Array(N * 6);
  let age = -1;
  let flashAge = -1;

  const headGeo = new THREE.BufferGeometry();
  headGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  headGeo.setAttribute("aColor", new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  headGeo.setAttribute("aSize", new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const headMat = new THREE.ShaderMaterial({
    vertexShader: HEAD_VERT,
    fragmentShader: HEAD_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: 400 } },
  });
  const heads = new THREE.Points(headGeo, headMat);
  heads.frustumCulled = false;

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
  lineGeo.setAttribute("color", new THREE.BufferAttribute(lineCol, 3).setUsage(THREE.DynamicDrawUsage));
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const streaks = new THREE.LineSegments(lineGeo, lineMat);
  streaks.frustumCulled = false;

  // The flare at the point of impact.
  const flareMat = new THREE.SpriteMaterial({
    map: star,
    color: new THREE.Color(1.5, 1.3, 1.0),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const flare = new THREE.Sprite(flareMat);
  const coreMat = new THREE.SpriteMaterial({
    map: glow,
    color: new THREE.Color(1.6, 1.25, 0.8),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const core = new THREE.Sprite(coreMat);

  // Dust blown out across the clay.
  const ringTex = (() => {
    const S = 256;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.28, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(214,190,140,0)");
    g.addColorStop(0.55, "rgba(214,190,140,0.75)");
    g.addColorStop(1, "rgba(214,190,140,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return new THREE.CanvasTexture(c);
  })();
  const ringMat = new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, opacity: 0, depthWrite: false });
  const ringGeo = new THREE.PlaneGeometry(1, 1);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.renderOrder = 2;

  group.add(streaks, heads, core, flare, ring);
  group.visible = false;

  const c = new THREE.Color();
  const origin = new THREE.Vector3();

  function burst(at: THREE.Vector3, dir: THREE.Vector3) {
    const rand = rng(77);
    origin.copy(at);
    const fwd = dir.clone().normalize();
    for (let i = 0; i < N; i++) {
      // A tight spit off the point of contact: out to the sides and on with
      // the ball, barely rising.
      const th = rand() * Math.PI * 2;
      const v = new THREE.Vector3(Math.cos(th), 0.15 + rand() * 0.45, Math.sin(th) * 0.5)
        .addScaledVector(fwd, 0.5 + rand() * 0.6)
        .normalize()
        .multiplyScalar(1.2 + Math.pow(rand(), 1.4) * 3.6);
      vel.set([v.x, v.y, v.z], i * 3);
      pos.set([at.x + (rand() - 0.5) * 0.02, at.y + (rand() - 0.5) * 0.03, at.z], i * 3);
      life[i] = 0.08 + rand() * 0.16;
    }
    age = 0;
    flashAge = 0;
    group.visible = true;
  }

  function update(sdt: number, dt: number, camera: THREE.Camera) {
    if (age < 0) return;
    age += sdt;
    flashAge += dt;
    const g = 9.8;
    const drag = Math.exp(-1.4 * sdt);
    let alive = 0;
    for (let i = 0; i < N; i++) {
      const k = i * 3;
      const t = age / life[i];
      if (t >= 1) {
        size[i] = 0;
        col.set([0, 0, 0], k);
        linePos.set([0, -10, 0, 0, -10, 0], i * 6);
        lineCol.set([0, 0, 0, 0, 0, 0], i * 6);
        continue;
      }
      alive++;
      vel[k] *= drag;
      vel[k + 1] = vel[k + 1] * drag - g * sdt;
      vel[k + 2] *= drag;
      pos[k] += vel[k] * sdt;
      pos[k + 1] += vel[k + 1] * sdt;
      pos[k + 2] += vel[k + 2] * sdt;
      // Skitter along the clay.
      if (pos[k + 1] < 0.01) {
        pos[k + 1] = 0.01;
        vel[k + 1] = Math.abs(vel[k + 1]) * 0.32;
        vel[k] *= 0.65;
        vel[k + 2] *= 0.65;
      }
      heat(t, c);
      const bright = (1 - t) * (t < 0.08 ? 2.2 : 1.6);
      col.set([c.r * bright, c.g * bright, c.b * bright], k);
      size[i] = 0.028 * (1 - t * 0.6);
      // The streak: from the head back along the velocity.
      const len = 0.03;
      linePos.set(
        [pos[k], pos[k + 1], pos[k + 2], pos[k] - vel[k] * len, pos[k + 1] - vel[k + 1] * len, pos[k + 2] - vel[k + 2] * len],
        i * 6,
      );
      lineCol.set([c.r * bright, c.g * bright, c.b * bright, c.r * bright * 0.05, c.g * bright * 0.03, 0], i * 6);
    }
    for (const a of [headGeo.attributes.position, headGeo.attributes.aColor, headGeo.attributes.aSize, lineGeo.attributes.position, lineGeo.attributes.color])
      (a as THREE.BufferAttribute).needsUpdate = true;

    // The flash of contact: a hard pop, gone in a fifth of a second of real
    // time however slow the film is running.
    const f = Math.max(0, 1 - flashAge / 0.2);
    const dist = camera.position.distanceTo(origin);
    flare.position.copy(origin);
    core.position.copy(origin);
    flare.scale.setScalar(dist * 0.16 * (0.6 + 0.4 * f));
    core.scale.setScalar(0.3 + 0.35 * (1 - f));
    flareMat.opacity = f * f * 0.85;
    flareMat.rotation = 0.4 + flashAge * 0.6;
    coreMat.opacity = Math.max(0, 1 - flashAge / 0.25) * 0.5;

    // The dust ring, spreading and thinning.
    const r = Math.min(1, age / 0.9);
    ring.position.set(origin.x, 0.012, origin.z - 0.02);
    ring.scale.setScalar(0.25 + 1.9 * (1 - Math.pow(1 - r, 2)));
    ringMat.opacity = 0.55 * Math.pow(1 - r, 1.4);

    if (!alive && age > 1 && flashAge > 0.3) {
      age = -1;
      group.visible = false;
    }
  }

  return {
    group,
    burst,
    update,
    flash: () => (flashAge < 0 ? 0 : Math.max(0, 1 - flashAge / 0.3)),
    resize(bufferHeight, fovDeg) {
      headMat.uniforms.uScale.value = bufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
    },
    reset() {
      age = -1;
      flashAge = -1;
      group.visible = false;
    },
    dispose() {
      for (const d of [headGeo, headMat, lineGeo, lineMat, flareMat, coreMat, ringTex, ringMat, ringGeo]) d.dispose();
    },
  };
}
