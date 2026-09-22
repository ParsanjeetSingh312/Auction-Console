import { useMemo } from "react";

/**
 * quality.ts
 * What this machine can afford to render, decided once and never in a render.
 *
 * The stadium is a full WebGL scene sitting behind the landing page. On a
 * desktop with a discrete GPU that costs nothing anyone notices. On a four-core
 * laptop with Intel integrated graphics it is the difference between a page
 * that scrolls and a page that stutters, and on a phone it is a battery
 * complaint. So the scene asks this module what it is allowed to do first.
 *
 * **Three tiers, and tier 1 mounts no canvas at all.** That is the important
 * one. The cheap instinct is to render the same scene with the effects turned
 * off, but a phone's problem is not bloom — it is that there is a WebGL context
 * compositing every frame underneath a page the user is trying to read. Tier 1
 * renders a CSS backdrop instead and nothing functional is lost, because every
 * control on this site lives in the DOM regardless of tier.
 *
 * **Reduced motion is deliberately NOT baked in here.** The prototype this is
 * adapted from folds `prefers-reduced-motion` into the cached tier at boot. It
 * is cached because detection touches the GPU and must not run per frame — but
 * that also means a user who turns the setting on mid-session keeps getting
 * animation until they reload. Everything this machine *is* — cores, memory,
 * renderer, pointer type — is fixed for the session and safe to cache. What the
 * user has *asked for* is not. `TrophyCanvas`, `AdminSplitScreen` and
 * `PostAuctionReport` already read it live through framer-motion's
 * `useReducedMotion`, so the scene does the same and combines the two:
 *
 *     const profile = useQuality()   // cached device capability
 *     const reduced = useReducedMotion()  // live user preference
 *     const animate = profile.canvas && !reduced
 *
 * **`?tier=1` forces a profile.** Testing the phone path by finding a phone is
 * slow, and the tier-1 branch is the one most likely to rot unnoticed.
 */

export type QualityTier = 1 | 2 | 3;

export interface QualityProfile {
  tier: QualityTier;
  /** False means: do not mount a WebGL canvas. Render the CSS backdrop. */
  canvas: boolean;
  shadows: boolean;
  bloom: boolean;
  /** Visible volumetric cones under each floodlight. The most expensive effect. */
  lightCones: boolean;
  haze: boolean;
  /** Upper bound on devicePixelRatio. A retina panel at DPR 3 quadruples fill cost. */
  maxDpr: number;
  floodlightCount: number;
}

const PROFILES: Record<QualityTier, Omit<QualityProfile, "tier">> = {
  3: { canvas: true, shadows: true, bloom: true, lightCones: true, haze: true, maxDpr: 2, floodlightCount: 6 },
  // Six towers on tier 2, not four. The prototype's four was tuned for a tier
  // that also has shadows and volumetric cones carrying the light; with both of
  // those off, cutting the tower count as well leaves the arena visibly dim and
  // lit from too few directions. Six plain spotlights without shadow maps are
  // cheap — the shadow map is what costs, not the light.
  2: { canvas: true, shadows: false, bloom: true, lightCones: false, haze: true, maxDpr: 1.5, floodlightCount: 6 },
  1: { canvas: false, shadows: false, bloom: false, lightCones: false, haze: false, maxDpr: 1, floodlightCount: 0 },
};

/**
 * The GPU's own name for itself, or null when WebGL2 is unavailable.
 *
 * `WEBGL_debug_renderer_info` is the only way to tell a real GPU from a
 * software rasteriser, and the distinction matters more than any core count:
 * SwiftShader will happily run this scene at four frames per second while
 * reporting sixteen cores. Some browsers mask the string for fingerprinting
 * reasons, which is fine — an unknown renderer falls through to the core count
 * rather than being treated as a failure.
 */
function readRenderer(): string | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return typeof raw === "string" ? raw : "";
  } catch {
    // A hardened browser can throw rather than return null. Not an error here.
    return null;
  }
}

function detectTier(): QualityTier {
  // SSR, or a test environment with no DOM. Assume the cheapest thing.
  if (typeof window === "undefined" || typeof document === "undefined") return 1;

  // A coarse pointer is a touchscreen, and a touchscreen is a battery.
  if (window.matchMedia("(pointer: coarse)").matches) return 1;

  const cores = navigator.hardwareConcurrency ?? 4;
  // deviceMemory is Chromium-only. Its absence is not evidence of a weak
  // device, so it can only ever demote, never promote.
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (memory !== undefined && memory <= 4) return 1;

  const renderer = readRenderer();
  if (renderer === null) return 2; // no WebGL2 — the canvas may still fall back
  if (/swiftshader|llvmpipe|software/i.test(renderer)) return 1;
  if (/(intel).*(uhd|hd graphics|iris)/i.test(renderer)) return 2;

  return cores >= 8 ? 3 : 2;
}

/** `?tier=1|2|3` — force a profile, for testing a path this machine would skip. */
function readForcedTier(): QualityTier | null {
  if (typeof location === "undefined") return null;
  const value = new URLSearchParams(location.search).get("tier");
  return value === "1" || value === "2" || value === "3"
    ? (Number(value) as QualityTier)
    : null;
}

let cached: QualityProfile | null = null;

/**
 * The profile for this session. Detection runs once; every later call is free.
 *
 * Safe to call from a render because of that cache — but prefer `useQuality`,
 * which makes the once-per-mount intent explicit at the call site.
 */
export function getQuality(): QualityProfile {
  if (cached) return cached;
  const tier = readForcedTier() ?? detectTier();
  cached = { tier, ...PROFILES[tier] };
  return cached;
}

/** Override the profile by hand. For a settings toggle, or a test. */
export function setQualityTier(tier: QualityTier): QualityProfile {
  cached = { tier, ...PROFILES[tier] };
  return cached;
}

/** Drop the cache so the next `getQuality` re-detects. Tests only. */
export function resetQuality(): void {
  cached = null;
}

/**
 * The profile, for components.
 *
 * A thin wrapper over `getQuality`, and worth having for one reason: it states
 * at the call site that this value is fixed for the session. A component
 * reading `getQuality()` inline looks like it might get a different answer next
 * render, which invites someone to add it to a dependency array and wonder why
 * nothing ever re-runs. `useMemo` with no dependencies says what is meant.
 *
 * Pair it with framer-motion's `useReducedMotion` for the live half of the
 * decision — see the note at the top of this file.
 */
export function useQuality(): QualityProfile {
  return useMemo(getQuality, []);
}
