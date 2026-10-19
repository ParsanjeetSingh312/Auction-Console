/**
 * AuctionPass.tsx
 * The auction pass, drawn: a gold foil ticket with a bladed "A" for
 * Auctioneers, a sapphire one with a bladed "D" for Delegates.
 *
 * Motion is GSAP, scoped to the card with useGSAP so it all reverts on
 * unmount:
 *
 *   intro   the ticket swings in, the monogram's outline is drawn on and its
 *           foil fills in behind the line, then the type settles
 *   sheen   a holographic band sweeps the foil every few seconds
 *   tilt    the card leans towards the pointer (quickTo), with a glare that
 *           follows it
 *
 * All three stand down under prefers-reduced-motion, leaving a still card.
 */
import { useId, useMemo, useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import type { PassKind } from "../../console/ecosystemStore";
import "./passes.css";

gsap.registerPlugin(useGSAP);

export type PassSize = "xs" | "sm" | "md" | "lg";

interface Props {
  kind: PassKind;
  size?: PassSize;
  /** A count badge. Zero shows the ticket greyed out, as spent. */
  count?: number;
  /** Printed on the ticket; a stable stand-in if not given. */
  serial?: string;
  /** Play the swing-in and monogram draw when it mounts. */
  intro?: boolean;
  /** Lean towards the pointer. */
  tilt?: boolean;
  /** Grey the ticket out at a zero count (a wallet); off where zero is not "spent". */
  greyWhenEmpty?: boolean;
  className?: string;
}

const COPY: Record<PassKind, { label: string; word: string; role: string; admit: string }> = {
  A: { label: "Auctioneer pass", word: "Auctioneer", role: "Pass · opens a room", admit: "Admit one" },
  D: { label: "Delegate pass", word: "Delegate", role: "Pass · takes a seat", admit: "Admit one" },
};

/* Monograms on a 100 x 100 grid. Bladed letterforms: straight cuts, a
   counter punched with even-odd, and a blade struck through like a gavel's
   handle across the A and a spur off the D's stem. */
const GLYPH: Record<PassKind, { body: string; blade: string; spark: string }> = {
  A: {
    body: "M50 4 L92 96 L70 96 L61.5 75 L38.5 75 L30 96 L8 96 Z M50 33 L58 58 L42 58 Z",
    blade: "M0 66.5 L50 62.5 L100 66.5 L50 70.5 Z",
    spark: "M50 -12 L54 -5 L50 2 L46 -5 Z",
  },
  D: {
    body: "M16 4 L54 4 C80 4 95 24 95 50 C95 76 80 96 54 96 L16 96 Z M37 24 L52 24 C66 24 73 36 73 50 C73 64 66 76 52 76 L37 76 Z",
    blade: "M2 50 L30 46.5 L50 50 L30 53.5 Z",
    spark: "M16 -12 L20 -5 L16 2 L12 -5 Z",
  },
};

const FOIL: Record<PassKind, { stops: [string, string, string, string]; ink: string; blade: string }> = {
  A: { stops: ["#fff8dc", "#ffe08a", "#e3a92c", "#8a5a08"], ink: "#2e1d02", blade: "#fff3c4" },
  D: { stops: ["#ffffff", "#d6e6ff", "#7aa8ff", "#1d4fbf"], ink: "#020c2c", blade: "#e7f0ff" },
};

/** Fine wave lines, the security print of a banknote. */
function guilloche(): string {
  const lines: string[] = [];
  for (let i = 0; i < 16; i++) {
    const phase = i * 0.42;
    const amp = 6 + (i % 4) * 2.2;
    let d = "";
    for (let x = 0; x <= 160; x += 4) {
      const y = 6 + i * 6.2 + Math.sin(x / 11 + phase) * amp * 0.5 + Math.sin(x / 5.3 + phase * 2) * 1.2;
      d += `${x === 0 ? "M" : "L"}${x} ${y.toFixed(2)} `;
    }
    lines.push(d);
  }
  return lines.join("");
}

const GUILLOCHE = guilloche();

function standInSerial(kind: PassKind, seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${kind}-${String(h % 10000).padStart(4, "0")}-${(h >>> 8).toString(36).slice(0, 4).toUpperCase().padEnd(4, "X")}`;
}

export default function AuctionPass({
  kind,
  size = "md",
  count,
  serial,
  intro = false,
  tilt = true,
  greyWhenEmpty = true,
  className = "",
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, "");
  const copy = COPY[kind];
  const glyph = GLYPH[kind];
  const foil = FOIL[kind];
  const printed = useMemo(() => serial ?? standInSerial(kind, uid), [serial, kind, uid]);
  const empty = greyWhenEmpty && count === 0;

  useGSAP(
    (_context, contextSafe) => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const body = root.current!.querySelector<HTMLElement>(".pass__body")!;
        const outline = root.current!.querySelector<SVGPathElement>(".pass__mono-outline")!;
        const sheen = root.current!.querySelector<HTMLElement>(".pass__sheen")!;

        if (intro) {
          const length = outline.getTotalLength();
          gsap
            .timeline()
            .from(root.current, { autoAlpha: 0, duration: 0.25 })
            .from(body, { rotationY: -38, rotationX: 10, scale: 0.84, duration: 0.85, ease: "back.out(1.6)" }, 0)
            .fromTo(
              outline,
              { strokeDasharray: length, strokeDashoffset: length },
              { strokeDashoffset: 0, duration: 1.05, ease: "power2.inOut" },
              0.15,
            )
            .from(".pass__mono-fill", { opacity: 0, duration: 0.55, ease: "power1.out" }, 0.7)
            .from(".pass__mono-blade", { scaleX: 0, transformOrigin: "50% 50%", duration: 0.45, ease: "power3.out" }, 0.85)
            .from(".pass__mono-spark", { scale: 0, rotation: -90, transformOrigin: "50% 50%", duration: 0.5, ease: "back.out(3)" }, 1.05)
            .from(
              ".pass__brand, .pass__label, .pass__admit, .pass__serial, .pass__stub span",
              { y: 6, autoAlpha: 0, stagger: 0.06, duration: 0.4, ease: "power2.out" },
              0.55,
            );
        }

        gsap.set(sheen, { xPercent: -160, skewX: -14 });
        gsap.to(sheen, {
          xPercent: 380,
          duration: 1.5,
          ease: "power2.inOut",
          repeat: -1,
          repeatDelay: 3.4,
          delay: intro ? 1.3 : gsap.utils.random(0.2, 2.4),
        });

        if (!tilt) return;
        const rx = gsap.quickTo(body, "rotationX", { duration: 0.5, ease: "power3.out" });
        const ry = gsap.quickTo(body, "rotationY", { duration: 0.5, ease: "power3.out" });
        const move = contextSafe!((event: PointerEvent) => {
          const box = root.current!.getBoundingClientRect();
          const px = (event.clientX - box.left) / box.width;
          const py = (event.clientY - box.top) / box.height;
          ry((px - 0.5) * 18);
          rx((0.5 - py) * 14);
          root.current!.style.setProperty("--gx", `${px * 100}%`);
          root.current!.style.setProperty("--gy", `${py * 100}%`);
        });
        const leave = contextSafe!(() => {
          rx(0);
          ry(0);
        });
        const el = root.current!;
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerleave", leave);
        return () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerleave", leave);
        };
      });
      return () => mm.revert();
    },
    { scope: root, dependencies: [kind, intro, tilt] },
  );

  return (
    <div
      ref={root}
      className={`pass ${className}`}
      data-kind={kind}
      data-size={size}
      data-empty={empty ? "true" : undefined}
      role="img"
      aria-label={`${copy.label}${count !== undefined ? `, ${count} held` : ""}`}
    >
      <div className="pass__halo" aria-hidden />
      <div className="pass__body" aria-hidden>
        <svg className="pass__guilloche" viewBox="0 0 160 100" preserveAspectRatio="none">
          <path d={GUILLOCHE} fill="none" stroke="#fff" strokeWidth="0.35" />
          {[10, 16, 22, 28, 34].map((r) => (
            <circle key={r} cx="136" cy="50" r={r} fill="none" stroke="#fff" strokeWidth="0.3" />
          ))}
        </svg>

        <svg className="pass__mono" viewBox="0 0 100 100">
          <defs>
            <linearGradient id={`foil-${uid}`} x1="0" y1="0" x2="0.85" y2="1">
              <stop offset="0" stopColor={foil.stops[0]} />
              <stop offset="0.32" stopColor={foil.stops[1]} />
              <stop offset="0.7" stopColor={foil.stops[2]} />
              <stop offset="1" stopColor={foil.stops[3]} />
            </linearGradient>
            <linearGradient id={`bevel-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#fff" stopOpacity="0.85" />
              <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path className="pass__mono-fill" d={glyph.body} fill={`url(#foil-${uid})`} fillRule="evenodd" />
          <path className="pass__mono-fill" d={glyph.body} fill={`url(#bevel-${uid})`} fillRule="evenodd" opacity="0.35" />
          <path className="pass__mono-blade" d={glyph.blade} fill={foil.blade} stroke={foil.ink} strokeWidth="1.4" strokeLinejoin="miter" />
          <path
            className="pass__mono-outline"
            d={glyph.body}
            fill="none"
            stroke={foil.ink}
            strokeWidth="2.6"
            strokeLinejoin="miter"
            fillRule="evenodd"
          />
          <path className="pass__mono-spark" d={glyph.spark} fill={foil.blade} stroke={foil.ink} strokeWidth="1.2" />
        </svg>

        <div className="pass__perf" />
        <div className="pass__brand">AUCTONIQ</div>
        <div className="pass__label">
          {copy.word}
          <small>{copy.role}</small>
        </div>
        <div className="pass__admit">{copy.admit}</div>
        <div className="pass__serial">{printed}</div>
        <div className="pass__stub">
          <span>{kind === "A" ? "Gold" : "Blue"} entry</span>
        </div>

        <div className="pass__sheen" />
        <div className="pass__glare" />
      </div>
      {count !== undefined && <div className="pass__count">×{count}</div>}
    </div>
  );
}
