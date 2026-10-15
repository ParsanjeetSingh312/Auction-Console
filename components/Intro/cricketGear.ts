/**
 * cricketGear.ts
 * The delivery opening's match ball, stumps and bails, modelled close up:
 * the camera holds on the ball while it hangs in the air and drives in on the
 * wicket as it breaks, so neither can be a plain sphere and a plain rod.
 *
 * - **The ball**: white leather, varnished, with a fine grain; an upright
 *   seam with a dark centre line, a raised ridge either side and a braided
 *   row of stitches on each, laid in a herringbone, and the small dark
 *   thread ticks outside them where the needle went through.
 * - **The stumps**: pale ash with a running grain, a fully rounded top and
 *   the spike that goes into the ground.
 * - **The bails**: turned: a long spigot, a barrel with its rings, a short
 *   spigot, lathed from one profile.
 *
 * Everything is procedural (canvas textures, lathed and instanced geometry),
 * seeded, and sized in metres to the Laws.
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

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  return { c, ctx };
}

/* ------------------------------------------------------------------ ball -- */

/** Leather grain: a fine, even pebble for the bump map. */
function leatherGrain() {
  const W = 512;
  const H = 256;
  const { c, ctx } = canvas(W, H);
  const rand = rng(211);
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) {
    const v = 110 + Math.floor(rand() * 60);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.beginPath();
    ctx.arc(rand() * W, rand() * H, 0.6 + rand() * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  return tex;
}

export interface MatchBall {
  group: THREE.Group;
  /** The leather, for lighting it from within when the scene needs to. */
  leather: THREE.MeshPhysicalMaterial;
  dispose(): void;
}

/**
 * A white ball of radius `r`, seam upright in the plane normal to local x
 * (the axis a back-spinning delivery turns about).
 */
export function createMatchBall(r: number, tier: 1 | 2 | 3): MatchBall {
  const keep: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(x: T) => {
    keep.push(x);
    return x;
  };
  const group = new THREE.Group();

  const grain = track(leatherGrain());
  const leather = track(
    new THREE.MeshPhysicalMaterial({
      color: "#ecebe3",
      roughness: 0.46,
      clearcoat: 0.45,
      clearcoatRoughness: 0.3,
      bumpMap: grain,
      bumpScale: 0.6,
      emissive: "#ffffff",
      emissiveIntensity: 0.05,
    }),
  );
  group.add(new THREE.Mesh(track(new THREE.SphereGeometry(r, 48, 32)), leather));

  // The seam: everything below is laid round the circle x = 0.
  const thread = track(new THREE.MeshStandardMaterial({ color: "#eeeadd", roughness: 0.55 }));
  const ridgeMat = track(new THREE.MeshStandardMaterial({ color: "#efebe0", roughness: 0.5 }));
  const lineMat = track(new THREE.MeshStandardMaterial({ color: "#5d5850", roughness: 0.7 }));
  const tickMat = track(new THREE.MeshStandardMaterial({ color: "#22201d", roughness: 0.8 }));

  const ring = (major: number, tube: number, offset: number, mat: THREE.Material) => {
    const geo = track(new THREE.TorusGeometry(major, tube, 6, 96));
    geo.rotateY(Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.x = offset;
    group.add(m);
  };
  const along = (dx: number) => Math.sqrt(Math.max(0, r * r - dx * dx));
  // The centre line, sunk between the two ridges.
  ring(r * 1.0, r * 0.012, 0, lineMat);
  // The two raised ridges the stitches sit on.
  for (const s of [-1, 1]) ring(along(s * r * 0.075) * 1.001, r * 0.045, s * r * 0.075, ridgeMat);

  // The braided stitch rows, one either side, in a herringbone.
  const per = tier === 1 ? 44 : 72;
  const beadGeo = track(new THREE.SphereGeometry(1, 8, 6));
  const beads = new THREE.InstancedMesh(beadGeo, thread, per * 2);
  const ticks = new THREE.InstancedMesh(track(new THREE.CapsuleGeometry(1, 2, 2, 6)), tickMat, per * 2);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const side = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  let bi = 0;
  let ti = 0;
  for (const s of [-1, 1]) {
    for (let i = 0; i < per; i++) {
      const th = (i / per) * Math.PI * 2;
      // A bead on the ridge: long axis tilted across the seam, mirrored
      // from one row to the other, so the pair reads as a plait.
      const dx = s * r * 0.075;
      const rr = along(dx) * 1.04;
      p.set(dx, Math.cos(th) * rr, Math.sin(th) * rr);
      nrm.copy(p).normalize();
      tan.set(0, -Math.sin(th), Math.cos(th));
      side.set(1, 0, 0);
      const tilt = THREE.MathUtils.degToRad(38) * s;
      axis.copy(tan).multiplyScalar(Math.cos(tilt)).addScaledVector(side, Math.sin(tilt)).normalize();
      const third = new THREE.Vector3().crossVectors(axis, nrm).normalize();
      basis.makeBasis(axis, nrm, third);
      q.setFromRotationMatrix(basis);
      sc.set(r * 0.072, r * 0.03, r * 0.034);
      m.compose(p, q, sc);
      beads.setMatrixAt(bi++, m);

      // A thread tick just outside the ridge, across the seam.
      const tx = s * r * 0.15;
      const tr = along(tx) * 1.002;
      const th2 = th + Math.PI / per;
      p.set(tx, Math.cos(th2) * tr, Math.sin(th2) * tr);
      nrm.copy(p).normalize();
      // Capsule long axis is local y: lay it across the seam (along x).
      side.set(1, 0, 0).addScaledVector(nrm, -nrm.x).normalize();
      tan.crossVectors(nrm, side);
      basis.makeBasis(nrm, side, tan);
      q.setFromRotationMatrix(basis);
      sc.set(r * 0.008, r * 0.012, r * 0.008);
      m.compose(p, q, sc);
      ticks.setMatrixAt(ti++, m);
    }
  }
  beads.instanceMatrix.needsUpdate = true;
  ticks.instanceMatrix.needsUpdate = true;
  group.add(beads, ticks);
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });

  return {
    group,
    leather,
    dispose() {
      for (const d of keep) d.dispose();
      beads.dispose();
      ticks.dispose();
    },
  };
}

/* ---------------------------------------------------------------- wicket -- */

/** Pale ash, the grain running the length of the stump. */
function woodGrain() {
  const W = 128;
  const H = 1024;
  const { c, ctx } = canvas(W, H);
  const rand = rng(97);
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, "#e2c4aa");
  g.addColorStop(0.5, "#ecd2bb");
  g.addColorStop(1, "#e0c1a6");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 70; i++) {
    const x = rand() * W;
    const w = 0.5 + rand() * 2.2;
    const a = 0.05 + rand() * 0.12;
    ctx.fillStyle = rand() < 0.6 ? `rgba(150,100,70,${a})` : `rgba(255,240,225,${a})`;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    for (let y = 0; y <= H; y += 32) ctx.lineTo(x + Math.sin(y * 0.01 + i) * 2.5, y);
    ctx.lineTo(x + w, H);
    for (let y = H; y >= 0; y -= 32) ctx.lineTo(x + w + Math.sin(y * 0.01 + i) * 2.5, y);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export interface WoodenWicket {
  /** One stump, centred on its middle, top up: shaft, rounded top, spike. */
  stump(): THREE.Group;
  /** One bail, lying along x, centred. */
  bail(): THREE.Mesh;
  dispose(): void;
}

export function createWoodenWicket(height: number, radius: number): WoodenWicket {
  const keep: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(x: T) => {
    keep.push(x);
    return x;
  };
  const grain = track(woodGrain());
  // Varnished: a soft clearcoat over the wood.
  const wood = track(
    new THREE.MeshPhysicalMaterial({ map: grain, roughness: 0.52, clearcoat: 0.35, clearcoatRoughness: 0.45 }),
  );

  const top = radius; // the dome
  const shaftGeo = track(new THREE.CylinderGeometry(radius, radius, height - top, 28, 1, true));
  shaftGeo.translate(0, -top / 2, 0);
  const domeGeo = track(new THREE.SphereGeometry(radius, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2));
  domeGeo.translate(0, height / 2 - top, 0);
  const spikeGeo = track(new THREE.ConeGeometry(radius * 0.95, 0.14, 20));
  spikeGeo.rotateX(Math.PI);
  spikeGeo.translate(0, -height / 2 - 0.07, 0);

  // The bail, turned: long spigot, ringed barrel, short spigot.
  const L = 0.11;
  const pts: THREE.Vector2[] = [];
  const push = (rr: number, y: number) => pts.push(new THREE.Vector2(rr, y - L / 2));
  push(0, 0);
  push(0.0036, 0.0005);
  push(0.0042, 0.003);
  push(0.0042, 0.028); // long spigot
  push(0.0056, 0.031);
  const b0 = 0.034;
  const b1 = 0.084;
  for (let k = 0; k <= 60; k++) {
    const y = b0 + ((b1 - b0) * k) / 60;
    const ends = Math.min(1, (y - b0) / 0.003, (b1 - y) / 0.003);
    const rings = 0.0074 + 0.00075 * Math.cos(((y - b0) / (b1 - b0)) * Math.PI * 2 * 5);
    push(0.0058 + (rings - 0.0058) * Math.max(0, ends), y);
  }
  push(0.0052, 0.087);
  push(0.004, 0.09);
  push(0.004, 0.1075); // short spigot
  push(0.0032, 0.1095);
  push(0, L);
  const bailGeo = track(new THREE.LatheGeometry(pts, 20));
  bailGeo.rotateZ(Math.PI / 2);

  return {
    stump() {
      const g = new THREE.Group();
      for (const geo of [shaftGeo, domeGeo, spikeGeo]) {
        const m = new THREE.Mesh(geo, wood);
        m.castShadow = true;
        g.add(m);
      }
      return g;
    },
    bail() {
      const m = new THREE.Mesh(bailGeo, wood);
      m.castShadow = true;
      return m;
    },
    dispose() {
      for (const d of keep) d.dispose();
    },
  };
}
