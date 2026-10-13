/**
 * AuctoniqTrophy.tsx
 * The landing's trophy: a gold cricket ball spinning on a tilted off-spin axis
 * above a sculpted silver cradle, a stepped plinth and a gold auction gavel.
 *
 * The model, materials, lighting, camera and controls are the supplied design,
 * unchanged. What this file adds is the render plumbing around it, in the same
 * spirit as `TrophyCanvas`, which it replaces in the hero:
 *
 * - **It stops when hidden.** The render loop is cancelled outright while the
 *   stage is off screen or the tab is in the background, rather than drawing
 *   frames nobody sees.
 * - **It follows the quality tier.** Pixel ratio is capped by `useQuality`, so
 *   an integrated GPU is not asked for more pixels than the rest of the page.
 * - **It degrades.** If a WebGL context cannot be created, the `fallback` is
 *   rendered instead of an empty box.
 * - **The stitches are one draw call.** 128 raised stitches were 128 meshes;
 *   they are now a single InstancedMesh with identical placement.
 * - **Dragging has momentum** and can no longer get stuck if the pointer is
 *   cancelled or capture is lost mid-drag.
 * - **It fades in** on its first rendered frame instead of popping.
 *
 * `TrophyCanvas` and `ChaliceTrophy` are kept on disk, unmounted.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { Pause, Play, RotateCcw } from "lucide-react";

import { useQuality } from "./rig/quality";
import "./auctoniqTrophy.css";

export interface AuctoniqTrophyProps {
  className?: string;
  /** Rendered if WebGL is unavailable. */
  fallback?: ReactNode;
}

export default function AuctoniqTrophy({ className = "", fallback }: AuctoniqTrophyProps) {
  const quality = useQuality();
  const mount = useRef<HTMLDivElement>(null);
  const running = useRef(true);
  const reset = useRef<(() => void) | null>(null);
  const [paused, setPaused] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    const palette = getComputedStyle(host);
    const color = (name: string) => new THREE.Color(palette.getPropertyValue(name).trim());
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(33, 1, .1, 100);
    
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch (error) {
      console.warn("[AuctoniqTrophy] WebGL unavailable, using fallback.", error);
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxDpr));
    renderer.setClearColor(0, 0); renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15; host.appendChild(renderer.domElement);
    // Broad studio panels create real, asymmetric metallic reflections.
    const studio = document.createElement('canvas'); studio.width = 1024; studio.height = 512;
    const ctx = studio.getContext('2d');
    if (ctx) {
      ctx.fillStyle = palette.getPropertyValue('--studio-dark'); ctx.fillRect(0, 0, 1024, 512);
      ctx.fillStyle = palette.getPropertyValue('--studio-warm'); ctx.fillRect(65, 40, 180, 270);
      ctx.fillStyle = palette.getPropertyValue('--studio-white'); ctx.fillRect(440, 0, 70, 440);
      ctx.fillStyle = palette.getPropertyValue('--studio-cool'); ctx.fillRect(760, 70, 130, 360);
      ctx.fillStyle = palette.getPropertyValue('--studio-white'); ctx.fillRect(280, 40, 430, 35);
    }
    const texture = new THREE.CanvasTexture(studio); texture.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer); const env = pmrem.fromEquirectangular(texture);
    scene.environment = env.texture;
    const gold = new THREE.MeshStandardMaterial({ color: color('--metal-gold'), metalness: 1, roughness: .24 });
    const silver = new THREE.MeshStandardMaterial({ color: color('--metal-silver'), metalness: 1, roughness: .27 });
    const dark = new THREE.MeshStandardMaterial({ color: color('--metal-dark'), metalness: .8, roughness: .3 });
    const seamMat = new THREE.MeshStandardMaterial({ color: color('--metal-seam'), metalness: .8, roughness: .28 });
    const accentMat = new THREE.MeshBasicMaterial({ color: color('--seam-light'), toneMapped: false });
    const lightMat = new THREE.MeshBasicMaterial({ color: color('--cradle-light-core'), toneMapped: false });
    const lightningMat = new THREE.MeshBasicMaterial({ color: color('--seam-light-core'), toneMapped: false });
    const glowMat = new THREE.MeshBasicMaterial({ color: color('--cradle-light'), transparent: true, opacity: .28, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const haloMat = new THREE.MeshBasicMaterial({ color: color('--seam-light'), transparent: true, opacity: .1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    function illuminatedCurve(parent: THREE.Group, curve: THREE.Curve<THREE.Vector3>, radius: number, core: THREE.Material, closed = false) {
      parent.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 160, radius, 6, closed), core));
      parent.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 160, radius * 3, 8, closed), glowMat));
      parent.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 160, radius * 7, 8, closed), haloMat));
    }
    const trophy = new THREE.Group(); scene.add(trophy);
    function cylinder(radius: number, height: number, y: number, material: THREE.Material, upper = radius) {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(upper, radius, height, 96), material);
      mesh.position.y = y; trophy.add(mesh); return mesh;
    }
    cylinder(1.24, .13, .12, gold); cylinder(1.17, .2, .275, dark);
    cylinder(1.08, .1, .42, silver); cylinder(.98, .2, .565, dark);
    cylinder(.88, .08, .705, gold); cylinder(.73, .16, .825, silver);
    cylinder(.62, .06, .94, gold);
    // A continuous, gently tapered cradle rather than intersecting primitive rods.
    for (let i = 0; i < 3; i++) {
      const angle = i * Math.PI * 2 / 3 + .3;
      const points = [new THREE.Vector3(.48, .91, 0), new THREE.Vector3(.42, 1.34, 0), new THREE.Vector3(.51, 1.92, 0), new THREE.Vector3(.68, 2.42, 0), new THREE.Vector3(.85, 2.68, 0)];
      const curve = new THREE.CatmullRomCurve3(points);
      const vertices: number[] = []; const indices: number[] = [];
      for (let step = 0; step <= 48; step++) {
        const t = step / 48; const p = curve.getPoint(t); const tangent = curve.getTangent(t);
        const width = .11 + .065 * t; const depth = .045;
        for (const [side, back] of [[-1,-1],[1,-1],[1,1],[-1,1]] as const) {
          const x = p.x + back * depth * tangent.y;
          const y = p.y - back * depth * tangent.x;
          const z = side * width;
          vertices.push(x * Math.cos(angle) - z * Math.sin(angle), y, x * Math.sin(angle) + z * Math.cos(angle));
        }
        if (step < 48) for (let k = 0; k < 4; k++) { const a = step * 4 + k, b = step * 4 + (k+1)%4; indices.push(a,b,a+4,b,b+4,a+4); }
      }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
      trophy.add(new THREE.Mesh(geometry, silver));
      // Recessed edge lights trace the silver supports, without painting them blue.
      const lightPoints: THREE.Vector3[] = [];
      for (let step = 0; step <= 32; step++) {
        const t = .12 + step / 32 * .82;
        const p = curve.getPoint(t); const tangent = curve.getTangent(t);
        const x = p.x + .047 * tangent.y;
        const y = p.y - .047 * tangent.x;
        const z = .11 + .065 * t;
        lightPoints.push(new THREE.Vector3(x * Math.cos(angle) - z * Math.sin(angle), y, x * Math.sin(angle) + z * Math.cos(angle)));
      }
      illuminatedCurve(trophy, new THREE.CatmullRomCurve3(lightPoints), .012, lightMat);
      const wash = new THREE.PointLight(color('--cradle-light'), 3.5, 2.1, 2);
      wash.position.set(.82 * Math.cos(angle), 1.85, .82 * Math.sin(angle));
      trophy.add(wash);
    }
    const tilt = new THREE.Group(); tilt.position.set(0, 3.15, 0); tilt.rotation.z = -Math.PI / 5; trophy.add(tilt);
    const ball = new THREE.Group(); tilt.add(ball);
    ball.add(new THREE.Mesh(new THREE.SphereGeometry(.755, 96, 64), gold));
    const seam = new THREE.Group(); seam.rotation.z = .28; ball.add(seam);
    for (const offset of [-.07, -.025, .025, .07]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.sqrt(.76 ** 2 - offset ** 2), .009, 8, 160), offset === -.025 || offset === .025 ? accentMat : seamMat);
      ring.rotation.x = Math.PI / 2; ring.position.y = offset; seam.add(ring);
    }
    // Electrical filaments hug the seam and rotate with the ball, not around it.
    for (const side of [-1, 1]) {
      const sparks: THREE.Vector3[] = [];
      for (let i = 0; i < 192; i++) {
        const angle = i / 192 * Math.PI * 2;
        const zigzag = Math.sin(i * 2.39 + side) * .008 + Math.sin(i * .73) * .006;
        const y = side * .05 + zigzag;
        const radius = Math.sqrt(.781 ** 2 - y ** 2);
        sparks.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
      }
      illuminatedCurve(seam, new THREE.CatmullRomCurve3(sparks, true, 'centripetal'), .006, lightningMat, true);
    }
    // Raised cricket-ball stitching makes spin readable without an artificial orbit.
    // One instanced mesh in place of 128 separate ones: same placement, one draw call.
    const stitches = new THREE.InstancedMesh(new THREE.CapsuleGeometry(.003, .026, 3, 4), silver, 128);
    const placement = new THREE.Object3D();
    let stitchIndex = 0;
    for (let i = 0; i < 64; i++) for (const side of [-1, 1]) {
      const a = i / 64 * Math.PI * 2;
      placement.position.set(Math.cos(a) * .758, side * .096, Math.sin(a) * .758);
      placement.rotation.set(0, 0, side * .48); placement.updateMatrix();
      stitches.setMatrixAt(stitchIndex++, placement.matrix);
    }
    stitches.instanceMatrix.needsUpdate = true; seam.add(stitches);
    // The gavel stands on the plinth's second step (top face at y .375): its head
    // sits on that ledge at the front-left and the handle angles down across the
    // front, at the same bearing and tilt as before.
    const gavel = new THREE.Group(); gavel.position.set(-.277,.54,1.362); gavel.rotation.z = -.21; gavel.rotation.y = -.8;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(.043,.065,1.9,24), gold); handle.rotation.z = Math.PI/2; handle.position.x = .18; gavel.add(handle);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(.19,.19,.48,48), gold); head.position.set(-.73,.02,0); gavel.add(head);
    for (const y of [-.25, -.19, .19, .25]) { const rim = new THREE.Mesh(new THREE.CylinderGeometry(.22,.22,.045,48), gold); rim.position.set(-.73,y,0); gavel.add(rim); }
    trophy.add(gavel);
    const key = new THREE.DirectionalLight(color('--studio-white'), 3); key.position.set(-3,6,4); scene.add(key);
    const fill = new THREE.DirectionalLight(color('--studio-cool'), 2); fill.position.set(4,2,-3); scene.add(fill);
    scene.add(new THREE.AmbientLight(color('--studio-white'), .5));

    // Drag to orbit, with a little momentum carried past the release. The
    // resting angle lays the gavel across the front, as in the reference look.
    const HOME = -.4;
    let azimuth = HOME; let targetAzimuth = azimuth; let dragging = false; let lastX = 0; let velocity = 0;
    const canvas = renderer.domElement;
    const down = (event: PointerEvent) => { dragging = true; velocity = 0; lastX = event.clientX; canvas.setPointerCapture(event.pointerId); };
    const move = (event: PointerEvent) => { if (!dragging) return; const delta = (event.clientX-lastX)*.006; targetAzimuth += delta; velocity = delta; lastX=event.clientX; };
    const up = () => { dragging = false; };
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('lostpointercapture', up);
    reset.current = () => { velocity = 0; targetAzimuth = HOME; };

    const resize = new ResizeObserver(() => {
      const { width, height } = host.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width,height); camera.aspect = width/height; camera.updateProjectionMatrix();
    });
    resize.observe(host);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    running.current = !reduced; setPaused(reduced);

    const clock = new THREE.Clock(); let frame = 0; let lightTime = 0; let firstFrame = true;
    function animate() {
      frame = requestAnimationFrame(animate); const dt = Math.min(clock.getDelta(), .05);
      if (running.current) {
        ball.rotation.y += dt * .85;
        lightTime += dt;
        glowMat.opacity = .28 + .035 * Math.sin(lightTime * 3.2);
      }
      if (!dragging && Math.abs(velocity) > 1e-5) { targetAzimuth += velocity; velocity *= Math.exp(-6 * dt); }
      azimuth += (targetAzimuth - azimuth) * (1 - Math.exp(-5 * dt));
      camera.position.set(Math.sin(azimuth)*10.9,3.9,Math.cos(azimuth)*10.9); camera.lookAt(0,1.65,0);
      renderer.render(scene,camera);
      if (firstFrame) { firstFrame = false; setReady(true); }
    }

    // Only draw while the stage is on screen and the tab is in front.
    let onScreen = true;
    const sync = () => {
      const shouldRun = onScreen && document.visibilityState === 'visible';
      if (shouldRun && !frame) { clock.getDelta(); animate(); }
      if (!shouldRun && frame) { cancelAnimationFrame(frame); frame = 0; }
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null
      : new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; sync(); }, { rootMargin: '120px' });
    observer?.observe(host);
    document.addEventListener('visibilitychange', sync);
    sync();

    return () => {
      cancelAnimationFrame(frame); frame = 0;
      observer?.disconnect(); document.removeEventListener('visibilitychange', sync); resize.disconnect();
      canvas.removeEventListener('pointerdown',down); canvas.removeEventListener('pointermove',move);
      canvas.removeEventListener('pointerup',up); canvas.removeEventListener('pointercancel',up); canvas.removeEventListener('lostpointercapture',up);
      scene.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
      stitches.dispose();
      [gold,silver,dark,seamMat,accentMat,lightMat,lightningMat,glowMat,haloMat].forEach(m=>m.dispose());
      env.dispose(); texture.dispose(); pmrem.dispose(); renderer.dispose(); canvas.remove(); reset.current=null;
    };
  }, [quality.maxDpr]);

  if (failed) return <>{fallback ?? null}</>;

  return (
    <div className={`trophy-stage ${className}`}>
      <div className="trophy-shadow" />
      <div
        ref={mount}
        className={`trophy-canvas${ready ? ' is-ready' : ''}`}
        role="img"
        aria-label="Gold cricket ball rotating on a tilted off-spin axis, above a sculpted silver trophy and gold auction gavel"
      />
      <div className="trophy-controls">
        <span className="trophy-caption">THE AUCTONIQ TROPHY</span>
        <div>
          <button
            type="button"
            aria-label={paused ? 'Play ball rotation' : 'Pause ball rotation'}
            title={paused ? 'Play rotation' : 'Pause rotation'}
            onClick={() => { running.current = paused; setPaused(!paused); }}
          >
            {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          </button>
          <button type="button" aria-label="Reset trophy view" title="Reset view" onClick={() => reset.current?.()}>
            <RotateCcw aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
