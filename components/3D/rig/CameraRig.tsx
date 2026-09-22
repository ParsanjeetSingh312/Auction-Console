/**
 * CameraRig.tsx
 * Scroll position in, camera transform out.
 *
 * The camera follows two Catmull-Rom curves — one for where it is, one for
 * where it looks — sampled at the journey's progress. Two curves rather than a
 * position curve plus a fixed target, because a camera that flies past an
 * object while staring at the same point swings wildly at closest approach; the
 * look target has to travel too.
 *
 * **It never calls setState.** The rig subscribes to nothing and re-renders
 * never: it mutates `camera.position` inside `useFrame` and returns `null`.
 * That is the whole reason a scroll can feel like a camera move rather than a
 * series of React renders, and it is why `journey.progress` is a mutable module
 * object instead of state.
 *
 * **Smoothing is frame-rate independent.** `1 - Math.exp(-k * delta)` rather
 * than a fixed lerp factor, so the same curve feels identical at 30fps and
 * 144fps. A constant factor makes the camera arrive faster on a fast monitor,
 * which is the kind of bug that only shows up on someone else's machine.
 *
 * **Simplified from the prototype.** Its rig also serves route waypoints from a
 * zustand scene store, so navigation moves the camera instead of swapping
 * pages. This site has no such store and its routes are ordinary pages, so only
 * the landing journey is ported. The waypoint idea is worth revisiting if the
 * console ever becomes part of the same continuous world.
 */
import { useRef } from "react";

import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

import { BEATS, journey } from "../../../hooks/useJourney";

/** Where the camera is: outside the bowl, past the trophy, down onto the turf. */
const PATH = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, 5.6, 33),
  new THREE.Vector3(0, 5.0, 24),
  new THREE.Vector3(2.8, 2.2, 10),
  new THREE.Vector3(3.2, 1.7, 5.2),
  new THREE.Vector3(0.8, 1.8, 13),
  new THREE.Vector3(0, 2.1, 15),
]);

/** Where it looks, travelling with it. */
const LOOK = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, 2.6, 0),
  new THREE.Vector3(0, 2.2, 0),
  new THREE.Vector3(1.0, 1.5, 0),
  new THREE.Vector3(1.0, 1.35, 0),
  new THREE.Vector3(0.2, 0.9, 0),
  new THREE.Vector3(0, 1.1, 0),
]);

const FOV_START = 42;
const FOV_END = 48;

export interface CameraRigProps {
  /** False leaves the camera wherever the canvas put it. */
  enabled?: boolean;
}

export function CameraRig({ enabled = true }: CameraRigProps) {
  const { camera, size } = useThree();

  const targetPos = useRef(new THREE.Vector3());
  const targetLook = useRef(new THREE.Vector3());
  const currentLook = useRef(new THREE.Vector3(0, 2.6, 0));

  useFrame((_, delta) => {
    if (!enabled) return;
    const cam = camera as THREE.PerspectiveCamera;

    // The whole flight happens in the first 48% of the track — past that the
    // camera holds while the rest of the page scrolls under it. Compressing
    // here rather than stretching the curve keeps `BEATS` the single place the
    // pacing is described.
    const t = Math.min(journey.progress / BEATS.pitchEnd, 1);
    PATH.getPoint(t, targetPos.current);
    LOOK.getPoint(t, targetLook.current);

    const ease = 1 - Math.exp(-4.2 * delta);
    cam.position.lerp(targetPos.current, ease);
    currentLook.current.lerp(targetLook.current, ease);
    cam.lookAt(currentLook.current);

    /*
      A narrow viewport needs a wider field of view or the pitch falls outside
      the frustum entirely — `fov` is the *vertical* angle, so a portrait phone
      sees less to the sides than a desktop at the same value, not more.
    */
    const aspect = size.width / size.height;
    const base = THREE.MathUtils.lerp(FOV_START, FOV_END, t);
    const wanted = aspect < 1 ? base * 1.32 : aspect < 1.5 ? base * 1.12 : base;
    if (Math.abs(cam.fov - wanted) > 0.01) {
      cam.fov = THREE.MathUtils.lerp(cam.fov, wanted, ease);
      cam.updateProjectionMatrix();
    }

    // Tuning waypoints blind is guesswork. In dev the live position is readable
    // from the console while scrolling, which is how the curve above was set.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__auctiqCam = {
        progress: Math.round(journey.progress * 1000) / 1000,
        t: Math.round(t * 1000) / 1000,
        pos: cam.position.toArray().map((n) => Math.round(n * 100) / 100),
        look: currentLook.current.toArray().map((n) => Math.round(n * 100) / 100),
        fov: Math.round(cam.fov * 10) / 10,
      };
    }
  });

  return null;
}
