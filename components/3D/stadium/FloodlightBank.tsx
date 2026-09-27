/**
 * FloodlightBank.tsx
 * The towers, and the thing that makes the arena wake up.
 *
 * Each tower is a mast, a housing, an emissive lamp face and a spotlight. The
 * lamp face is doing more work than the spotlight for the *look*: a light you
 * cannot see the source of reads as ambient, and the bright rectangle at the
 * top of the mast is what actually says "the lights are on". It is marked
 * `toneMapped={false}` so ACES cannot pull it back down towards the rest of the
 * scene — a lamp face that obeys the tone curve stops looking like a lamp.
 *
 * **They ramp in sequence, not together.** Each tower is offset slightly in the
 * hero beat, so the arena comes up bank by bank rather than flicking on like a
 * wall switch. The staggering is the whole effect; without it this is a
 * brightness slider.
 *
 * **There is a standby level.** Before any scrolling the towers sit at a
 * fraction of full, because the alternative is an opening frame with nothing in
 * it — a black rectangle is not a dark stadium.
 *
 * **On the flicker.** Real metal-halide floods strike, dip and settle rather
 * than coming straight up, and the prototype models that with `Math.random()`
 * per frame. That is noise at frame rate, which reads as strobing rather than
 * as lamps warming: at 60fps it changes 60 times a second with no continuity
 * between samples. This uses two detuned sine waves with a per-tower phase
 * offset instead — continuous, so it reads as a lamp settling, and
 * deterministic, so it looks the same on every machine and in every screenshot.
 */
import { useMemo, useRef } from "react";

import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { BEATS, beat, journey } from "../../../hooks/useJourney";
import type { QualityProfile } from "../rig/quality";

/**
 * Six towers, unevenly spaced on purpose.
 *
 * A real ground does not have its floods on a regular hexagon, and an even ring
 * lights the pitch flatly from every side. Uneven placement gives the turf a
 * direction and leaves shadowed ground between banks, which is most of what
 * makes the arena read as a place rather than a lit disc.
 */
const TOWER_POSITIONS: Array<[number, number]> = [
  [-16, -14], [16, -14], [-20, 6], [20, 6], [-10, 20], [10, 20],
];

const MAST_HEIGHT = 15;

/**
 * Brightness. Raised from the prototype's values, deliberately.
 *
 * The prototype runs 0.14 standby and a 320 peak, tuned against a tier-3
 * machine with six towers, shadows and volumetric cones all contributing. On
 * tier 2 — no shadows, no cones — the same numbers land noticeably darker,
 * because two of the three things selling the light are absent. These are the
 * tier-2 numbers; tier 3 gets the cones back on top of them.
 */
const STANDBY = 0.26;
const SPOT_PEAK = 460;
const PANEL_PEAK = 7;

interface FloodlightProps {
  x: number;
  z: number;
  index: number;
  lightCones: boolean;
  castShadows: boolean;
}

function Floodlight({ x, z, index, lightCones, castShadows }: FloodlightProps) {
  const panel = useRef<THREE.MeshStandardMaterial>(null);
  const spot = useRef<THREE.SpotLight>(null);
  const cone = useRef<THREE.Mesh>(null);

  // A spotlight aims at an Object3D, not at a coordinate. This one sits inboard
  // of the tower so the beam crosses the pitch rather than pointing straight
  // down at the tower's own feet.
  const target = useMemo(() => new THREE.Object3D(), []);

  useFrame(({ clock }) => {
    const t = beat(journey.progress, 0, BEATS.heroEnd);
    const stagger = index * 0.11;
    const local = Math.min(1, Math.max(0, (t - stagger) / (1 - stagger || 1)));

    // Two detuned sines with a per-tower phase. Only while striking: once the
    // lamp is up it holds steady, because a floodlight that never settles is a
    // fault, not an atmosphere.
    const striking = local > 0.02 && local < 0.34;
    const time = clock.elapsedTime;
    const phase = index * 1.7;
    const flicker = striking
      ? 0.72 + 0.28 * Math.abs(Math.sin(time * 11 + phase) * Math.sin(time * 7.3 + phase))
      : 1;

    // `** 0.6` front-loads the ramp: most of the brightness arrives early in
    // the beat, which is what a lamp coming up to temperature actually does.
    const level = (STANDBY + (1 - STANDBY) * local ** 0.6) * flicker;

    if (panel.current) panel.current.emissiveIntensity = level * PANEL_PEAK;
    if (spot.current) spot.current.intensity = level * SPOT_PEAK;
    if (cone.current) {
      (cone.current.material as THREE.MeshBasicMaterial).opacity = level * 0.045;
    }
  });

  return (
    <group position={[x, 0, z]}>
      {/* Mast. */}
      <mesh position={[0, MAST_HEIGHT / 2, 0]}>
        <boxGeometry args={[0.35, MAST_HEIGHT, 0.35]} />
        <meshStandardMaterial color="#0d1526" metalness={0.6} roughness={0.7} />
      </mesh>

      {/* Housing, tilted slightly towards the middle. */}
      <mesh
        position={[0, MAST_HEIGHT + 1.1, 0]}
        rotation={[Math.atan2(z, Math.hypot(x, z)) * 0.25, 0, 0]}
      >
        <boxGeometry args={[4.4, 2.4, 0.5]} />
        <meshStandardMaterial color="#111b2e" metalness={0.5} roughness={0.6} />
      </mesh>

      {/* The lamp face. This is what reads as "the lights are on". */}
      <mesh position={[0, MAST_HEIGHT + 1.1, -0.3]}>
        <planeGeometry args={[4.2, 2.2]} />
        <meshStandardMaterial
          ref={panel}
          color="#cfe6ff"
          emissive="#bfe4ff"
          emissiveIntensity={0}
          toneMapped={false}
        />
      </mesh>

      <primitive object={target} position={[-x * 0.35, 0, -z * 0.35]} />
      <spotLight
        ref={spot}
        position={[0, MAST_HEIGHT + 1, 0]}
        target={target}
        angle={0.62}
        penumbra={0.75}
        distance={95}
        decay={1.4}
        intensity={0}
        color="#dcecff"
        castShadow={castShadows}
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0008}
      />

      {/*
        The visible beam. Additive and barely opaque — a volumetric cone that
        you can clearly see is fog in a box, not light. Tier 3 only: it is
        transparent geometry over the whole frame, which is the most expensive
        thing in the scene per pixel of visual gain.
      */}
      {lightCones && (
        <mesh ref={cone} position={[0, MAST_HEIGHT / 2 + 1, 0]}>
          <coneGeometry args={[9, MAST_HEIGHT + 2, 24, 1, true]} />
          <meshBasicMaterial
            color="#bfe4ff"
            transparent
            opacity={0}
            side={THREE.DoubleSide}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}
    </group>
  );
}

export function FloodlightBank({ quality }: { quality: QualityProfile }) {
  const towers = TOWER_POSITIONS.slice(0, quality.floodlightCount);

  return (
    <group>
      {towers.map(([x, z], index) => (
        <Floodlight
          key={`${x}:${z}`}
          x={x}
          z={z}
          index={index}
          lightCones={quality.lightCones}
          castShadows={quality.shadows}
        />
      ))}
    </group>
  );
}
