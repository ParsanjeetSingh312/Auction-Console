/**
 * WarRoomTrigger.tsx
 * The landing's main panel: a lot playing out, and the door to the war room.
 *
 * It used to share the right column with Trending Players. That card is gone
 * (kept on disk, unmounted) and this one takes the whole column, so it carries
 * more than a still: scripted lots play on a loop -- four franchises bidding
 * a trending player up from the base, a clock that drains between bids, the
 * hammer -- and then the next trending player (Kohli, Dhoni, Rohit, Bumrah,
 * Jadeja, KL Rahul) comes to the block. See LOTS.
 *
 * **It is a simulation and says so.** The header reads "Simulated", the
 * figures come from LOTS below, and nothing here reads the auction socket.
 * The real bid control is BlockView's, inside the overlay; nothing on the
 * landing can reach a live room.
 *
 * MOTION, AND WHO OWNS WHAT
 * =========================
 *
 *   GSAP           the bid figure rolling up, the clock bar draining
 *   Framer Motion  the leader swapping in, the rival bars springing to length,
 *                  the SOLD stamp, the panel's hover lift
 *
 * Every figure is in the DOM in its final form from the first render; the
 * tweens only write on ticks. Where requestAnimationFrame never runs (a hidden
 * tab, a reduced-motion setting, a headless capture) the panel shows the sold
 * state and nothing is blank. The loop stops while the panel is off screen.
 */
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";

import GlowingButton from "../UI/GlowingButton";
import { FRANCHISES, type FranchiseCode } from "../../console/franchises";
import { SHOWCASE_PLAYERS } from "../../utils/players";

// The overlay pulls in the whole block view and its animations. Nobody who
// never opens the demo should download it.
const WarRoomOverlay = lazy(() => import("./WarRoomOverlay"));

interface DemoLot {
  jersey: string;
  name: string;
  base: number;
  /** The shirt tile's colour: the player's franchise accent. */
  tint: string;
  /** The four bidders, in the order their rows are drawn. */
  bidders: FranchiseCode[];
  /** The replayed bids, in order. Amounts in crore; the last one wins. */
  script: { team: FranchiseCode; amount: number }[];
}

/** Find a trending player's card data, so names and shirts match the showcase. */
function trending(surname: string) {
  const player = SHOWCASE_PLAYERS.find((p) => p.surname === surname);
  if (!player) throw new Error(`No showcase player named ${surname}`);
  return {
    jersey: String(player.number),
    name: `${player.name} ${player.surname}`,
    tint: player.accent,
  };
}

/**
 * The lots the panel rotates through: every trending player in turn, each with
 * its own room and its own hammer price, so the landing never looks like it
 * only knows one name.
 */
const LOTS: DemoLot[] = [
  {
    ...trending("Kohli"),
    base: 2.0,
    bidders: ["MUM", "CHE", "BLR", "KOL"],
    script: [
      { team: "KOL", amount: 5.0 },
      { team: "BLR", amount: 10.0 },
      { team: "CHE", amount: 14.5 },
      { team: "BLR", amount: 16.0 },
      { team: "CHE", amount: 18.0 },
      { team: "MUM", amount: 20.0 },
    ],
  },
  {
    ...trending("Dhoni"),
    base: 2.0,
    bidders: ["CHE", "MUM", "RAJ", "DEL"],
    script: [
      { team: "DEL", amount: 4.0 },
      { team: "CHE", amount: 8.5 },
      { team: "MUM", amount: 11.0 },
      { team: "RAJ", amount: 14.0 },
      { team: "CHE", amount: 16.5 },
    ],
  },
  {
    ...trending("Sharma"),
    base: 2.0,
    bidders: ["MUM", "HYD", "PBK", "LKO"],
    script: [
      { team: "PBK", amount: 6.0 },
      { team: "MUM", amount: 9.5 },
      { team: "LKO", amount: 12.0 },
      { team: "MUM", amount: 15.0 },
      { team: "HYD", amount: 17.5 },
      { team: "MUM", amount: 19.0 },
    ],
  },
  {
    ...trending("Bumrah"),
    base: 2.0,
    bidders: ["MUM", "BLR", "AHM", "CHE"],
    script: [
      { team: "AHM", amount: 7.0 },
      { team: "MUM", amount: 12.0 },
      { team: "BLR", amount: 15.5 },
      { team: "AHM", amount: 18.0 },
      { team: "MUM", amount: 21.0 },
      { team: "BLR", amount: 22.5 },
    ],
  },
  {
    ...trending("Jadeja"),
    base: 2.0,
    bidders: ["RAJ", "CHE", "KOL", "HYD"],
    script: [
      { team: "KOL", amount: 5.0 },
      { team: "CHE", amount: 8.0 },
      { team: "RAJ", amount: 11.0 },
      { team: "HYD", amount: 12.5 },
      { team: "CHE", amount: 14.0 },
      { team: "RAJ", amount: 15.5 },
    ],
  },
  {
    ...trending("Rahul"),
    base: 2.0,
    bidders: ["DEL", "LKO", "PBK", "BLR"],
    script: [
      { team: "LKO", amount: 6.5 },
      { team: "DEL", amount: 9.0 },
      { team: "BLR", amount: 11.5 },
      { team: "LKO", amount: 13.0 },
      { team: "DEL", amount: 14.5 },
    ],
  },
];

const STEP_MS = 1700;
const SOLD_HOLD_MS = 3200;

const lastStep = (lot: DemoLot) => lot.script.length - 1;
const topBid = (lot: DemoLot) => lot.script[lastStep(lot)].amount;

/** Each bidder's highest bid once `step` bids have been placed. */
function standing(lot: DemoLot, step: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const code of lot.bidders) out[code] = 0;
  for (let i = 0; i <= step; i++) out[lot.script[i].team] = lot.script[i].amount;
  return out;
}

export default function WarRoomTrigger() {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();

  // Starts at the first lot's sold state, so the panel is complete before any tick.
  const [lotIndex, setLotIndex] = useState(0);
  const [step, setStep] = useState(lastStep(LOTS[0]));
  const [sold, setSold] = useState(true);

  const panelRef = useRef<HTMLElement>(null);
  const bidRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<HTMLDivElement>(null);
  const shown = useRef(topBid(LOTS[0]));

  // The loop: bid, bid, ... sold, hold, then the next player. Off screen, it waits.
  useEffect(() => {
    if (reduced) return;
    const panel = panelRef.current;
    if (!panel) return;

    let visible = true;
    let timer: number | undefined;
    // The first lot is already on screen, sold; the loop opens on the second.
    let lot = 0;
    let cursor = lastStep(LOTS[0]);

    const tick = () => {
      if (!visible || document.hidden) {
        timer = window.setTimeout(tick, 600);
        return;
      }
      const LAST = lastStep(LOTS[lot]);
      if (cursor >= LAST) {
        // Hammer has fallen: bring the next trending player to the block.
        lot = (lot + 1) % LOTS.length;
        cursor = -1;
        setLotIndex(lot);
      }
      cursor += 1;
      setSold(false);
      setStep(cursor);
      if (cursor === lastStep(LOTS[lot])) {
        timer = window.setTimeout(() => {
          setSold(true);
          timer = window.setTimeout(tick, SOLD_HOLD_MS);
        }, STEP_MS);
      } else {
        timer = window.setTimeout(tick, STEP_MS);
      }
    };

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    io.observe(panel);
    timer = window.setTimeout(tick, 900);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, [reduced]);

  // The bid figure rolls from the last shown amount to the new one.
  const LOT = LOTS[lotIndex];
  const TOP = topBid(LOT);

  useEffect(() => {
    const el = bidRef.current;
    const target = LOT.script[step].amount;
    if (!el || reduced) {
      shown.current = target;
      return;
    }
    const counter = { v: step === 0 ? LOT.base : shown.current };
    const tween = gsap.to(counter, {
      v: target,
      duration: 0.7,
      ease: "power3.out",
      onUpdate: () => {
        el.textContent = counter.v.toFixed(1);
      },
      onComplete: () => {
        el.textContent = target.toFixed(1);
        shown.current = target;
      },
    });
    return () => {
      tween.kill();
    };
  }, [LOT, step, reduced]);

  // The clock: full on every bid, draining until the next one or the hammer.
  useEffect(() => {
    const el = clockRef.current;
    if (!el || reduced) return;
    if (sold) {
      gsap.to(el, { scaleX: 0, duration: 0.25, ease: "power2.out" });
      return;
    }
    const tween = gsap.fromTo(
      el,
      { scaleX: 1 },
      { scaleX: 0, duration: STEP_MS / 1000, ease: "none" },
    );
    return () => {
      tween.kill();
    };
  }, [step, sold, reduced]);

  const leader = LOT.script[step];
  const lead = FRANCHISES[leader.team];
  const bids = standing(LOT, step);

  return (
    <>
      <motion.article
        ref={panelRef}
        className="neon-card war-room-card flex h-full flex-col p-5 sm:p-6"
        whileHover={reduced ? undefined : { y: -4 }}
        transition={{ type: "spring", stiffness: 260, damping: 24 }}
        aria-label="War room demo: a simulated lot"
      >
        <header className="flex items-center justify-between gap-3">
          <h2 className="font-stadium text-[22px] font-semibold uppercase tracking-[0.05em] text-auctiq-text">
            War Room Demo
          </h2>
          <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 font-tech text-[10px] uppercase tracking-[0.2em] text-auctiq-dim">
            <span className="war-room-pulse" aria-hidden />
            Simulated lot
          </span>
        </header>
        <div className="neon-rule mt-2.5" />

        {/* The lot: shirt, name, and the figure the room is watching. */}
        {/* Keyed on the player, so each new lot slides in rather than snapping. */}
        <motion.div
          key={LOT.name}
          initial={reduced ? false : { opacity: 0, x: 18 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className="mt-5 flex items-center gap-4"
        >
          <span
            aria-hidden
            className="grid h-[92px] w-[92px] shrink-0 place-items-center rounded-xl border font-num text-[44px] font-bold tabular-nums"
            style={{
              color: LOT.tint,
              borderColor: `${LOT.tint}66`,
              background: `linear-gradient(160deg, ${LOT.tint}33, ${LOT.tint}0d)`,
              boxShadow: `0 0 36px -14px ${LOT.tint}`,
            }}
          >
            {LOT.jersey}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-tech text-[10.5px] uppercase tracking-[0.22em] text-auctiq-dim">
              On the block · base ₹{LOT.base.toFixed(1)} Cr
            </p>
            <p className="mt-0.5 truncate font-tech text-[17px] font-semibold uppercase tracking-[0.06em] text-auctiq-text">
              {LOT.name}
            </p>
            <p className="mt-1 flex items-baseline gap-1.5 font-num font-bold leading-none tabular-nums text-neon-cyan">
              <span className="text-[16px] font-semibold">₹</span>
              <span ref={bidRef} className="text-[46px]">
                {TOP.toFixed(1)}
              </span>
              <span className="text-[17px] font-semibold uppercase tracking-[0.04em]">Crore</span>
            </p>
          </div>
        </motion.div>

        {/* Who holds the bid. Swaps in on every raise. */}
        <div className="mt-4 flex h-[44px] items-center gap-2 overflow-hidden">
          <span className="font-tech text-[10.5px] uppercase tracking-[0.2em] text-auctiq-dim">
            {sold ? "Sold to" : "Leading"}
          </span>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={`${leader.team}-${step}-${sold}`}
              initial={reduced ? false : { y: 18, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={reduced ? undefined : { y: -18, opacity: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 28 }}
              className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1 font-tech text-[12.5px] font-semibold uppercase tracking-[0.1em] text-auctiq-text"
              style={{ borderColor: `${lead.primary}80`, background: `${lead.primary}1f` }}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: lead.primary }} />
              {lead.name}
            </motion.span>
          </AnimatePresence>
          <AnimatePresence>
            {sold && (
              <motion.span
                key="sold"
                initial={reduced ? false : { scale: 1.8, rotate: -12, opacity: 0 }}
                animate={{ scale: 1, rotate: -6, opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ type: "spring", stiffness: 420, damping: 18 }}
                className="ml-auto rounded-md border-2 border-neon-orange px-2.5 py-0.5 font-stadium text-[18px] font-bold uppercase tracking-[0.12em] text-neon-orange"
              >
                Sold
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* The clock between bids. */}
        <div className="mt-3 h-[3px] overflow-hidden rounded-full bg-white/10" aria-hidden>
          <div
            ref={clockRef}
            className="h-full w-full origin-left rounded-full"
            style={{
              background: "linear-gradient(90deg, #22D3EE, #FB923C)",
              transform: "scaleX(0)",
            }}
          />
        </div>

        {/* The paddles: each franchise's best bid, as a bar against the top. */}
        <ul className="mt-5 space-y-3">
          {LOT.bidders.map((code) => {
            const team = FRANCHISES[code];
            const amount = bids[code];
            const leading = code === leader.team;
            return (
              <li key={code} className="grid grid-cols-[92px_minmax(0,1fr)_64px] items-center gap-3">
                <span
                  className={`flex items-center gap-2 font-tech text-[12px] uppercase tracking-[0.1em] ${
                    leading ? "font-semibold text-auctiq-text" : "text-auctiq-dim"
                  }`}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: team.primary }} />
                  {team.name}
                </span>
                <span className="h-[7px] overflow-hidden rounded-full bg-white/[0.06]">
                  <motion.span
                    className="[display:block] h-full rounded-full"
                    style={{
                      background: `linear-gradient(90deg, ${team.primary}99, ${team.primary})`,
                      boxShadow: leading ? `0 0 14px ${team.primary}` : undefined,
                    }}
                    initial={false}
                    animate={{ width: `${(amount / TOP) * 100}%` }}
                    transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 140, damping: 20 }}
                  />
                </span>
                <span
                  className={`text-right font-num text-[14px] font-bold tabular-nums ${
                    leading ? "text-neon-cyan" : "text-auctiq-dim"
                  }`}
                >
                  {amount ? `${amount.toFixed(1)} Cr` : "—"}
                </span>
              </li>
            );
          })}
        </ul>

        <p className="mt-5 font-tech text-[11.5px] leading-relaxed text-auctiq-dim">
          Ten franchises, one purse each, rules enforced by the room. Step inside and bid against
          the clock.
        </p>

        {/* `mt-auto` pins the controls to the foot of the panel. */}
        <div className="mt-auto flex gap-3 pt-5">
          <GlowingButton
            tone="solid"
            className="min-h-[50px] text-[12.5px]"
            onClick={() => setOpen(true)}
          >
            Enter War Room
          </GlowingButton>
          <GlowingButton
            tone="outline"
            className="min-h-[50px] text-[12.5px]"
            onClick={() => setOpen(true)}
          >
            Watch
          </GlowingButton>
        </div>
      </motion.article>

      {open && (
        <Suspense fallback={null}>
          <WarRoomOverlay open={open} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
