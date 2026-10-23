/**
 * HammerDrop.tsx
 * Hammer drop → SOLD → team → final price.
 *
 * The timeline is the prototype's, beat for beat, because its central idea is
 * the thing that makes a celebration animation work at all:
 *
 *   > "The strike lands on a single frame and everything else keys off it: the
 *   > SOLD lockup, the shockwave ring and the team colour flood all start at
 *   > the moment of impact, not before. An impact where the sound and the flash
 *   > are out of step is the thing that makes celebration animations feel
 *   > cheap."
 *
 * That is expressed with a GSAP label. Everything after `impact` is positioned
 * relative to it, so retiming the wind-up moves the flash with it automatically
 * — where hand-computed delays would silently drift apart the first time
 * anyone adjusts a duration.
 *
 * **GSAP here, framer-motion elsewhere, and that is not a contradiction.** The
 * rule for this project is GSAP for timeline choreography and framer-motion for
 * component state motion. This is four elements keyed to one frame of a fifth,
 * which is what a timeline is for; `BlockView` already imports GSAP, so nothing
 * new arrives in that file.
 *
 * **`onDone` is held in a ref, deliberately.** The prototype found this the
 * hard way and left the note: the console re-renders on every incoming bid, so
 * an inline arrow changes identity constantly, and depending on it made the
 * timeline revert and restart on every bid — the cinematic never finished and
 * never dismissed itself. It is kept out of the effect's dependencies here for
 * exactly that reason.
 */
import { useLayoutEffect, useRef } from "react";

import { useReducedMotion } from "framer-motion";
import gsap from "gsap";

import { crore } from "../blockTypes";
import { GavelScene, GRIP, IMPACT, SCENE, STRIKE_ANGLE } from "./Hammer";

/** The pivot, as GSAP's `svgOrigin` wants it: in the scene's own coordinates. */
const PIVOT = `${GRIP.x} ${GRIP.y}`;

export interface HammerDropProps {
  /** Who was sold. */
  playerName: string;
  /** The winning franchise's code. */
  teamCode: string;
  /** Hammer price, ₹ lakh. */
  amount: number | null;
  /** Base price, ₹ lakh, for the premium line. Omit to hide it. */
  basePrice?: number | null;
  /**
   * The sale in one sentence -- "VIRAT KOHLI SOLD TO MUMBAI FOR ₹15.50 Cr" --
   * in place of the team and player line. The offline room's SOLD banner.
   */
  headline?: string;
  /** Called when the cinematic has finished and should be unmounted. */
  onDone: () => void;
}

export default function HammerDrop({
  playerName,
  teamCode,
  amount,
  basePrice,
  headline,
  onDone,
}: HammerDropProps) {
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion() ?? false;

  const done = useRef(onDone);
  done.current = onDone;

  // A layout effect, not a plain one: the timeline's starting poses (gavel
  // cocked, impact effects hidden) must be applied before the first paint, or
  // the gavel flashes upright for a frame before the wind-up begins.
  useLayoutEffect(() => {
    // Reduced motion still gets the outcome — who, how much — just without the
    // swing. The information is the point; the swing is the presentation.
    if (reduced) {
      const id = window.setTimeout(() => done.current(), 2200);
      return () => window.clearTimeout(id);
    }

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ onComplete: () => done.current() });

      // Everything keyed to the strike starts hidden and stays hidden until it.
      // `immediateRender: false` on each is what guarantees that: without it a
      // fromTo placed later in a timeline applies its *from* values the moment
      // the timeline is built, which is how the shockwave used to sit on
      // screen as a small ring through the whole wind-up.
      const atImpact = { immediateRender: false };

      tl.fromTo(root.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.18 })
        .fromTo(".hd__scene", { autoAlpha: 0, y: -16 }, { autoAlpha: 1, y: 0, duration: 0.24, ease: "power3.out" }, "<")
        // Raise the gavel and cock it back, about the grip.
        .fromTo(
          ".hd__gavel",
          { rotation: 6, svgOrigin: PIVOT },
          { rotation: 26, duration: 0.28, ease: "power2.out" },
          "<0.06",
        )
        // And strike. `power3.in` accelerates into the block rather than
        // easing out of it -- a gavel does not decelerate on the way down.
        .to(".hd__gavel", { rotation: STRIKE_ANGLE, duration: 0.15, ease: "power3.in" })
        .addLabel("impact")
        // The rebound, then it settles back onto the block.
        .to(".hd__gavel", { rotation: STRIKE_ANGLE + 13, duration: 0.09, ease: "power2.out" })
        .to(".hd__gavel", { rotation: STRIKE_ANGLE, duration: 0.24, ease: "bounce.out" })
        .fromTo(
          ".hd__block",
          { scaleY: 0.88, svgOrigin: "60 152" },
          { scaleY: 1, duration: 0.34, ease: "elastic.out(1, 0.45)", ...atImpact },
          "impact",
        )
        .fromTo(
          ".hd__sparks",
          { scale: 0.4, autoAlpha: 1, svgOrigin: `${IMPACT.x} ${IMPACT.y}` },
          { scale: 1.5, autoAlpha: 0, duration: 0.42, ease: "power2.out", ...atImpact },
          "impact",
        )
        .fromTo(
          ".hd__shock",
          { scale: 0.15, autoAlpha: 0.9, xPercent: -50, yPercent: -50 },
          { scale: 2.6, autoAlpha: 0, duration: 0.72, ease: "power4.out", ...atImpact },
          "impact",
        )
        // A short jolt through the lockup, so the hit is felt and not only seen.
        .fromTo(".hd__lockup", { y: 5 }, { y: 0, duration: 0.3, ease: "elastic.out(1, 0.35)", ...atImpact }, "impact")
        .fromTo(
          ".hd__flood",
          { autoAlpha: 0 },
          { autoAlpha: 1, duration: 0.3, ease: "power4.out" },
          "impact",
        )
        .fromTo(
          ".hd__word",
          { scale: 1.5, autoAlpha: 0 },
          { scale: 1, autoAlpha: 1, duration: 0.42, ease: "back.out(1.7)" },
          "impact+=0.02",
        )
        .fromTo(
          ".hd__detail",
          { y: 24, autoAlpha: 0 },
          { y: 0, autoAlpha: 1, stagger: 0.08, duration: 0.36 },
          "impact+=0.18",
        )
        .to(root.current, { autoAlpha: 0, duration: 0.34, ease: "power2.inOut" }, "+=1.5");
    }, root);

    return () => ctx.revert();
    // `done` is a ref on purpose — see the header.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerName, amount, reduced]);

  const premium =
    amount !== null && basePrice != null && basePrice > 0
      ? Math.round(((amount - basePrice) / basePrice) * 100)
      : null;

  return (
    <div
      ref={root}
      role="status"
      aria-live="assertive"
      className="pointer-events-none fixed inset-0 z-[70] grid place-items-center bg-[rgba(2,6,23,0.88)] opacity-0 backdrop-blur-[6px]"
    >
      {/* A wash of light behind the lockup, so the frame is not flat black. */}
      <span
        aria-hidden
        className="hd__flood absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 60% at 50% 55%, rgba(55,208,255,0.30), transparent 72%)",
        }}
      />
      <div className="hd__lockup relative grid justify-items-center gap-3 text-center">
        {/* The gavel and its block. The shockwave lives inside this box so it
            can expand from the exact point of contact, not the screen centre. */}
        <div
          aria-hidden
          className="hd__scene relative w-[clamp(150px,20vw,220px)]"
          style={{ aspectRatio: `${SCENE.width} / ${SCENE.height}` }}
        >
          <GavelScene restAngle={reduced ? STRIKE_ANGLE : undefined} />
          {!reduced && (
            <span
              className="hd__shock pointer-events-none absolute aspect-square w-[min(460px,70vw)] rounded-full border-2 border-[rgba(55,208,255,0.8)] opacity-0"
              style={{
                left: `${(IMPACT.x / SCENE.width) * 100}%`,
                top: `${(IMPACT.y / SCENE.height) * 100}%`,
                // Centred on the impact point by the tween's xPercent/yPercent,
                // so GSAP owns the whole transform and scale cannot fight a
                // CSS translate for it.
              }}
            />
          )}
        </div>

        <p className="hd__word font-stadium text-[clamp(3.5rem,13vw,8rem)] font-bold leading-[0.9] tracking-[0.04em] text-white [text-shadow:0_0_60px_rgba(55,208,255,0.8)]">
          SOLD
        </p>

        {amount !== null && (
          <p className="hd__detail font-stadium text-3xl font-bold tabular-nums text-white">
            {crore(amount)}
          </p>
        )}

        {headline ? (
          <p className="hd__detail max-w-[min(90vw,780px)] px-4 font-stadium text-[clamp(1.25rem,3.4vw,2.1rem)] font-bold uppercase leading-tight tracking-[0.04em] text-white">
            {headline}
          </p>
        ) : (
          <p className="hd__detail text-sm uppercase tracking-[0.18em] text-white/80">
            {teamCode ? `${teamCode} · ` : ""}
            {playerName}
          </p>
        )}

        {premium !== null && (
          <p className="hd__detail text-[11px] uppercase tracking-[0.16em] text-white/45">
            {premium > 0
              ? `${premium}% over base of ${crore(basePrice as number)}`
              : "at base price"}
          </p>
        )}
      </div>
    </div>
  );
}
