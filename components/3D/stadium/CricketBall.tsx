/**
 * CricketBall.tsx
 * A delivery, bowled down the pitch by the scrollbar.
 *
 * **Not ported — built.** The prototype has no cricket ball in its 3D scene;
 * grep it for `sphereGeometry` and there is nothing. Its only balls are a DOM
 * cursor-trail easter egg and the mascot's face. The brief asks for a "cricket
 * ball scroll animation", so this is written against that rather than adapted
 * from something existing, and the choices below are therefore mine to defend.
 *
 * **It is a delivery, not a floating prop.** The pitch beat is the stretch of
 * the journey where the camera is down at turf level with nothing happening in
 * front of it. A ball released at one end, pitching about two thirds of the way
 * down and carrying on past the camera, gives that beat a subject and explains
 * what the strip on the ground is for. It also means the motion is legible: a
 * ball that falls, bounces once and rises is read instantly as cricket, where a
 * ball drifting through the air is read as a screensaver.
 *
 * **It is roughly four times life size.** A real ball is 36mm in radius, and
 * the pitch here is modelled at about a metre to the world unit — so an honest
 * ball would be three pixels across at this camera distance and simply would
 * not be visible. Scale is chosen for legibility, and the seam is exaggerated
 * with it, because the seam is what makes a red sphere read as a cricket ball.
 *
 * **The bounce is piecewise, not a sine.** A sine arc is symmetric and a
 * delivery is not: it falls further than it rises, and the rise after pitching
 * is much shallower than the descent before it. Two parabolas joined at the
 * bounce point cost nothing and are the difference between a bowled ball and a
 * bouncing rubber one.
 */
import { useEffect, useMemo, useRef } from "react";

import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { BEATS, beat, journey } from "../../../hooks/useJourney";

/** Legibility, not realism — see the note above. */
const RADIUS = 0.16;

/** The strip is 20 units long, centred on the origin. */
const FROM_Z = -10;
const TO_Z = 10.5;

/** Release height, out of a bowler's hand. */
const RELEASE_Y = 2.3;
/** How high it comes off the surface after pitching. */
const BOUNCE_Y = 0.85;
/** Where along the flight it lands, as a fraction. Good length. */
const PITCHES_AT = 0.62;

/** Slight drift across the strip, so it is not a dead-straight line. */
const FROM_X = -0.35;
const TO_X = 0.25;

export function CricketBall() {
  const group = useRef<THREE.Group>(null);

  /**
   * The seam: a thin ring around the ball, tilted.
   *
   * Tilted rather than square to the axis because a cricket ball is bowled with
   * the seam angled, and because a ring exactly on the equator reads as a
   * painted stripe when the ball spins.
   */
  const seam = useMemo(
    () => new THREE.TorusGeometry(RADIUS * 0.985, RADIUS * 0.085, 10, 48),
    [],
  );

  // three.js does not free GPU memory on its own, and a hand-built geometry is
  // the caller's to release.
  useEffect(() => () => seam.dispose(), [seam]);

  useFrame(() => {
    const node = group.current;
    if (!node) return;

    const t = beat(journey.progress, BEATS.trophyEnd, BEATS.pitchEnd);

    // Hidden outside its beat. A ball parked at the crease for the whole of the
    // hero section is a prop; one that only exists while it is being bowled is
    // an event.
    node.visible = t > 0.001 && t < 0.999;
    if (!node.visible) return;

    node.position.z = THREE.MathUtils.lerp(FROM_Z, TO_Z, t);
    node.position.x = THREE.MathUtils.lerp(FROM_X, TO_X, t);

    if (t < PITCHES_AT) {
      // Falling. Squared so it accelerates downward rather than descending at
      // a constant rate, which is what gravity looks like.
      const k = t / PITCHES_AT;
      node.position.y = RADIUS + RELEASE_Y * (1 - k * k);
    } else {
      // Risen off the surface and carrying on. A single low arc.
      const k = (t - PITCHES_AT) / (1 - PITCHES_AT);
      node.position.y = RADIUS + BOUNCE_Y * 4 * k * (1 - k);
    }

    // Backspin, tied to distance travelled rather than to elapsed time — a ball
    // that keeps spinning while the page is still is a ball floating in space.
    node.rotation.x = -t * Math.PI * 9;
    node.rotation.z = t * 0.6;
  });

  return (
    <group ref={group} visible={false}>
      <mesh castShadow>
        <sphereGeometry args={[RADIUS, 24, 20]} />
        {/*
          Red leather: rough, barely metallic, and dark enough that the
          floodlights pick out a highlight rather than blowing it to pink.
        */}
        <meshStandardMaterial color="#8c1c13" roughness={0.42} metalness={0.05} />
      </mesh>

      <mesh geometry={seam} rotation={[Math.PI / 2, 0, 0.38]}>
        <meshStandardMaterial color="#e8e2d2" roughness={0.75} metalness={0} />
      </mesh>
    </group>
  );
}
