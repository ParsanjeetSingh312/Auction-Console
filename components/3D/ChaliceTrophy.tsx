/**
 * ChaliceTrophy.tsx
 * The cup: a lathed chalice with swept handles, ported from the prototype.
 *
 * **On the shape, because the alternative in this folder documents its own
 * history.** `RevolvingTrophy` is a covered urn — domed lid, finial, wooden
 * plinth — modelled that way because the real IPL trophy is an urn, and its
 * header records two earlier attempts that were rejected for being a plain
 * open cup and for having torus handles. This file is deliberately that plain
 * open cup, because it was asked for: the prototype's silhouette reads better
 * at the size the landing renders it, where the urn's lid and barrel compress
 * into something closer to a pot. Both files stay. Swapping back is one import
 * line in `TrophyCanvas`.
 *
 * **The handles are the one place this does not follow the prototype**, and
 * the other half of that warning turned out to be right. The prototype uses a
 * torus arc; ported as-is it rendered two crescents floating in mid-air beside
 * the cup, touching nothing. Adjusting the arithmetic so the innermost point of
 * the sweep sat inside the wall did not fix it, because the *endpoints* sit at
 * a different height where the bowl is narrower. See `HANDLE_PATH` below for
 * the swept-tube replacement, which attaches by construction rather than by
 * tuning.
 *
 * Everything is procedural — about 2KB of maths against several megabytes for a
 * GLB, no loader, no Draco decoder, and the profile can be tuned live. It is
 * also the right primitive: a cup is a solid of revolution.
 */
import { useEffect, useMemo, useRef } from "react";

import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { BEATS, beat, journey } from "../../hooks/useJourney";

/**
 * Half-profile in the XY plane, revolved around Y.
 *
 * Proportions carry this more than detail does: a cup only reads as a trophy
 * when it is roughly twice as tall as it is wide. A squatter profile renders as
 * a cooking pot, which is the note the prototype left on its own first attempt.
 */
const PROFILE: Array<[number, number]> = [
  // stepped plinth
  [0.0, 0.0],
  [0.58, 0.0],
  [0.58, 0.09],
  [0.48, 0.13],
  [0.46, 0.24],
  [0.34, 0.3],
  // slender stem
  [0.12, 0.44],
  [0.085, 0.7],
  [0.085, 0.94],
  // knop
  [0.2, 1.02],
  [0.14, 1.12],
  // flared bowl
  [0.26, 1.24],
  [0.4, 1.46],
  [0.52, 1.78],
  [0.58, 2.12],
  [0.61, 2.42],
  [0.63, 2.62],
  // lip
  [0.655, 2.7],
  [0.6, 2.72],
  [0.575, 2.54],
  // inner wall, back down to the axis
  [0.52, 2.1],
  [0.42, 1.7],
  [0.26, 1.32],
  [0.0, 1.2],
];

/**
 * The bowl's outer radius at a given height, interpolated along the profile.
 *
 * Derived rather than typed in, so retuning the silhouette moves the handle
 * attachments with it instead of stranding them beside a cup that has changed.
 */
function radiusAt(y: number): number {
  // Only the outward-going part of the profile describes the outer wall; the
  // tail of the array is the inner wall coming back down and would give a
  // smaller radius for the same height.
  const outer = PROFILE.slice(0, 18);
  for (let i = 1; i < outer.length; i += 1) {
    const [x0, y0] = outer[i - 1];
    const [x1, y1] = outer[i];
    if (y >= y0 && y <= y1 && y1 !== y0) {
      return x0 + ((x1 - x0) * (y - y0)) / (y1 - y0);
    }
  }
  return outer[outer.length - 1][0];
}

/**
 * The handle path, as a curve with both ends buried in the bowl wall.
 *
 * A torus was tried first, because it is one line and the prototype uses one.
 * It does not work, and the reason is geometric rather than a matter of tuning:
 * a torus is a circle, the bowl wall is a flared curve, and a circular arc can
 * be tangent to that wall at one point only. Positioning it so the innermost
 * point of the sweep is inside the body still leaves both *endpoints* outside,
 * because they sit at a different height where the bowl is narrower. Rendered,
 * that is two crescents floating in mid-air beside the cup — which is exactly
 * what `RevolvingTrophy`'s header warns about, and exactly what happened.
 *
 * A swept tube fixes it by construction. The endpoints are chosen rather than
 * derived from a circle, so each one can be placed against the wall at its own
 * height — and `radiusAt` reads those radii off the profile, so retuning the
 * silhouette moves the handles with it instead of stranding them.
 */
const HANDLE_TOP_Y = 2.52;
const HANDLE_BOTTOM_Y = 1.62;
/** How far inside the wall an endpoint sits, so the join is buried, not tangent. */
const HANDLE_BITE = 0.05;

const HANDLE_PATH: Array<[number, number, number]> = [
  [radiusAt(HANDLE_TOP_Y) - HANDLE_BITE, HANDLE_TOP_Y, 0],
  [0.95, 2.4, 0],
  [1.12, 2.05, 0],
  [1.0, 1.74, 0],
  [radiusAt(HANDLE_BOTTOM_Y) - HANDLE_BITE, HANDLE_BOTTOM_Y, 0],
];

function buildHandleGeometry(): THREE.TubeGeometry {
  const curve = new THREE.CatmullRomCurve3(
    HANDLE_PATH.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    false,
    "catmullrom",
    0.25,
  );
  const tube = new THREE.TubeGeometry(curve, 72, 0.055, 14, false);
  // Flattened in Z so it reads as a shaped strap rather than a length of pipe.
  tube.scale(1, 1, 0.62);
  return tube;
}

function Handle({
  side,
  geometry,
}: {
  side: 1 | -1;
  geometry: THREE.TubeGeometry;
}) {
  return (
    <mesh geometry={geometry} scale={[side, 1, 1]} castShadow>
      <meshStandardMaterial
        color="#f7e2ae"
        metalness={1}
        roughness={0.2}
        envMapIntensity={2.4}
      />
    </mesh>
  );
}

/**
 * The vertical envelope `TrophyCanvas` is framed for.
 *
 * Its camera sits at `[0, 0.35, 6.4]` with a 38-degree vertical field of view,
 * aimed at the origin — numbers chosen against `RevolvingTrophy`, which spans
 * `0 -> 2.23` inside a group offset by `-1.02` so the model straddles the
 * origin rather than standing on it.
 *
 * This cup is 2.72 tall. Dropped in at the same scale it overshoots the frame
 * by 22%, which put its lip behind the AUCTIQ wordmark and cropped the rim.
 * Rather than re-aim a camera that other things depend on, the model is fitted
 * to the envelope the canvas already expects — measured off the geometry, so
 * editing `PROFILE` cannot quietly break the framing again.
 */
const TARGET_HEIGHT = 2.23;

export interface ChaliceTrophyProps {
  /** Posed rather than turning. Set for reduced motion. */
  still?: boolean;
  scale?: number;
  /**
   * Turn with scroll instead of on a timer of its own.
   * Off by default: not every mount is on the journey track.
   */
  scrollLinked?: boolean;
  /**
   * Also translate out of frame as the pitch beat takes over, the way the
   * prototype's trophy does.
   *
   * Separate from `scrollLinked`, and off by default, because the two are only
   * the same thing inside the journey's own scene. On the landing the trophy
   * occupies a slot in the hero's layout: it should turn with the page, and it
   * must not slide out and leave a hole. Anything that wraps this in a
   * transform of its own — `Float`, for instance — also owns position, so
   * writing to it here would fight the wrapper.
   */
  drift?: boolean;
}

export default function ChaliceTrophy({
  still = false,
  scale = 1,
  scrollLinked = false,
  drift = false,
}: ChaliceTrophyProps) {
  const group = useRef<THREE.Group>(null);

  const geometry = useMemo(
    () =>
      new THREE.LatheGeometry(
        PROFILE.map(([x, y]) => new THREE.Vector2(x, y)),
        72,
      ),
    [],
  );

  // One handle geometry, mirrored for the second — a tube at 72 segments is
  // not free, and the two sides are the same shape.
  const handleGeometry = useMemo(buildHandleGeometry, []);

  /**
   * Scale and lift that put this model inside `TARGET_HEIGHT`, centred on the
   * origin. Applied to a group that wraps the lights as well as the meshes:
   * the light rig belongs to the trophy, so it should shrink with it rather
   * than stay at full size around a smaller cup.
   */
  const fit = useMemo(() => {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) return { scale: 1, offset: 0 };
    const height = box.max.y - box.min.y;
    if (height <= 0) return { scale: 1, offset: 0 };
    const factor = TARGET_HEIGHT / height;
    return {
      scale: factor,
      offset: -((box.min.y + box.max.y) / 2) * factor,
    };
  }, [geometry]);

  // three.js never frees GPU memory on its own. `useEffect`, not `useMemo` —
  // a cleanup returned from useMemo is just a value React never calls.
  useEffect(
    () => () => {
      geometry.dispose();
      handleGeometry.dispose();
    },
    [geometry, handleGeometry],
  );

  useFrame((_, delta) => {
    const g = group.current;
    if (!g || still) return;

    if (scrollLinked) {
      /*
        Three-quarter turn across the trophy beat.

        Carried past the end of the beat rather than stopping at it: `beat`
        clamps to 1, so the trophy holds its final angle for the rest of the
        page instead of snapping back. A turn that reverses when you scroll on
        reads as a bug, not as an idle.
      */
      const t = beat(journey.progress, BEATS.heroEnd, BEATS.trophyEnd);
      g.rotation.y = t * Math.PI * 1.5;

      if (drift) {
        // Only when this component owns its own position. See the prop's note.
        const exit = beat(journey.progress, BEATS.trophyEnd, BEATS.pitchEnd);
        g.position.x = 0.9 + t * 0.4 + exit * 6.5;
        g.position.y = -exit * 0.6;
        g.scale.setScalar(scale * (1 - exit * 0.25));
      }
    } else {
      // Frame-rate independent, so it turns at the same speed on a 60Hz laptop
      // and a 144Hz monitor.
      g.rotation.y += delta * 0.25;
    }
  });

  return (
    <group ref={group} scale={scale} dispose={null}>
      {/* Normalisation, so everything below is authored in profile units. */}
      <group scale={fit.scale} position={[0, fit.offset, 0]}>
        <mesh geometry={geometry} castShadow receiveShadow>
          <meshStandardMaterial
            color="#f2d9a0"
            metalness={1}
            roughness={0.16}
            envMapIntensity={2.6}
          />
        </mesh>

        <Handle side={1} geometry={handleGeometry} />
        <Handle side={-1} geometry={handleGeometry} />

        {/*
        A key light dedicated to the trophy. Polished metal is a mirror: with
        metalness at 1 and nothing bright to reflect, the bowl mirrors the dark
        sky above it and renders as a near-black cup however many lights are
        added elsewhere.
      */}
        <spotLight
          position={[2.4, 4.6, 3.4]}
          angle={0.55}
          penumbra={0.85}
          intensity={90}
          distance={16}
          decay={1.6}
          color="#fff2d6"
        />
        {/* Cold rim from behind-left, to separate the silhouette from the dark. */}
        <pointLight
          position={[-2.2, 2.6, -1.6]}
          intensity={22}
          distance={9}
          color="#9ad8ff"
        />

        {/* Cyan underglow: the one place the brand accent touches the gold. */}
        <pointLight
          position={[0, 0.2, 0.8]}
          intensity={6}
          distance={4}
          color="#37d0ff"
        />
        <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.66, 1.5, 48]} />
          <meshBasicMaterial
            color="#37d0ff"
            transparent
            opacity={0.07}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
}
