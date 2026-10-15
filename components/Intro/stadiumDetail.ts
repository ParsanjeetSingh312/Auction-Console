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
  const W = 512;
  const BAND = 96;
  const H = BAND * bands;
  const { c, ctx } = canvas(W, H);
  const rand = rng(61);
  // Canvas y runs down; v runs up. Band j fills rows top..bottom.
  const band = (j: number) => ({ top: H - (j + 1) * BAND, bottom: H - j * BAND });

  // Base: dark painted concrete.
  ctx.fillStyle = "#151a26";
  ctx.fillRect(0, 0, W, H);

  const seats = (j: number, rows: number, tone: string, aisles: number) => {
    const { top, bottom } = band(j);
    const h = (bottom - top) / rows;
    for (let r = 0; r < rows; r++) {
      const y = top + r * h;
      // Seat back (lit from the field side) over the shadowed tread.
      ctx.fillStyle = tone;
      ctx.fillRect(0, y, W, h * 0.45);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, y + h * 0.45, W, h * 0.55);
      // Individual seats.
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      for (let x = (r % 2) * 3; x < W; x += 7) ctx.fillRect(x, y, 1, h * 0.45);
    }
    // Aisles: stairs climbing the tier, a little lighter, with step edges.
    for (let a = 0; a < aisles; a++) {
      const x = (W / aisles) * a + W / aisles / 2;
      ctx.fillStyle = "#2a3140";
      ctx.fillRect(x - 6, top, 12, bottom - top);
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      for (let y = top; y < bottom; y += h) ctx.fillRect(x - 6, y, 12, 1);
    }
  };

  // 0: pitch-side wall.
  {
    const { top, bottom } = band(0);
    ctx.fillStyle = "#0e1320";
    ctx.fillRect(0, top, W, bottom - top);
    ctx.fillStyle = "#33406a";
    ctx.fillRect(0, top, W, 6);
  }
  // 1: lower tier, franchise-coloured blocks between the aisles.
  seats(1, 22, "#1f2a42", 4);
  {
    const { top, bottom } = band(1);
    // Franchise colours in the seat blocks, held well down: the crowd is the
    // colour, the seats only a hint of it.
    const tones = ["rgba(40,70,160,0.16)", "rgba(200,160,40,0.1)", "rgba(190,60,50,0.11)", "rgba(110,60,170,0.11)"];
    for (let b = 0; b < 4; b++) {
      ctx.fillStyle = tones[b];
      ctx.fillRect((W / 4) * b + 8, top, W / 4 - 16, bottom - top);
    }
  }
  // 2: concourse floor.
  {
    const { top, bottom } = band(2);
    ctx.fillStyle = "#2b303b";
    ctx.fillRect(0, top, W, bottom - top);
  }
  // 3: concourse wall (the ribbon board covers most of it).
  {
    const { top, bottom } = band(3);
    ctx.fillStyle = "#0b0f18";
    ctx.fillRect(0, top, W, bottom - top);
  }
  // 4: upper tier, with lit entrances along its foot.
  seats(4, 28, "#1f2a44", 4);
  {
    const { top, bottom } = band(4);
    for (let a = 0; a < 4; a++) {
      const x = (W / 4) * a + W / 8 + W / 8;
      const g = ctx.createLinearGradient(0, bottom - 28, 0, bottom);
      g.addColorStop(0, "rgba(255,214,150,0.0)");
      g.addColorStop(1, "rgba(255,214,150,0.85)");
      ctx.fillStyle = "#06080d";
      ctx.fillRect(x - 16, bottom - 30, 32, 30);
      ctx.fillStyle = g;
      ctx.fillRect(x - 13, bottom - 26, 26, 26);
    }
    void top;
  }
  // 5: walkway.
  {
    const { top, bottom } = band(5);
    ctx.fillStyle = "#262b36";
    ctx.fillRect(0, top, W, bottom - top);
  }
  // 6: back wall with a row of small lamps.
  {
    const { top, bottom } = band(6);
    ctx.fillStyle = "#0a0d14";
    ctx.fillRect(0, top, W, bottom - top);
    for (let x = 8; x < W; x += 32) {
      ctx.fillStyle = "rgba(200,220,255,0.7)";
      ctx.fillRect(x, top + (bottom - top) * 0.3, 6, 3);
    }
  }
  // Grime, so no two tiles look printed.
  for (let i = 0; i < 2500; i++) {
    ctx.fillStyle = rand() > 0.5 ? "rgba(255,255,255,0.025)" : "rgba(0,0,0,0.06)";
    ctx.fillRect(rand() * W, rand() * H, 1 + rand() * 3, 1 + rand() * 2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.repeat.set(48, 1);
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
  const screenMat = track(new THREE.MeshStandardMaterial({ color: "#05070c", roughness: 0.9 }));
  const frameMat = track(new THREE.MeshStandardMaterial({ color: "#1b2233", roughness: 0.6, metalness: 0.4 }));
  for (const end of [1, -1]) {
    const scr = new THREE.Group();
    const panel = new THREE.Mesh(track(new THREE.BoxGeometry(20, 7, 0.35)), screenMat);
    panel.position.y = 3.5;
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
      opacity: 0.16,
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
