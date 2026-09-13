/**
 * RevolvingTrophy.tsx
 * The trophy, modelled from the real silhouette.
 *
 * Two earlier attempts got the shape wrong in instructive ways, and the notes
 * are here so the third is not undone by a fourth.
 *
 * The first used torus arcs for the handles. A torus is a circle and the cup is
 * not, so wherever the upper end met the rim the lower end hung in mid-air —
 * which read, accurately, as half a trophy. Handles are now tubes swept along a
 * Catmull-Rom curve: the endpoints are chosen rather than derived, so both sit
 * on the body by construction.
 *
 * The second was a wide open bowl — a generic sporting cup. The actual trophy
 * is a *covered urn*: a tall, slightly barrelled body with a domed lid and a
 * finial, a flared stepped foot, and a dark wooden plinth that is the only
 * non-metal element on the object. The bowl version was missing the lid, the
 * finial and the wood, which is most of what makes it recognisable.
 *
 * Everything is procedural. There is no licensed `.glb` of this trophy here and
 * there is not going to be one — it is a protected mark, the same reason the
 * logo is drawn rather than fetched. A lathe is also the right primitive for the
 * job: an urn is a solid of revolution, so each 2D profile below sweeps around Y
 * into a seamless surface that boxes and cylinders could not produce.
 *
 * Motion is frame-rate independent — `delta`, never a fixed increment — so it
 * turns at the same speed on a 60Hz laptop and a 144Hz monitor.
 */
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const SPIN = 0.42;
const BOB_AMPLITUDE = 0.08;
const BOB_SPEED = 0.55;

/**
 * Profiles, as [radius, height] pairs swept around Y.
 *
 * The body reads bottom-up: a slight barrel through the middle, drawn in at the
 * shoulder, then flared back out into the rim the lid sits on. It closes across
 * the top because a lid covers it — an open interior would never be seen and
 * would double the triangle count.
 */
const BODY: [number, number][] = [
  [0.0, 0.3],
  [0.54, 0.3],
  [0.63, 0.4],
  [0.68, 0.66],
  [0.7, 0.98],
  [0.67, 1.26],
  [0.62, 1.41],
  [0.69, 1.47],
  [0.69, 1.55],
  [0.0, 1.55],
];

/** The dome, overhanging the rim very slightly, as a lid does. */
const LID: [number, number][] = [
  [0.0, 1.55],
  [0.72, 1.55],
  [0.72, 1.63],
  [0.66, 1.72],
  [0.52, 1.84],
  [0.33, 1.93],
  [0.14, 1.98],
  [0.0, 1.99],
];

/** The finial: the small turned knob on top, and the detail that sells it. */
const FINIAL: [number, number][] = [
  [0.0, 1.97],
  [0.09, 2.0],
  [0.06, 2.05],
  [0.13, 2.09],
  [0.09, 2.15],
  [0.04, 2.2],
  [0.0, 2.23],
];

/** Flared, stepped foot between the wooden plinth and the body. */
const FOOT: [number, number][] = [
  [0.0, 0.0],
  [0.82, 0.0],
  [0.8, 0.05],
  [0.66, 0.11],
  [0.54, 0.16],
  [0.47, 0.22],
  [0.54, 0.3],
  [0.0, 0.3],
];

/**
 * One handle, from the shoulder of the body out and back to its waist.
 *
 * Both endpoints sit on the body surface — (0.66, 1.34) is the shoulder and
 * (0.68, 0.86) the waist — so the handle is attached at both ends rather than
 * floating beside the urn, which was the first version's failure.
 */
const HANDLE_PATH: [number, number, number][] = [
  [0.66, 1.34, 0],
  [1.02, 1.46, 0],
  [1.22, 1.3, 0],
  [1.24, 1.04, 0],
  [1.08, 0.86, 0],
  [0.85, 0.8, 0],
  [0.68, 0.86, 0],
];

function lathe(profile: [number, number][], segments = 96) {
  return new THREE.LatheGeometry(
    profile.map(([x, y]) => new THREE.Vector2(x, y)),
    segments,
  );
}

export interface RevolvingTrophyProps {
  /** Pauses rotation and bob, leaving the trophy posed. */
  still?: boolean;
  scale?: number;
}

export default function RevolvingTrophy({
  still = false,
  scale = 1,
}: RevolvingTrophyProps) {
  const group = useRef<THREE.Group>(null);

  const bodyGeometry = useMemo(() => lathe(BODY), []);
  const lidGeometry = useMemo(() => lathe(LID), []);
  const finialGeometry = useMemo(() => lathe(FINIAL, 48), []);
  const footGeometry = useMemo(() => lathe(FOOT), []);

  const handleGeometry = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(
      HANDLE_PATH.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      false,
      "catmullrom",
      0.25,
    );
    // Slightly flattened in Z, so the handle reads as a shaped strap rather
    // than a length of pipe.
    const tube = new THREE.TubeGeometry(curve, 72, 0.07, 14, false);
    tube.scale(1, 1, 0.62);
    return tube;
  }, []);

  useFrame((state, delta) => {
    const node = group.current;
    if (!node || still) return;

    node.rotation.y += SPIN * delta;
    // Absolute clock time, not accumulated delta: a dropped frame shifts
    // nothing and the bob cannot drift out of phase.
    node.position.y = Math.sin(state.clock.elapsedTime * BOB_SPEED) * BOB_AMPLITUDE;
  });

  return (
    <group ref={group} scale={scale}>
      {/*
        The whole object is lifted so its visual centre sits on the origin —
        the profiles above are authored from the base up, which would otherwise
        hang the trophy off the bottom of the frame. Done on an inner group so
        the bob above can own `position.y` outright.
      */}
      <group position={[0, -1.02, 0]}>
        {/* Body */}
        <mesh geometry={bodyGeometry} castShadow>
          <GoldMaterial />
        </mesh>

        {/* Lid and finial */}
        <mesh geometry={lidGeometry} castShadow>
          <GoldMaterial />
        </mesh>
        <mesh geometry={finialGeometry} castShadow>
          <GoldMaterial roughness={0.3} />
        </mesh>

        {/* Foot */}
        <mesh geometry={footGeometry} castShadow>
          <GoldMaterial color="#E8B84B" roughness={0.3} />
        </mesh>

        {/* Handles. The second is the first mirrored through X — one geometry,
            and they are guaranteed symmetrical. */}
        {([1, -1] as const).map((side) => (
          <mesh key={side} geometry={handleGeometry} scale={[side, 1, 1]} castShadow>
            <GoldMaterial color="#F0BE55" roughness={0.28} />
          </mesh>
        ))}

        {/*
          The wooden plinth. The one non-metal element, and load-bearing for
          recognition: without it the object is a generic gold cup. Low
          metalness and high roughness so it absorbs the light the gold throws
          back, which is what makes the gold look like gold.
        */}
        <mesh position={[0, -0.16, 0]} receiveShadow>
          <cylinderGeometry args={[1.06, 1.1, 0.32, 72]} />
          <meshStandardMaterial color="#4A2016" metalness={0.08} roughness={0.62} />
        </mesh>
        {/* A thin bright bevel where the wood meets the foot, which is what
            stops the two materials reading as one dark mass. */}
        <mesh position={[0, 0.005, 0]}>
          <cylinderGeometry args={[1.03, 1.06, 0.025, 72]} />
          <meshStandardMaterial color="#7A3A22" metalness={0.2} roughness={0.5} />
        </mesh>
      </group>
    </group>
  );
}

/**
 * The gold, in one place.
 *
 * Roughness is kept off zero deliberately: a perfect mirror renders as a
 * chaotic scatter of the environment that the eye reads as plastic, where a
 * little roughness gives the broad soft highlight that reads as polished metal.
 */
function GoldMaterial({
  color = "#F6C45A",
  roughness = 0.24,
}: {
  color?: string;
  roughness?: number;
}) {
  return (
    <meshStandardMaterial
      color={color}
      metalness={1}
      roughness={roughness}
      envMapIntensity={1.45}
      side={THREE.DoubleSide}
    />
  );
}
