/**
 * Turf.tsx
 * The ground: outfield, the 22-yard strip, the boundary, and the bowl around it.
 *
 * Every surface here is primitive geometry. A night stadium is mostly darkness
 * and a few very bright sources, so modelled detail in the stands buys almost
 * nothing visually while costing a draw call on every frame — the stands are
 * one open-ended cylinder, and at this light level that is indistinguishable
 * from the alternative.
 *
 * **The mow stripes are a 64x64 canvas texture, not geometry.** Alternating
 * strips of grass are what give an outfield its sense of scale, and drawing
 * them as meshes would be dozens of extra draw calls for something a repeating
 * texture does exactly as well. The texture is generated once and tiled.
 *
 * **It disposes itself.** three.js never releases GPU memory on its own: a
 * texture survives its mesh being removed from the scene, and survives the
 * component unmounting, until something calls `.dispose()`. One leaked texture
 * is harmless; one leaked texture per route change is a session that gets
 * slower the longer it runs.
 */
import { useEffect, useMemo } from "react";

import * as THREE from "three";

/** Outfield radius in world units. The camera and floodlights are placed against this. */
export const FIELD_RADIUS = 34;

/**
 * Alternating mow stripes, drawn once into a small canvas.
 *
 * Returned as a texture the caller owns and must dispose.
 */
function makeTurfTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;

  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#0a1f18";
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "#0d2a20";
    for (let x = 0; x < 64; x += 16) ctx.fillRect(x, 0, 8, 64);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(14, 14);
  texture.anisotropy = 4;
  // A colour texture must be tagged sRGB or three treats its bytes as linear
  // and the grass comes out noticeably paler than it was authored.
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function Turf() {
  const texture = useMemo(makeTurfTexture, []);

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <group>
      {/* Outfield. receiveShadow so the floodlights have something to land on. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[FIELD_RADIUS, 64]} />
        <meshStandardMaterial map={texture} roughness={0.95} metalness={0} />
      </mesh>

      {/*
        The 22-yard strip. Lifted a hair off the outfield rather than sharing a
        plane with it: coplanar surfaces z-fight, which at this scale reads as a
        flickering seam down the middle of the pitch.
      */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} receiveShadow>
        <planeGeometry args={[3.2, 20]} />
        <meshStandardMaterial color="#b9a887" roughness={0.9} />
      </mesh>

      {/* The 30-yard circle, in brand cyan. An accent that belongs to the world
          rather than being painted over it. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.018, 0]}>
        <ringGeometry args={[13.4, 13.5, 96]} />
        <meshBasicMaterial color="#37d0ff" transparent opacity={0.3} />
      </mesh>

      {/* Boundary rope. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[30, 30.18, 96]} />
        <meshBasicMaterial color="#e8edf7" transparent opacity={0.22} />
      </mesh>

      <Bowl />
    </group>
  );
}

/**
 * The stands: one open-ended cylinder seen from the inside.
 *
 * `BackSide` is what makes that work — the camera sits inside the cylinder, so
 * the outward-facing faces would be culled and the stands would not draw at
 * all. Near-black on purpose: its job is to close off the sky and give the
 * floodlights something to be bright against, not to be looked at.
 */
function Bowl() {
  return (
    <mesh position={[0, 7, 0]}>
      <cylinderGeometry args={[38, 33, 16, 64, 1, true]} />
      <meshStandardMaterial
        color="#060b18"
        side={THREE.BackSide}
        roughness={1}
        metalness={0}
      />
    </mesh>
  );
}
