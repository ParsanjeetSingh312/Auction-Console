/**
 * TrophyCanvas.tsx
 * The stage the trophy stands on: camera, lights, environment, and the guards
 * that stop a 3D canvas from being a liability on someone else's machine.
 *
 * Four of those guards matter enough to name.
 *
 * **It is lazy.** three.js plus fiber plus drei is ~700KB before the scene.
 * The canvas is imported through `React.lazy` by the section that uses it, so
 * the landing's first paint never waits on it and a visitor who bounces above
 * the fold never downloads it.
 *
 * **It stops when hidden.** `frameloop="demand"` plus an IntersectionObserver
 * means the render loop only runs while the canvas is actually on screen.
 * Without that, a revolving trophy keeps burning GPU and battery for the whole
 * length of the page after the user has scrolled past it — the design
 * database's own note on live surfaces is to stop offscreen work.
 *
 * **It respects reduced motion.** The trophy is posed rather than spinning,
 * not removed: the object is the content, the rotation is the decoration.
 *
 * **It degrades.** WebGL fails on old drivers, in some VMs, and behind
 * hardened browser settings. An error boundary catches that and falls back to
 * the flat SVG trophy, which is a perfectly good hero image — far better than
 * a blank rectangle where the centrepiece should be.
 *
 * On the lighting. Gold is a mirror: a metalness-1 material with nothing to
 * reflect renders near-black no matter how many lights are added. The
 * environment preset is doing most of the work; the spots are there to place
 * highlights and throw the rim light that separates the cup from the ground.
 */
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { Environment, Float, Lightformer, PerspectiveCamera } from "@react-three/drei";
import { useReducedMotion } from "framer-motion";

import RevolvingTrophy from "./RevolvingTrophy";

export interface TrophyCanvasProps {
  className?: string;
  /** Rendered if WebGL is unavailable or the scene throws. */
  fallback?: ReactNode;
}

export default function TrophyCanvas({ className = "", fallback }: TrophyCanvasProps) {
  const reduced = useReducedMotion();
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);

  /**
   * Only render while on screen.
   *
   * `frameloop` flips between "always" and "never" rather than unmounting the
   * canvas — unmounting would drop the WebGL context and force a full scene
   * rebuild every time the user scrolled back, which is far more expensive
   * than the idle canvas it saves.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "120px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={hostRef} className={className}>
      <WebGLBoundary fallback={fallback}>
        <Canvas
          // "demand" would need an explicit invalidate() per frame, which
          // fights useFrame; "never" while offscreen achieves the same saving
          // without touching the animation code.
          frameloop={visible ? "always" : "never"}
          // Capped at 2: past that the pixel count quadruples for a difference
          // nobody can see on a 3-inch canvas.
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
          // Transparent, so the stadium gradient behind the page shows through
          // and the trophy sits *in* the scene rather than on a grey tile.
          style={{ background: "transparent" }}
        >
          <PerspectiveCamera makeDefault position={[0, 0.35, 5.4]} fov={38} />

          {/* Base fill. Deliberately dim — the environment provides the body of
              the light, and a bright ambient would flatten the metal. */}
          <ambientLight intensity={0.35} />

          {/* Key, warm, high and to the right. */}
          <spotLight
            position={[4.5, 6, 4]}
            angle={0.5}
            penumbra={0.8}
            intensity={90}
            color="#FFE6B0"
            castShadow
          />
          {/* Fill, cool, low and to the left — the stadium blue, so the shadow
              side of the gold picks up the page's own colour. */}
          <spotLight
            position={[-5, -1.5, 3]}
            angle={0.7}
            penumbra={1}
            intensity={45}
            color="#4D8DF6"
          />
          {/* Rim, from behind, which is what actually separates the silhouette
              from a near-black background. */}
          <directionalLight position={[-1.5, 2.5, -4]} intensity={2.2} color="#F6C45A" />

          {/*
            The reflections — built in-scene, not fetched.

            drei's named presets (`preset="city"`) download an HDR from a CDN,
            and that is a genuinely bad dependency for a hero element: a
            metalness-1 gold with no environment renders BLACK, so a blocked
            request, an offline demo or a slow network does not degrade the
            trophy, it deletes it. That is exactly what happened on the first
            run of this scene — canvas present, WebGL fine, nothing visible.

            `Lightformer` children build the probe from geometry instead. It is
            synchronous, weighs nothing, works air-gapped, and gives more
            control than a preset: the three panels below are placed to put a
            warm highlight down one side of the cup, a cool one down the other,
            and a bright band across the rim.
          */}
          <Environment resolution={256}>
            {/* Key panel, warm, camera-right and high. */}
            <Lightformer
              form="rect"
              intensity={5}
              color="#FFE0A3"
              position={[6, 5, 3]}
              scale={[9, 9, 1]}
              target={[0, 0, 0]}
            />
            {/* Fill panel, the stadium blue, camera-left and low. */}
            <Lightformer
              form="rect"
              intensity={3}
              color="#6AA6FF"
              position={[-7, -2, 2]}
              scale={[8, 8, 1]}
              target={[0, 0, 0]}
            />
            {/* Overhead strip — this is the band that travels around the cup
                as it turns and makes the surface read as metal rather than as
                a flat gold colour. */}
            <Lightformer
              form="ring"
              intensity={4}
              color="#FFFFFF"
              position={[0, 8, 1]}
              scale={[7, 7, 1]}
              target={[0, 0, 0]}
            />
            {/* Rim, from behind, to separate the silhouette from the page. */}
            <Lightformer
              form="rect"
              intensity={3.5}
              color="#F6C45A"
              position={[-2, 3, -7]}
              scale={[8, 5, 1]}
              target={[0, 0, 0]}
            />
          </Environment>

          {reduced ? (
            <RevolvingTrophy still scale={1.05} />
          ) : (
            <Float speed={1.1} rotationIntensity={0.22} floatIntensity={0.5}>
              <RevolvingTrophy scale={1.05} />
            </Float>
          )}
        </Canvas>
      </WebGLBoundary>
    </div>
  );
}

/**
 * Catches a failed WebGL context and shows something instead of nothing.
 *
 * A class component because error boundaries have no hook equivalent — this is
 * the one remaining case React has not given a function-component answer to.
 */
class WebGLBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Logged rather than swallowed: a silent fallback makes "the trophy is
    // missing on my machine" impossible to diagnose from a bug report.
    console.warn("[TrophyCanvas] WebGL scene failed, using fallback.", error);
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
