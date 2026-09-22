/**
 * StadiumScene.tsx
 * The WebGL surface the stadium lives on.
 *
 * Deliberately shaped like `TrophyCanvas`, which already solved most of this
 * for the trophy — same lazy boundary, same reduced-motion respect, same
 * refusal to burn GPU on something nobody is looking at. Two differences are
 * worth stating because they are choices rather than oversights.
 *
 * **`frameloop` is continuous, not `"demand"`.** `TrophyCanvas` renders on
 * demand because a posed trophy only changes when something asks it to. This
 * scene is driven by scroll position read inside `useFrame`, and a demand loop
 * would render a frame only when React re-rendered — which is exactly what the
 * journey is designed never to do. The IntersectionObserver still applies: the
 * loop is suspended outright when the canvas leaves the viewport, which is
 * cheaper than demand rendering rather than a compromise on it.
 *
 * **No canvas at all on tier 1.** Not a stripped-down scene — no WebGL context.
 * The caller checks `quality.canvas` before importing this module, so a phone
 * never downloads three.js. See `rig/quality.ts`.
 *
 * At this step the scene is ground and ambient fill only. Floodlights, the
 * camera rig and post-processing arrive in later steps and slot in here.
 */
import { Suspense, lazy, useEffect, useRef, useState } from "react";

import { Canvas } from "@react-three/fiber";
import * as THREE from "three";

// The effect composer is a real chunk and a full-screen pass every frame.
// Only tiers that asked for bloom ever download it.
const Effects = lazy(() =>
  import("./Effects").then((m) => ({ default: m.Effects })),
);

import { CameraRig } from "./rig/CameraRig";
import { CricketBall } from "./stadium/CricketBall";
import { FloodlightBank } from "./stadium/FloodlightBank";
import { Turf } from "./stadium/Turf";
import type { QualityProfile } from "./rig/quality";

export interface StadiumSceneProps {
  quality: QualityProfile;
  /**
   * False when the user prefers reduced motion. The scene still renders — the
   * arena is content, not decoration — but nothing moves on its own.
   */
  animate?: boolean;
}

export default function StadiumScene({ quality, animate = true }: StadiumSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(true);

  // Stop the render loop when the canvas is off screen. A stadium quietly
  // compositing every frame for the length of a long page is a battery
  // complaint on a laptop and a scroll-jank complaint on everything else.
  useEffect(() => {
    const element = host.current;
    if (!element || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => setOnScreen(entry.isIntersecting),
      { rootMargin: "120px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={host} className="absolute inset-0" aria-hidden="true">
      <Canvas
        dpr={[1, quality.maxDpr]}
        shadows={quality.shadows}
        frameloop={onScreen && animate ? "always" : "demand"}
        gl={{
          antialias: quality.tier === 3,
          powerPreference: "high-performance",
          // The scene fills the frame and paints its own background, so there
          // is nothing behind it worth compositing against.
          alpha: false,
          stencil: false,
          depth: true,
        }}
        camera={{ position: [0, 5.6, 33], fov: 44, near: 0.1, far: 260 }}
        onCreated={({ gl, scene }) => {
          // Filmic tone mapping, because a night stadium is a high-contrast
          // scene: without it the floodlights clip to flat white the moment
          // they come on, and the arena loses every highlight that sells it.
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.15;
          scene.background = new THREE.Color("#04070f");
          // Haze is the single cheapest thing that makes a night stadium read
          // as atmospheric rather than as geometry floating in a void. Where
          // the device cannot afford exponential fog, linear fog still hides
          // the far rim of the bowl, which is the part that gives it away.
          scene.fog = quality.haze
            ? new THREE.FogExp2("#050b18", 0.019)
            : new THREE.Fog("#050b18", 40, 130);
        }}
      >
        {/* Drives the camera from scroll. Disabled with `animate`, which leaves
            the camera at the establishing shot the Canvas set up. */}
        <CameraRig enabled={animate} />

        <Turf />
        <FloodlightBank quality={quality} />

        {/* Bowled across the pitch beat; hidden outside it. */}
        <CricketBall />

        {/*
          Fill, under the floodlights rather than instead of them. The hemisphere
          light is doing the work: cool blue from above, near-black bounce from
          below, which is what a night sky over dark ground actually does.

          Raised from the step-2 values because this tier renders no shadows. A
          shadowed scene gets its sense of form from contact darkness; without
          shadow maps the same fill level leaves the geometry looking flat and
          underexposed rather than moody.
        */}
        <hemisphereLight args={["#2a4f7a", "#04070f", quality.shadows ? 0.35 : 0.5]} />
        <ambientLight intensity={quality.shadows ? 0.12 : 0.2} color="#2b3d63" />

        {/* Last in the tree: post-processing reads the rendered frame. */}
        {quality.bloom && (
          <Suspense fallback={null}>
            <Effects quality={quality} />
          </Suspense>
        )}
      </Canvas>
    </div>
  );
}
