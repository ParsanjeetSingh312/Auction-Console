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
import { useEffect, useRef } from "react";

import { useReducedMotion } from "framer-motion";
import gsap from "gsap";

import { crore } from "../blockTypes";
import { Hammer } from "./Hammer";

export interface HammerDropProps {
  /** Who was sold. */
  playerName: string;
  /** The winning franchise's code. */
  teamCode: string;
  /** Hammer price, ₹ lakh. */
  amount: number | null;
  /** Base price, ₹ lakh, for the premium line. Omit to hide it. */
  basePrice?: number | null;
  /** Called when the cinematic has finished and should be unmounted. */
  onDone: () => void;
}

export default function HammerDrop({
  playerName,
  teamCode,
  amount,
  basePrice,
  onDone,
}: HammerDropProps) {
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion() ?? false;

  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    // Reduced motion still gets the outcome — who, how much — just without the
    // swing. The information is the point; the swing is the presentation.
    if (reduced) {
      const id = window.setTimeout(() => done.current(), 2200);
      return () => window.clearTimeout(id);
    }

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ onComplete: () => done.current() });

      tl.fromTo(root.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.18 })
        // Wind up.
        .fromTo(
          ".hd__hammer",
          { rotate: -58, y: -26, autoAlpha: 0 },
          { rotate: -46, y: -20, autoAlpha: 1, duration: 0.26, ease: "power4.out" },
        )
        // And strike. `power3.in` accelerates into the block rather than
        // easing out of it — a hammer does not decelerate on the way down.
        .to(".hd__hammer", { rotate: 6, y: 0, duration: 0.14, ease: "power3.in" })
        .addLabel("impact")
        // The rebound.
        .to(".hd__hammer", { rotate: -4, duration: 0.12, ease: "back.out(1.7)" })
        .fromTo(
          ".hd__shock",
          { scale: 0.2, autoAlpha: 0.9 },
          { scale: 2.6, autoAlpha: 0, duration: 0.72, ease: "power4.out" },
          "impact",
        )
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
      {/* The shockwave, expanding out of the point of impact. */}
      <span
        aria-hidden
        className="hd__shock absolute left-1/2 top-1/2 aspect-square w-[min(460px,70vw)] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[rgba(55,208,255,0.8)]"
      />

      <div className="relative grid justify-items-center gap-3 text-center">
        {/* `transform-origin` lives on the Hammer's own box — see that file. */}
        <span
          aria-hidden
          className="hd__hammer block aspect-square w-[clamp(88px,14vw,132px)]"
          style={{ transformOrigin: "72% 88%" }}
        >
          <Hammer />
        </span>

        <p className="hd__word font-stadium text-[clamp(3.5rem,13vw,8rem)] font-bold leading-[0.9] tracking-[0.04em] text-white [text-shadow:0_0_60px_rgba(55,208,255,0.8)]">
          SOLD
        </p>

        {amount !== null && (
          <p className="hd__detail font-stadium text-3xl font-bold tabular-nums text-white">
            {crore(amount)}
          </p>
        )}

        <p className="hd__detail text-sm uppercase tracking-[0.18em] text-white/80">
          {teamCode ? `${teamCode} · ` : ""}
          {playerName}
        </p>

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
