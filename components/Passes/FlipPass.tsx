/**
 * FlipPass.tsx
 * The auction pass as a two-sided card you can turn over: the foil ticket on
 * the front (AuctionPass), its powers on the back (passPowers.ts).
 *
 * Who owns which motion:
 *
 *   Framer Motion   the card's rotation. Click (or Enter / Space) flips it with
 *                   a spring; dragging sideways spins it freely through 360°,
 *                   and letting go settles on the nearest face -- a hard flick
 *                   carries on round before it settles.
 *   GSAP            the 360° showcase turn the first time the card scrolls into
 *                   view, the light that sweeps the foil and the shade that
 *                   falls across it as it turns edge-on, and the powers on the
 *                   back dealing in one line at a time when the back comes round.
 *
 * Under prefers-reduced-motion there is no showcase spin and no drag: a click
 * still turns the card, instantly.
 */
import { useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import type { PassKind } from "../../console/ecosystemStore";
import AuctionPass from "./AuctionPass";
import type { PassSize } from "./AuctionPass";
import { POWERS, holderNote } from "./passPowers";
import "./passes.css";

gsap.registerPlugin(useGSAP);

type Tier = "admin" | "auctioneer" | "delegate" | "member" | null;

interface Props {
  kind: PassKind;
  size?: PassSize;
  count?: number;
  /** Who is looking at it, for the note under the powers. */
  tier?: Tier;
  /** Play the one-time 360° showcase turn when it first comes into view. */
  showcase?: boolean;
  /** Passed through to the front face. */
  intro?: boolean;
}

/** Degrees of drag per pixel. */
const DRAG = 0.55;

/** The nearest resting angle (a multiple of 180) to `deg`. */
const nearestFace = (deg: number) => Math.round(deg / 180) * 180;

export default function FlipPass({ kind, size = "lg", count, tier = null, showcase = true, intro = false }: Props) {
  const reduce = useReducedMotion() ?? false;
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLDivElement>(null);
  const powers = POWERS[kind];

  // The card's angle. `target` is where it is heading; the spring follows.
  const target = useMotionValue(0);
  const angle = useSpring(target, { stiffness: 140, damping: 18, mass: 0.9 });
  const [showingBack, setShowingBack] = useState(false);
  const dragging = useRef(false);
  const moved = useRef(0);

  // Light and shade from the angle: brightest face-on, darkest edge-on.
  const shade = useTransform(angle, (a) => 0.55 * Math.abs(Math.sin((a * Math.PI) / 180)));
  const sweep = useTransform(angle, (a) => `${(((a % 360) + 360) % 360) / 3.6}%`);

  // Which face is towards the viewer, for assistive tech and the deal-in.
  useEffect(
    () =>
      angle.on("change", (a) => {
        const turned = (((a % 360) + 360) % 360);
        setShowingBack(turned > 90 && turned < 270);
      }),
    [angle],
  );

  const flip = () => {
    const next = nearestFace(target.get()) + 180;
    if (reduce) {
      target.set(next);
      angle.jump(next);
    } else {
      target.set(next);
    }
  };

  /* ---- GSAP: the showcase turn, once, when the card first comes into view ---- */
  useGSAP(
    () => {
      if (reduce || !showcase || !root.current) return;
      const el = root.current;
      let played = false;
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting || played) return;
          played = true;
          observer.disconnect();
          const spin = { v: target.get() };
          gsap.to(spin, {
            v: spin.v + 360,
            duration: 1.8,
            delay: 0.35,
            ease: "power3.inOut",
            onUpdate: () => {
              target.set(spin.v);
              angle.jump(spin.v);
            },
            onComplete: () => {
              // Settle on the front again, with the angle back in one turn.
              target.set(0);
              angle.jump(0);
            },
          });
          gsap.fromTo(
            el.querySelectorAll(".flip-pass__glint"),
            { opacity: 0.45 },
            { opacity: 1, duration: 0.6, yoyo: true, repeat: 1, delay: 0.9, ease: "sine.inOut" },
          );
        },
        { threshold: 0.6 },
      );
      observer.observe(el);
      return () => observer.disconnect();
    },
    { scope: root, dependencies: [reduce, showcase] },
  );

  /* ---- GSAP: the powers deal in when the back comes round ---- */
  useGSAP(
    () => {
      if (!showingBack || !back.current) return;
      const lines = back.current.querySelectorAll(".flip-pass__power, .flip-pass__note");
      if (reduce) {
        gsap.set(lines, { autoAlpha: 1, x: 0 });
        return;
      }
      gsap.fromTo(
        lines,
        { autoAlpha: 0, x: 14 },
        { autoAlpha: 1, x: 0, duration: 0.4, stagger: 0.07, delay: 0.18, ease: "power2.out" },
      );
    },
    { scope: back, dependencies: [showingBack, reduce] },
  );

  return (
    <div
      ref={root}
      className="flip-pass"
      data-kind={kind}
      data-size={size}
    >
      <motion.div
        role="button"
        tabIndex={0}
        aria-pressed={showingBack}
        aria-label={`${kind === "A" ? "Auctioneer" : "Delegate"} pass${count !== undefined ? `, ${count} held` : ""}. ${
          showingBack ? "Showing its powers" : "Turn over to see its powers"
        }`}
        className="flip-pass__card"
        style={{ rotateY: angle }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            flip();
          }
          if (!reduce && event.key === "ArrowRight") target.set(target.get() + 30);
          if (!reduce && event.key === "ArrowLeft") target.set(target.get() - 30);
        }}
        onTap={() => {
          // A drag ends with a tap event too; only a real click flips.
          if (moved.current < 6) flip();
          moved.current = 0;
        }}
        onPanStart={() => {
          if (reduce) return;
          dragging.current = true;
          moved.current = 0;
        }}
        onPan={(_, info) => {
          if (reduce || !dragging.current) return;
          moved.current += Math.abs(info.delta.x);
          target.set(target.get() + info.delta.x * DRAG);
          angle.jump(target.get());
        }}
        onPanEnd={(_, info) => {
          if (reduce) return;
          dragging.current = false;
          // A flick carries on round in its direction before it settles.
          const carry = info.velocity.x * 0.18;
          const rest = nearestFace(target.get() + carry);
          void animate(target, rest, { type: "spring", stiffness: 120, damping: 16, velocity: info.velocity.x * DRAG });
        }}
      >
        {/* Front: the foil ticket. Its own pointer tilt is off: the card turns instead. */}
        <div className="flip-pass__face flip-pass__front" aria-hidden={showingBack}>
          <AuctionPass kind={kind} size={size} count={count} intro={intro} tilt={false} />
          <motion.div aria-hidden className="flip-pass__shade" style={{ opacity: shade }} />
          <motion.div aria-hidden className="flip-pass__glint" style={{ backgroundPositionX: sweep }} />
        </div>

        {/* Back: what the pass can do. */}
        <div ref={back} className="flip-pass__face flip-pass__back" aria-hidden={!showingBack}>
          <div className="flip-pass__back-body">
            <div className="flip-pass__back-head">
              <span className="flip-pass__mark">{kind}</span>
              <div>
                <div className="flip-pass__title">{powers.title}</div>
                <div className="flip-pass__tagline">{powers.tagline}</div>
              </div>
            </div>
            <ul className="flip-pass__powers">
              {powers.powers.map((line) => (
                <li key={line} className="flip-pass__power">
                  {line}
                </li>
              ))}
            </ul>
            <p className="flip-pass__note">{holderNote(kind, tier)}</p>
          </div>
          {/* Light and shade that move with the turn, on each face. */}
          <motion.div aria-hidden className="flip-pass__shade" style={{ opacity: shade }} />
          <motion.div aria-hidden className="flip-pass__glint" style={{ backgroundPositionX: sweep }} />
        </div>
      </motion.div>

      <p className="flip-pass__hint" aria-hidden>
        {reduce ? "Click to turn over" : "Click to flip · drag to spin"}
      </p>
    </div>
  );
}
