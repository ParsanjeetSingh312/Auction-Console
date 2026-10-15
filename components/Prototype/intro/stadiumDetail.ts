/**
 * stadiumDetail.ts
 * The finish on the opening's stadium: what makes a lathed bowl read as a
 * built ground at night.
 *
 * - **The stands' surface**: seat rows, aisles and stairs, the concourse, the
 *   lit entrances (vomitories) into the upper tier, the back wall's lamps.
 *   One canvas texture laid on the existing lathe, band by band.
 * - **LED edge strips** along the pitch-side wall, both edges of the
 *   concourse ribbon and the front of every roof.
 * - **The roofs from below**: cantilever trusses and a row of downlights.
 * - **Sightscreens** at both ends, black, as at a T20 game under lights.
 * - **The lighting**: anamorphic glare on each lamp bank, a pool of light on
 *   the middle of the field, the outfield falling off towards the rope.
 *
 * All of it is static after it is built: nothing here costs anything per
 * frame beyond being drawn.
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

/**
 * The stands, unwrapped onto the lathe: u runs round the ground (the tile
 * repeats), v runs up the profile one band per profile segment, in order —
 * pitch wall, lower tier, concourse floor, concourse wall, upper tier,
 * walkway, back wall.
 */
export function standTexture(bands: number) {
  /*
    Prototype: the spectators are painted into the seats rather than
    scattered over them as coloured points. At 2-4cm a pixel a seat is about
    20px, enough for a head and a pair of shoulders, which is all a broadcast
    lens resolves of a crowd 80m away. Drawn back row first, so every row's
    heads overlap the seat backs behind them, as they do.
  */
  const W = 1024;
  const BAND = 256;
  const H = BAND * bands;
  const { c, ctx } = canvas(W, H);
  const rand = rng(61);
  // Canvas y runs down; v runs up. Band j fills rows top..bottom.
  const band = (j: number) => ({ top: H - (j + 1) * BAND, bottom: H - j * BAND });

  ctx.fillStyle = "#121620";
  ctx.fillRect(0, 0, W, H);

  // Franchise blocks, desaturated the way cloth reads under metal halide.
  const shirts = ["#2a56b0", "#d9b02c", "#c8372f", "#5a3290", "#e0702a", "#2f8fcf", "#c9ccd2", "#1d2f60", "#c54a7c", "#2e7d4f"];
  const skins = ["#5a3b2a", "#6e4a33", "#84593d", "#9b6c4b", "#4a3022", "#b07e5c"];
  const hairs = ["#121010", "#1c1612", "#2a211a", "#0d0d0f"];
  const shade = (hex: string, k: number) => {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const l = 0.3 * r + 0.59 * g + 0.11 * b;
    // A third of the way to grey, then dimmed by the row's distance from the light.
    const d = (x: number) => Math.min(255, Math.round((x + (l - x) * 0.5) * k * 0.86));
    return `rgb(${d(r)},${d(g)},${d(b)})`;
  };

  const crowd = (j: number, rows: number, seatW: number, aisles: number, light: (u: number) => number) => {
    const { top, bottom } = band(j);
    const h = (bottom - top) / rows;
    const aisleAt = (x: number) => {
      for (let a = 0; a < aisles; a++) {
        const ax = (W / aisles) * a + W / aisles / 2;
        if (Math.abs(x - ax) < seatW * 0.9) return true;
      }
      return false;
    };
    for (let r = 0; r < rows; r++) {
      const y = top + r * h;
      // r = 0 is the back row (highest); the front row is nearest the light.
      const k = light(r / (rows - 1));
      ctx.fillStyle = shade("#1e2533", k);
      ctx.fillRect(0, y, W, h);
      ctx.fillStyle = shade("#2a3346", k);
      ctx.fillRect(0, y + h * 0.5, W, h * 0.22);
      for (let x = (r % 2) * seatW * 0.5; x < W; x += seatW) {
        if (aisleAt(x + seatW / 2)) continue;
        if (rand() < 0.07) continue; // an empty seat
        // Supporters sit together, but loosely: a lean towards one shirt per
        // stretch, never a printed block (the tile repeats round the ground,
        // and hard blocks read as stripes from the far end).
        const block = Math.floor((x / W) * 3 + Math.sin(r * 0.7 + j) * 0.6);
        const shirt = rand() < 0.3 ? shirts[Math.abs(block * 3 + j) % shirts.length] : shirts[Math.floor(rand() * shirts.length)];
        const cx = x + seatW / 2 + (rand() - 0.5) * seatW * 0.18;
        const lift = rand() < 0.05 ? h * 0.55 : 0; // on their feet
        // Shoulders.
        const sw = seatW * (0.62 + rand() * 0.12);
        ctx.fillStyle = shade(shirt, k * (0.8 + rand() * 0.25));
        ctx.beginPath();
        ctx.roundRect(cx - sw / 2, y + h * 0.42 - lift, sw, h * 0.62 + lift, [sw * 0.35, sw * 0.35, 1, 1]);
        ctx.fill();
        // A head, lit from above: the crown darker with hair.
        const hr = seatW * (0.17 + rand() * 0.03);
        const hy = y + h * 0.3 - lift;
        ctx.fillStyle = shade(skins[Math.floor(rand() * skins.length)], k);
        ctx.beginPath();
        ctx.arc(cx, hy, hr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = shade(hairs[Math.floor(rand() * hairs.length)], k);
        ctx.beginPath();
        ctx.arc(cx, hy - hr * 0.25, hr * 0.92, Math.PI, Math.PI * 2);
        ctx.fill();
        // Now and then an arm in the air.
        if (rand() < 0.035) {
          ctx.strokeStyle = shade(shirt, k);
          ctx.lineWidth = Math.max(1.5, seatW * 0.12);
          ctx.beginPath();
          ctx.moveTo(cx + sw * 0.4, y + h * 0.5 - lift);
          ctx.lineTo(cx + sw * 0.55, y - h * 0.35 - lift);
          ctx.stroke();
        }
      }
    }
    // Aisles: stairs, a lit nosing on every step.
    for (let a = 0; a < aisles; a++) {
      const x = (W / aisles) * a + W / aisles / 2;
      for (let r = 0; r < rows; r++) {
        const y = top + r * h;
        const k = light(r / (rows - 1));
        ctx.fillStyle = shade("#323a4a", k);
        ctx.fillRect(x - seatW * 0.6, y, seatW * 1.2, h);
        ctx.fillStyle = `rgba(255,236,200,${0.22 * k})`;
        ctx.fillRect(x - seatW * 0.6, y + h - 1, seatW * 1.2, 1);
      }
    }
  };

  // 0: pitch-side wall, with a painted trim and expansion joints.
  {
    const { top, bottom } = band(0);
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, "#1a2133");
    g.addColorStop(1, "#0b0f18");
    ctx.fillStyle = g;
    ctx.fillRect(0, top, W, bottom - top);
    ctx.fillStyle = "#2c3a62";
    ctx.fillRect(0, top, W, 10);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    for (let x = 0; x < W; x += 128) ctx.fillRect(x, top, 2, bottom - top);
  }
  // 1: lower tier, nearest the floods: brightest at the front.
  crowd(1, 22, 24, 4, (u) => 0.62 + 0.38 * u);
  // 2: concourse floor.
  {
    const { top, bottom } = band(2);
    ctx.fillStyle = "#262b35";
    ctx.fillRect(0, top, W, bottom - top);
  }
  // 3: concourse wall (the ribbon board covers most of it).
  {
    const { top, bottom } = band(3);
    ctx.fillStyle = "#0a0e16";
    ctx.fillRect(0, top, W, bottom - top);
  }
  // 4: upper tier: further from the light, the back rows under the roof.
  crowd(4, 28, 20, 4, (u) => 0.3 + 0.42 * Math.pow(u, 0.8));
  {
    // Lit entrances along its foot.
    const { bottom } = band(4);
    for (let a = 0; a < 4; a++) {
      const x = (W / 4) * a + W / 4;
      const g = ctx.createLinearGradient(0, bottom - 40, 0, bottom);
      g.addColorStop(0, "rgba(255,214,150,0.0)");
      g.addColorStop(1, "rgba(255,214,150,0.7)");
      ctx.fillStyle = "#06080d";
      ctx.fillRect(x - 26, bottom - 44, 52, 44);
      ctx.fillStyle = g;
      ctx.fillRect(x - 21, bottom - 38, 42, 38);
    }
  }
  // 5: walkway.
  {
    const { top, bottom } = band(5);
    ctx.fillStyle = "#1d222c";
    ctx.fillRect(0, top, W, bottom - top);
  }
  // 6: back wall, with its lamps.
  {
    const { top, bottom } = band(6);
    ctx.fillStyle = "#080b11";
    ctx.fillRect(0, top, W, bottom - top);
    ctx.fillStyle = "rgba(220,228,255,0.6)";
    for (let x = 16; x < W; x += 64) ctx.fillRect(x, top + (bottom - top) * 0.3, 10, 4);
  }
  // Grime and unevenness, so no two tiles read as printed.
  for (let i = 0; i < 6000; i++) {
    ctx.fillStyle = rand() > 0.5 ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.05)";
    ctx.fillRect(rand() * W, rand() * H, 1 + rand() * 4, 1 + rand() * 2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  tex.repeat.set(24, 1);
  return tex;
}

/** A thin horizontal streak, the anamorphic glare a broadcast lens puts on a lamp. */
function streakTexture() {
  const W = 512;
  const H = 32;
  const { c, ctx } = canvas(W, H);
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  const v = ctx.createLinearGradient(0, 0, 0, H);
  v.addColorStop(0, "rgba(0,0,0,1)");
  v.addColorStop(0.5, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The sightscreen face: an LED wall switched to black for play, which is
 * never quite black: module seams, a faint raster and a sheen.
 */
function sightscreenTexture() {
  const W = 1024;
  const H = 360;
  const { c, ctx } = canvas(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#0b0e16");
  g.addColorStop(1, "#05070b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,0.025)";
  for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  for (let x = 0; x <= W; x += W / 10) ctx.fillRect(x - 1, 0, 2, H);
  for (let y = 0; y <= H; y += H / 4) ctx.fillRect(0, y - 1, W, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** A soft pool of light, brightest in the middle. */
function poolTexture() {
  const S = 256;
  const { c, ctx } = canvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

export interface StadiumDetailOptions {
  tier: 1 | 2 | 3;
  /** Middle of the ground. */
  centre: THREE.Vector3;
  /** Stand profile radii and heights, as lathed. */
  wall: { r: number; top: number };
  concourse: { r: number; bottom: number; top: number };
  roof: { front: number; frontY: number; back: number; backY: number };
  /** Bearings of the floodlight towers; the roofs sit between them. */
  towerAngles: number[];
  /** Roof arcs: start offset and span from each tower, in radians. */
  roofArc: { from: number; span: number };
  /** Each tower's lamp bank, world space. */
  lampHeads: THREE.Object3D[];
  /** The boundary radius, for the sightscreens. */
  boundary: number;
  glow: THREE.Texture;
}

export function createStadiumDetail(o: StadiumDetailOptions) {
  const keep: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(x: T) => {
    keep.push(x);
    return x;
  };
  const group = new THREE.Group();
  group.position.copy(o.centre);

  /* LED edge strips: cool white, bright enough to bloom a little. */
  const ledMat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 1.7, 2.1), toneMapped: true }));
  /** A ring of LED at radius r and height y; an arc from lathe bearing `start` if given. */
  const strip = (r: number, y: number, tube: number, arc = Math.PI * 2, start = 0) => {
    const geo = track(new THREE.TorusGeometry(r, tube, 4, Math.max(24, Math.round((arc / (Math.PI * 2)) * 256)), arc));
    geo.rotateX(Math.PI / 2);
    // Laid flat, the torus runs (cos t, 0, sin t); the lathe runs
    // (sin phi, 0, cos phi). Turn it so its arc covers start..start+arc.
    geo.rotateY(start + arc - Math.PI / 2);
    const m = new THREE.Mesh(geo, ledMat);
    m.position.y = y;
    group.add(m);
  };
  strip(o.wall.r - 0.05, o.wall.top, 0.05);
  strip(o.concourse.r - 0.15, o.concourse.bottom - 0.05, 0.06);
  strip(o.concourse.r - 0.15, o.concourse.top + 0.1, 0.06);

  /* The roofs: a lit front edge, trusses and downlights underneath. */
  const trussMat = track(new THREE.MeshStandardMaterial({ color: "#232b3a", roughness: 0.6, metalness: 0.5 }));
  const trussGeo = track(new THREE.BoxGeometry(0.5, 0.9, 1));
  const perRoof = o.tier === 1 ? 7 : 11;
  const truss = new THREE.InstancedMesh(trussGeo, trussMat, o.towerAngles.length * perRoof);
  const lightsPerRoof = o.tier === 1 ? 26 : 44;
  const downPos = new Float32Array(o.towerAngles.length * lightsPerRoof * 3);
  let ti = 0;
  let di = 0;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const s = new THREE.Vector3();
  const along = new THREE.Vector3();
  // Lathe bearings: x = sin(phi) r, z = cos(phi) r.
  const at = (phi: number, r: number, y: number, out: THREE.Vector3) => out.set(Math.sin(phi) * r, y, Math.cos(phi) * r);
  for (const tower of o.towerAngles) {
    const start = tower + o.roofArc.from;
    strip(o.roof.front - 0.2, o.roof.frontY - 0.15, 0.12, o.roofArc.span, start);
    for (let k = 0; k < perRoof; k++) {
      const phi = start + ((k + 0.5) / perRoof) * o.roofArc.span;
      at(phi, o.roof.back, o.roof.backY - 0.6, a);
      at(phi, o.roof.front + 0.6, o.roof.frontY - 0.7, b);
      mid.addVectors(a, b).multiplyScalar(0.5);
      along.subVectors(b, a);
      const len = along.length();
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), along.normalize());
      s.set(1, 1, len);
      m4.compose(mid, q, s);
      truss.setMatrixAt(ti++, m4);
    }
    for (let k = 0; k < lightsPerRoof; k++) {
      const phi = start + ((k + 0.5) / lightsPerRoof) * o.roofArc.span;
      at(phi, o.roof.front + 1.6, o.roof.frontY - 1.2, a);
      downPos.set([a.x, a.y, a.z], di++ * 3);
    }
  }
  truss.instanceMatrix.needsUpdate = true;
  group.add(truss);
  const downGeo = track(new THREE.BufferGeometry());
  downGeo.setAttribute("position", new THREE.BufferAttribute(downPos, 3));
  const down = new THREE.Points(
    downGeo,
    track(
      new THREE.PointsMaterial({
        map: o.glow,
        color: new THREE.Color(2.2, 2.1, 1.9),
        size: 1.6,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    ),
  );
  down.frustumCulled = false;
  group.add(down);

  /* Sightscreens, black, behind each bowler's arm, just inside the stands. */
  const screenMat = track(new THREE.MeshStandardMaterial({ map: track(sightscreenTexture()), roughness: 0.55, metalness: 0.1 }));
  const frameMat = track(new THREE.MeshStandardMaterial({ color: "#1b2233", roughness: 0.6, metalness: 0.4 }));
  for (const end of [1, -1]) {
    const scr = new THREE.Group();
    const panel = new THREE.Mesh(track(new THREE.BoxGeometry(20, 7, 0.35)), screenMat);
    panel.position.y = 3.5;
    // A thin LED trim along the top and foot of the screen.
    for (const ty of [7.02, 0.05]) {
      const trim = new THREE.Mesh(track(new THREE.BoxGeometry(20, 0.08, 0.05)), ledMat);
      trim.position.set(0, ty, 0.2);
      scr.add(trim);
    }
    const legGeo = track(new THREE.BoxGeometry(0.4, 7.2, 0.4));
    scr.add(panel);
    for (const x of [-9.5, -3.2, 3.2, 9.5]) {
      const leg = new THREE.Mesh(legGeo, frameMat);
      leg.position.set(x, 3.6, -0.4);
      scr.add(leg);
    }
    scr.position.set(0, 0, end * (o.boundary + 3.2));
    // Face the middle.
    scr.rotation.y = end > 0 ? Math.PI : 0;
    group.add(scr);
  }

  /* A pool of light on the middle of the field. */
  const pool = new THREE.Mesh(
    track(new THREE.CircleGeometry(o.boundary * 0.95, 64)),
    track(
      new THREE.MeshBasicMaterial({
        map: track(poolTexture()),
        color: new THREE.Color("#fff6e6"),
        transparent: true,
        opacity: 0.085,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.03;
  pool.renderOrder = 1;
  group.add(pool);

  /* Glare: a long, thin horizontal streak through each lamp bank. */
  const streak = track(streakTexture());
  const glareMat = track(
    new THREE.SpriteMaterial({
      map: streak,
      color: new THREE.Color("#9cbcff"),
      transparent: true,
      opacity: 0.09,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  const flares: THREE.Sprite[] = [];
  for (const head of o.lampHeads) {
    const flare = new THREE.Sprite(glareMat);
    flare.scale.set(95, 2.2, 1);
    head.getWorldPosition(flare.position);
    flare.position.sub(o.centre);
    group.add(flare);
    flares.push(flare);
  }

  return {
    group,
    dispose() {
      for (const d of keep) d.dispose();
      truss.dispose();
    },
  };
}
