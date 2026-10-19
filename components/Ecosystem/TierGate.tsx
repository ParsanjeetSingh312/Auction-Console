/**
 * TierGate.tsx
 * The screen in place of a feature this account's tier does not include:
 * AUCTEAM for Auctioneer and Free accounts, the Data Interface for Delegates.
 *
 * The feature's page is not removed or changed -- it is simply not rendered
 * for this tier -- so an account that can use it sees it exactly as before.
 *
 * GSAP plays the lock once: the shackle lifts, drops and snaps shut, and the
 * pass that opens the feature settles in beside it. Framer Motion staggers the
 * copy and buttons in.
 */
import { useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import AuctiqNav from "../Global/AuctiqNav";
import StadiumBackdrop from "../Sections/StadiumBackdrop";
import AuctionPass from "../Passes/AuctionPass";
import { logOut } from "../../console/accountStore";
import type { PassKind } from "../../console/ecosystemStore";

gsap.registerPlugin(useGSAP);

export interface GateAction {
  label: string;
  to: string;
  primary?: boolean;
  /** Log out first: the way to "sign up with a Delegate account" while signed in. */
  signOut?: boolean;
}

interface Props {
  eyebrow: string;
  title: string;
  body: string;
  pass?: PassKind;
  actions: GateAction[];
}

export default function TierGate({ eyebrow, title, body, pass, actions }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap
          .timeline({ delay: 0.25 })
          .from(".gate-lock", { scale: 0.6, autoAlpha: 0, duration: 0.5, ease: "back.out(2)" })
          .to(".gate-shackle", { y: -9, duration: 0.35, ease: "power2.out" }, "+=0.15")
          .to(".gate-shackle", { y: 0, duration: 0.28, ease: "bounce.out" })
          .fromTo(".gate-click", { scale: 0.4, autoAlpha: 0.9 }, { scale: 2.2, autoAlpha: 0, duration: 0.6, ease: "power2.out" }, "<0.12")
          .from(".gate-pass", { x: 40, rotation: 8, autoAlpha: 0, duration: 0.7, ease: "power3.out" }, "<");
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  const tone = pass === "A" ? "#F6C45A" : "#4D8DF6";

  return (
    <div ref={root} className="auctiq relative min-h-screen overflow-x-clip bg-auctiq-void text-auctiq-text">
      <StadiumBackdrop variant="console" />
      <div className="auctiq-stadium" aria-hidden />
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0 bg-[linear-gradient(180deg,rgba(2,6,23,0.6),rgba(2,6,23,0.94))]" />
      <AuctiqNav />

      <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-[980px] items-center px-5 pb-16 pt-[150px] sm:px-8 sm:pt-[110px]">
        <div className="grid w-full items-center gap-10 md:grid-cols-[1.2fr_1fr]">
          <motion.div
            className="min-w-0"
            initial="hidden"
            animate="show"
            variants={{ show: { transition: { staggerChildren: 0.08, delayChildren: 0.15 } } }}
          >
            <motion.div variants={{ hidden: { opacity: 0 }, show: { opacity: 1 } }} className="relative mb-6 h-[74px] w-[64px]">
              <svg className="gate-lock h-full w-full overflow-visible" viewBox="0 0 64 74" aria-hidden>
                <circle className="gate-click" cx="32" cy="48" r="22" fill="none" stroke={tone} strokeWidth="2" opacity="0" />
                <path className="gate-shackle" d="M16 32 V20 a16 16 0 0 1 32 0 V32" fill="none" stroke={tone} strokeWidth="6" strokeLinecap="round" />
                <rect x="6" y="30" width="52" height="40" rx="9" fill="#0a0f1f" stroke={tone} strokeWidth="2.5" />
                <circle cx="32" cy="47" r="5" fill={tone} />
                <rect x="30" y="49" width="4" height="10" rx="2" fill={tone} />
              </svg>
            </motion.div>
            <motion.p
              variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}
              className="font-tech text-[11px] font-semibold uppercase tracking-[0.2em]"
              style={{ color: tone }}
            >
              {eyebrow}
            </motion.p>
            <motion.h1
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
              className="mt-2 break-words font-auctiq text-[27px] leading-[1.08] tracking-[0.01em] sm:text-[42px] sm:tracking-[0.02em]"
            >
              {title}
            </motion.h1>
            <motion.p
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
              className="mt-4 max-w-[520px] font-ui text-[14.5px] leading-relaxed text-auctiq-dim"
            >
              {body}
            </motion.p>
            <motion.div variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }} className="mt-7 flex flex-wrap gap-3">
              {actions.map((action) =>
                action.signOut ? (
                  <button
                    key={action.label}
                    type="button"
                    onClick={async () => {
                      await logOut();
                      navigate(action.to);
                    }}
                    className={action.primary ? PRIMARY : SECONDARY}
                    style={action.primary ? { background: `linear-gradient(180deg, ${pass === "A" ? "#ffe7a3" : "#cfe2ff"}, ${tone})` } : undefined}
                  >
                    {action.label}
                  </button>
                ) : (
                  <Link
                    key={action.label}
                    to={action.to}
                    className={action.primary ? PRIMARY : SECONDARY}
                    style={action.primary ? { background: `linear-gradient(180deg, ${pass === "A" ? "#ffe7a3" : "#cfe2ff"}, ${tone})` } : undefined}
                  >
                    {action.label}
                  </Link>
                ),
              )}
            </motion.div>
          </motion.div>

          {pass && (
            <div className="gate-pass flex justify-center md:justify-end">
              <AuctionPass kind={pass} size="lg" />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

const PRIMARY =
  "inline-flex min-h-11 items-center rounded-[8px] px-5 py-2 text-left font-tech text-[12px] font-bold uppercase tracking-[0.16em] text-[#020617] transition-transform active:scale-95";
const SECONDARY =
  "inline-flex h-11 items-center rounded-[8px] border border-white/20 px-5 font-tech text-[12px] font-semibold uppercase tracking-[0.14em] text-auctiq-text transition-colors hover:border-white/45";
