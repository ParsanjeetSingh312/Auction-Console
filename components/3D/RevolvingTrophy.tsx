/**
 * RevolvingTrophy.tsx
 * The IPL trophy, built from lathed profiles rather than loaded from a file.
 *
 * Why procedural. There is no licensed `.glb` of the IPL trophy in this repo
 * and there is not going to be one — it is a protected mark, the same reason
 * the logo is drawn rather than fetched. A lathe geometry gets the silhouette
 * right, weighs nothing, and cannot 404 mid-presentation.
 *
 * `LatheGeometry` is the right primitive for this shape specifically: a trophy
 * is a solid of revolution — every horizontal slice is a circle — so the whole
 * cup, stem and plinth are described by a single 2D profile swept around Y.
 * Modelling the same form from boxes and cylinders would take five meshes and
 * still show seams where they met.
 *
 * On the metal. Gold reads as gold because of what it *reflects*, not its
 * colour: a high-metalness material with nothing around it renders almost
 * black. The environment map in TrophyCanvas is doing most of the work here,
 * and the roughness is kept off zero so the highlight is a soft band rather
 * than a mirror the eye reads as plastic.
 *
 * Motion is frame-rate independent — `delta`, never a fixed increment — so the
 * trophy turns at the same speed on a 60Hz laptop and a 144Hz monitor. A
 * constant-per-frame rotation spins more than twice as fast on the latter.
 */
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/** Radians per second. Slow enough to read the form, fast enough to notice. */
const SPIN = 0.42;

/** Float: amplitude in world units, and cycles per second. */
const BOB_AMPLITUDE = 0.09;
const BOB_SPEED = 0.55;

export interface RevolvingTrophyProps {
  /** Pauses rotation and bob, leaving the trophy posed. */
  still?: boolean;
  /** Uniform scale, for fitting the canvas. */
  scale?: number;
}

export default function RevolvingTrophy({
  still = false,
  scale = 1,
}: RevolvingTrophyProps) {
  const group = useRef<THREE.Group>(null);

  /**
   * The cup profile, in the XY plane, swept 360° around Y.
   *
   * Read bottom-up: the point at x=0 closes the base, the flare out to 0.95
   * gives the bowl its lip, and the near-vertical run at the top is the rim.
   * Memoised because rebuilding a lathe every render would allocate a new
   * BufferGeometry sixty times a second.
   */
  const cupProfile = useMemo(
    () =>
      [
        [0.0, 0.0],
        [0.34, 0.0],
        [0.36, 0.06],
        [0.3, 0.16],
        [0.34, 0.42],
        [0.52, 0.72],
        [0.74, 0.98],
        [0.9, 1.22],
        [0.95, 1.46],
        [0.95, 1.54],
        [0.88, 1.54],
        [0.86, 1.3],
        [0.7, 1.02],
        [0.48, 0.76],
        [0.28, 0.46],
        [0.24, 0.18],
        [0.0, 0.08],
      ].map(([x, y]) => new THREE.Vector2(x, y)),
    [],
  );

  /** Stem and the stepped plinth it stands on. */
  const baseProfile = useMemo(
    () =>
      [
        [0.0, -0.86],
        [1.12, -0.86],
        [1.12, -0.66],
        [0.98, -0.62],
        [0.9, -0.46],
        [0.86, -0.42],
        [0.34, -0.36],
        [0.22, -0.2],
        [0.2, -0.02],
        [0.0, -0.02],
      ].map(([x, y]) => new THREE.Vector2(x, y)),
    [],
  );

  /**
   * The handles.
   *
   * Torus arcs rather than tubes along a curve: a partial torus is two numbers
   * (arc length, rotation) where a `TubeGeometry` needs a hand-authored spline,
   * and at this scale the difference is invisible.
   */
  const handle = useMemo(() => new THREE.TorusGeometry(0.42, 0.055, 12, 40, Math.PI * 1.15), []);

  // Hoisted out of the JSX below. A hook in an attribute position happens to
  // evaluate in a stable order here, but it is one conditional away from
  // breaking the rules of hooks and reads as an accident either way.
  const cupGeometry = useMemo(() => new THREE.LatheGeometry(cupProfile, 96), [cupProfile]);
  const baseGeometry = useMemo(() => new THREE.LatheGeometry(baseProfile, 96), [baseProfile]);

  useFrame((state, delta) => {
    const node = group.current;
    if (!node || still) return;

    node.rotation.y += SPIN * delta;
    // Bob is driven by absolute clock time, not accumulated delta, so a
    // dropped frame shifts nothing and the motion cannot drift out of phase.
    node.position.y = Math.sin(state.clock.elapsedTime * BOB_SPEED) * BOB_AMPLITUDE;
  });

  return (
    <group ref={group} scale={scale} position={[0, 0, 0]}>
      {/* Cup */}
      <mesh geometry={cupGeometry} castShadow>
        <meshStandardMaterial
          color="#F6C45A"
          metalness={1}
          roughness={0.24}
          envMapIntensity={1.35}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Stem + plinth, in a darker gold so the cup stays the subject. */}
      <mesh geometry={baseGeometry} castShadow>
        <meshStandardMaterial
          color="#CA8A04"
          metalness={1}
          roughness={0.34}
          envMapIntensity={1.1}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Dark inlay band around the plinth — the one non-gold element, which is
          what keeps the whole object from reading as a single blob of metal. */}
      <mesh position={[0, -0.76, 0]}>
        <cylinderGeometry args={[1.13, 1.13, 0.14, 64]} />
        <meshStandardMaterial color="#0E1223" metalness={0.35} roughness={0.55} />
      </mesh>

      {/* Handles, mirrored either side. */}
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          geometry={handle}
          position={[side * 0.82, 0.92, 0]}
          rotation={[0, 0, side > 0 ? -Math.PI * 0.42 : Math.PI * 1.42]}
          scale={[1, 1, 1]}
        >
          <meshStandardMaterial
            color="#E3B23C"
            metalness={1}
            roughness={0.28}
            envMapIntensity={1.25}
          />
        </mesh>
      ))}
    </group>
  );
}
