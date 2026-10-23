/**
 * MySquad.tsx
 * The bidder's own squad, kept for them as the hammer falls: who they have
 * bought, organised the way AUCTEAM sheets a side, and where their budget
 * and the room's limits leave them.
 *
 * Read from the room (GET /api/v1/auction/squad, auction/squad.py) and read
 * again whenever this franchise's spend or squad size changes, so it is
 * never a list the bidder has to keep by hand. Works the same in online and
 * offline rooms: an offline sale logged by the auctioneer lands here too.
 *
 *   budget     a ring of purse left (GSAP), spend, average buy, and the
 *              AUCTONIQ value of the squad against what it cost
 *   limits     squad, overseas and uncapped against the room's minimums and
 *              maximums -- the rules that will refuse a bid later
 *   needs      what is still owed, and the playing-XI positions short of
 *              AUCTEAM's bands
 *   positions  Batters, Wicketkeeper, All-Rounders, Bowlers, each buy with
 *              its price and the room's verdict on it
 *
 * Framer Motion slides the drawer and settles the cards; GSAP draws the ring,
 * pops the newest buy in, and pulses the button when one lands while closed.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Users, X } from "lucide-react";

import { apiUrl } from "../../console/apiBase";
import { franchiseByCode } from "../../console/franchises";
import type { AuctionSocket } from "../../hooks/useAuctionSocket";
import { crore } from "./blockTypes";

gsap.registerPlugin(useGSAP);

interface SquadPlayer {
  id: number;
  name: string;
  role: string;
  country: string | null;
  overseas: boolean;
  uncapped: boolean;
  rating: number | null;
  base: number;
  price: number;
  expected: number | null;
  verdict: "steal" | "good bid" | "fair price" | "paid over" | null;
  seq: number | null;
}

interface Squad {
  team: { id: number; code: string; name: string; color?: string | null };
  groups: { role: "BAT" | "WK" | "AR" | "BWL"; name: string; players: SquadPlayer[] }[];
  budget: { purse: number; spent: number; left: number; avg_price: number; value: number };
  limits: {
    size: number; max_squad: number; min_squad: number;
    overseas: number; max_overseas: number; min_overseas: number;
    uncapped: number; min_uncapped: number;
  };
  needs: { to_min_squad: number; overseas: number; uncapped: number; places_left: number };
  xi: { positions: { role: string; name: string; have: number; min: number; max: number; short: number }[]; short: number; ready: boolean };
  latest: SquadPlayer | null;
}

const VERDICT_TONE: Record<string, string> = {
  steal: "#34D399",
  "good bid": "#22D3EE",
  "fair price": "#F6C45A",
  "paid over": "#FB923C",
};

const ROLE_TONE: Record<string, string> = { BAT: "#4D8DF6", WK: "#C084FC", AR: "#34D399", BWL: "#FB923C" };

const SINGULAR: Record<string, string> = { BAT: "batter", WK: "wicketkeeper", AR: "all-rounder", BWL: "bowler" };

function signed(lakh: number): string {
  if (lakh === 0) return "±0";
  return `${lakh > 0 ? "+" : "−"}${crore(Math.abs(lakh))}`;
}

export default function MySquad({ socket }: { socket: AuctionSocket }) {
  const team = socket.myTeam;
  const code = socket.state?.room ?? "MAIN";
  const [open, setOpen] = useState(false);
  const [squad, setSquad] = useState<Squad | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const seenLatest = useRef<number | null | undefined>(undefined);
  const reduce = useReducedMotion();

  // Read again whenever this franchise's position changes.
  const signature = team ? `${team.size}:${team.spent}` : "";
  useEffect(() => {
    if (!team) return;
    let live = true;
    fetch(apiUrl(`/api/v1/auction/squad?room=${encodeURIComponent(code)}&team=${team.id}`), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => live && body && setSquad(body as Squad))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [code, team?.id, signature]);

  // A buy landing while the drawer is shut pulses the button.
  const { contextSafe } = useGSAP();
  const pulse = contextSafe(() => {
    if (reduce || !button.current) return;
    gsap.fromTo(
      button.current,
      { boxShadow: "0 0 0 0 rgba(246,196,90,0.9)", scale: 1.08 },
      { boxShadow: "0 0 0 14px rgba(246,196,90,0)", scale: 1, duration: 0.9, ease: "power2.out", clearProps: "boxShadow,transform" },
    );
  });
  useEffect(() => {
    const latest = squad?.latest?.seq ?? null;
    if (seenLatest.current !== undefined && latest !== null && latest !== seenLatest.current && !open) pulse();
    if (squad) seenLatest.current = latest;
  }, [squad, open, pulse]);

  if (!team) return null;
  const size = squad?.limits.size ?? team.size;

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded border border-amber-400/50 bg-amber-400/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200 transition-colors hover:bg-amber-400/20"
        data-testid="my-squad-button"
      >
        <Users size={12} /> My squad · {size}
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="scrim"
              className="fixed inset-0 z-[60] bg-black/50"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />
            <motion.aside
              key="drawer"
              role="dialog"
              aria-label="My squad"
              initial={reduce ? { opacity: 0 } : { x: "100%" }}
              animate={{ x: 0, opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { x: "100%" }}
              transition={{ type: "spring", stiffness: 320, damping: 34 }}
              className="fixed inset-y-0 right-0 z-[61] flex w-[min(460px,100vw)] flex-col overflow-hidden border-l border-neutral-800 bg-neutral-950 text-neutral-100"
              data-testid="my-squad"
            >
              {squad ? <Drawer squad={squad} onClose={() => setOpen(false)} /> : (
                <p className="p-6 font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">Reading your squad…</p>
              )}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function Drawer({ squad, onClose }: { squad: Squad; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const tone = franchiseByCode(squad.team.code)?.primary ?? squad.team.color ?? "#F6C45A";
  const { budget, limits, needs, xi } = squad;
  const leftShare = budget.purse ? Math.max(0, budget.left) / budget.purse : 0;
  const R = 42;
  const C = 2 * Math.PI * R;

  useGSAP(
    () => {
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        gsap.fromTo(".ring-left", { strokeDashoffset: C }, { strokeDashoffset: C * (1 - leftShare), duration: 1.1, ease: "power3.out" });
        gsap.from(".squad-section", { y: 14, autoAlpha: 0, duration: 0.45, stagger: 0.07, ease: "power3.out", delay: 0.15, clearProps: "transform,opacity,visibility" });
        gsap.from(".limit-fill", { scaleX: 0, transformOrigin: "left center", duration: 0.7, stagger: 0.08, ease: "power3.out", delay: 0.2 });
      });
    },
    { scope: root, dependencies: [] },
  );

  // The newest buy pops in when it arrives while the drawer is open.
  const latest = squad.latest?.seq ?? null;
  const shown = useRef(latest);
  useEffect(() => {
    if (latest === null || latest === shown.current) return;
    shown.current = latest;
    if (reduce) return;
    const card = root.current?.querySelector(`[data-seq="${latest}"]`);
    if (card) {
      gsap.fromTo(card, { scale: 0.85, boxShadow: `0 0 0 2px ${tone}, 0 0 28px ${tone}` }, { scale: 1, boxShadow: "0 0 0 0 rgba(0,0,0,0)", duration: 1, ease: "back.out(2)", clearProps: "boxShadow,transform" });
    }
  }, [latest, reduce, tone]);

  return (
    <div ref={root} className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-5 py-4">
        <span className="h-9 w-1 rounded-full" style={{ background: tone }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">My squad</div>
          <div className="font-display text-2xl font-bold uppercase leading-tight">{squad.team.name}</div>
        </div>
        <button type="button" aria-label="Close my squad" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full text-neutral-400 hover:bg-white/10 hover:text-white">
          <X size={16} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {/* Budget. */}
        <section className="squad-section mt-5 flex items-center gap-5" aria-label="Budget">
          <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0 -rotate-90" aria-hidden>
            <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="9" />
            <circle
              className="ring-left"
              cx="50" cy="50" r={R} fill="none" stroke={tone} strokeWidth="9" strokeLinecap="round"
              strokeDasharray={C} strokeDashoffset={C * (1 - leftShare)}
            />
          </svg>
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-neutral-500">Purse left</div>
            <div className="font-display text-4xl font-bold tabular-nums">{crore(budget.left)}</div>
            <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[11px] text-neutral-400">
              <span>spent <b className="text-neutral-100">{crore(budget.spent)}</b></span>
              <span>avg <b className="text-neutral-100">{budget.avg_price ? crore(budget.avg_price) : "—"}</b></span>
              <span className="col-span-2" title="AUCTONIQ value of the squad minus what it cost, calibrated to this room">
                value{" "}
                <b style={{ color: budget.value > 0 ? "#34D399" : budget.value < 0 ? "#FB923C" : undefined }}>{signed(budget.value)}</b>
              </span>
            </div>
          </div>
        </section>

        {/* The room's limits. */}
        <section className="squad-section mt-6 space-y-3" aria-label="Limits">
          <Limit label="Squad" have={limits.size} min={limits.min_squad} max={limits.max_squad} tone={tone} />
          <Limit label="Overseas" have={limits.overseas} min={limits.min_overseas} max={limits.max_overseas} tone="#22D3EE" />
          <Limit label="Uncapped" have={limits.uncapped} min={limits.min_uncapped} max={Math.max(limits.min_uncapped, limits.uncapped, 1) * 3} tone="#C084FC" hideMax />
        </section>

        {/* What is still owed. */}
        <section className="squad-section mt-5 flex flex-wrap gap-2" aria-label="Still needed">
          {needs.to_min_squad > 0 && <Need tone="#F6C45A">{needs.to_min_squad} more to reach the minimum squad</Need>}
          {needs.overseas > 0 && <Need tone="#22D3EE">{needs.overseas} overseas still owed</Need>}
          {needs.uncapped > 0 && <Need tone="#C084FC">{needs.uncapped} uncapped still owed</Need>}
          {xi.ready ? (
            <Need tone="#34D399">A legal playing XI is in the squad</Need>
          ) : (
            xi.positions.filter((p) => p.short > 0).map((p) => (
              <Need key={p.role} tone={ROLE_TONE[p.role]}>
                XI: {p.short} {SINGULAR[p.role]}{p.short === 1 ? "" : "s"} short
              </Need>
            ))
          )}
        </section>

        {/* The squad, by position. */}
        {squad.groups.map((group) => {
          const band = xi.positions.find((p) => p.role === group.role);
          return (
            <section key={group.role} className="squad-section mt-6" aria-label={group.name}>
              <div className="flex items-baseline justify-between border-b border-neutral-800 pb-1.5">
                <h3 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-neutral-300">
                  <span className="h-2 w-2 rounded-sm" style={{ background: ROLE_TONE[group.role] }} aria-hidden />
                  {group.name}
                </h3>
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                  {group.players.length}{band ? ` · XI ${band.min}–${band.max}` : ""}
                </span>
              </div>
              {group.players.length === 0 ? (
                <p className="mt-2 font-mono text-[11px] text-neutral-600">None yet.</p>
              ) : (
                <motion.ul layout className="mt-2 space-y-1.5">
                  <AnimatePresence initial={false}>
                    {group.players.map((p) => (
                      <motion.li
                        key={p.id}
                        layout
                        data-seq={p.seq ?? undefined}
                        initial={reduce ? false : { opacity: 0, x: 24 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0 }}
                        className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/70 px-3 py-2"
                        data-testid="squad-player"
                      >
                        <span className="h-8 w-[3px] shrink-0 rounded-full" style={{ background: ROLE_TONE[group.role] }} aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-semibold text-white">{p.name}</div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
                            {p.country && <span>{p.country}</span>}
                            {p.overseas && <span className="text-cyan-300">overseas</span>}
                            {p.uncapped && <span className="text-purple-300">uncapped</span>}
                            {p.rating !== null && <span>rating {p.rating}</span>}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-display text-lg font-bold tabular-nums">{crore(p.price)}</div>
                          {p.verdict && (
                            <span className="rounded-full px-1.5 py-px font-mono text-[9px] font-bold uppercase text-[#020617]" style={{ background: VERDICT_TONE[p.verdict] }}>
                              {p.verdict}
                            </span>
                          )}
                        </div>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </motion.ul>
              )}
            </section>
          );
        })}

        {squad.groups.every((g) => g.players.length === 0) && (
          <p className="mt-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-neutral-600">
            Your squad builds here as the hammer falls.
          </p>
        )}
      </div>
    </div>
  );
}

function Limit({ label, have, min, max, tone, hideMax = false }: {
  label: string; have: number; min: number; max: number; tone: string; hideMax?: boolean;
}) {
  const scale = Math.max(max, have, 1);
  const short = have < min;
  return (
    <div>
      <div className="flex items-baseline justify-between font-mono text-[11px] uppercase tracking-[0.18em]">
        <span className="text-neutral-400">{label}</span>
        <span className="tabular-nums text-neutral-200">
          {have}{hideMax ? "" : `/${max}`}
          <span className="ml-2 text-neutral-500">min {min}</span>
        </span>
      </div>
      <div className="relative mt-1 h-2 overflow-hidden rounded-full bg-white/[0.07]">
        <div className="limit-fill h-full rounded-full" style={{ width: `${(have / scale) * 100}%`, background: short ? "#FB923C" : tone }} />
        {min > 0 && (
          <span className="absolute inset-y-0 w-[2px] bg-white/70" style={{ left: `${Math.min(100, (min / scale) * 100)}%` }} title={`minimum ${min}`} aria-hidden />
        )}
      </div>
    </div>
  );
}

function Need({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className="rounded-full border px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.12em]" style={{ borderColor: `${tone}66`, color: tone, background: `${tone}14` }}>
      {children}
    </span>
  );
}
