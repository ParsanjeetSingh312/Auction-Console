/**
 * Effects.tsx
 * Bloom and vignette — what makes the floodlights read as light.
 *
 * **This is not decoration.** Without it the lamp faces render as flat bright
 * rectangles: correct pixels, wrong image. A real floodlight blooms because the
 * eye and the lens both scatter light from a source that much brighter than its
 * surroundings, and a night stadium is almost entirely about that contrast. The
 * prototype puts it plainly — bloom confined to actual light sources is *"the
 * difference between cinematic and cheap glow filter"*.
 *
 * **The threshold is what keeps it honest.** `luminanceThreshold` at 0.62 means
 * only the lamp faces and the neon ring exceed it; the turf, the stands and the
 * trophy do not. Drop the threshold and everything glows, which is the cheap
 * version — a soft-focus filter over the whole frame rather than light coming
 * from somewhere.
 *
 * **Tier-gated and lazily loaded.** The effect composer is a meaningful chunk
 * and a full-screen post pass every frame, so tier 1 never downloads it and
 * never runs it. `StadiumScene` checks `quality.bloom` before importing.
 *
 * Ported from the prototype's `three/Effects.tsx` against
 * `@react-three/postprocessing@2.x`, which is the line that supports R3F 8 —
 * the prototype runs 3.x on R3F 9. Same components, same props.
 */
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { BlendFunction, KernelSize } from "postprocessing";

import type { QualityProfile } from "./rig/quality";

/*
  On the vignette: a slight darkening at the corners, doing two jobs. It keeps
  the eye on the pitch, and it stops the bowl's far rim — which is nearly the
  same colour as the background — from ending at a visible straight edge where
  the geometry runs out.

  Noted here rather than inline because `EffectComposer` types its children
  strictly, and a JSX comment is an `undefined` child that fails the check.
*/
export function Effects({ quality }: { quality: QualityProfile }) {
  const top = quality.tier === 3;

  return (
    <EffectComposer
      // Multisampling costs real time on an integrated GPU, and the scene is
      // mostly large flat surfaces where the aliasing it fixes barely shows.
      multisampling={top ? 4 : 0}
    >
      <Bloom
        intensity={top ? 0.85 : 0.72}
        luminanceThreshold={0.62}
        luminanceSmoothing={0.22}
        kernelSize={top ? KernelSize.LARGE : KernelSize.MEDIUM}
        mipmapBlur
      />
      <Vignette offset={0.28} darkness={0.62} blendFunction={BlendFunction.NORMAL} />
    </EffectComposer>
  );
}
