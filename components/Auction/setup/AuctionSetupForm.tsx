/**
 * AuctionSetupForm.tsx
 * Auction Setup, as the form an auctioneer fills in before the room opens.
 *
 * It opens by itself the first time the auctioneer reaches their station
 * (`state.setup_saved` is false until it is saved once), and from the Setup
 * button after that. Three sections, one Save:
 *
 *   1  Marking scheme   what each franchise's auction report is graded on,
 *                       in priority order, up to four factors
 *   2  Auction flow     the order the tiers of the pool come to the block in:
 *                       a priority the draw favours, not a queue it empties
 *   3  Auction rules    budget, squad and overseas limits -- the fields the
 *                       old setup dialog had, unchanged
 *
 * Nothing is applied until Save: the form holds a draft, and the room
 * confirms the change with its next broadcast (AdminSplitScreen `sendRules`).
 * The factors and tiers offered come from the room (`state.setup_options`,
 * `state.flow`), so the form can never offer one the server would refuse.
 *
 * Motion: GSAP brings the sheet and its sections in; Framer Motion's `layout`
 * carries a row to its new place when the order changes, which is the one
 * thing here that needs a shared-layout transition.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ArrowDown, ArrowUp, ClipboardCheck, Plus, Shuffle, SlidersHorizontal, X } from "lucide-react";

import type { Rules } from "../../../console/types";
import type { AuctionSocket, FlowTier, SetupOptions } from "../../../hooks/useAuctionSocket";

gsap.registerPlugin(useGSAP);

/** Used only if the room is too old to send its own catalogue. */
const FALLBACK_OPTIONS: SetupOptions = {
  max_factors: 4,
  factors: [
    { key: "balance", label: "Team balance", blurb: "Every role covered, a legal squad, spend not all in two players." },
    { key: "rating", label: "Average rating", blurb: "The squad's average rating against the pool." },
    { key: "bidding", label: "Team bidding", blurb: "Overbids cost marks; paying under or a steal earns them." },
  ],
  example_scheme: ["balance", "rating", "bidding"],
  lot_categories: [],
};

/** One colour per tier, chosen to read on the live room's dark ground. */
export const TIER_TONE: Record<string, string> = {
  marquee: "#F6C45A",
  prime: "#22D3EE",
  emerging: "#34D399",
  squad: "#94A3B8",
};

/** Priority order as weights: 40 / 30 / 20 / 10 for four. Mirrors the server. */
function rankWeights(count: number): number[] {
  const total = (count * (count + 1)) / 2;
  return Array.from({ length: count }, (_, index) => (count - index) / total);
}

/** How often each tier leads a draw: each is twice as likely as the next. */
function flowShares(count: number): number[] {
  const raw = Array.from({ length: count }, (_, index) => 2 ** (count - 1 - index));
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total);
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export interface AuctionSetupFormProps {
  socket: AuctionSocket;
  rules: Rules;
  /** True when the form opened by itself for a room not yet set up. */
  firstRun: boolean;
  /** Saving cannot work (an older backend build). */
  warning?: string | null;
  /** Saving works, but not at once (a player is on the block). */
  note?: string | null;
  onSave: (next: Rules) => void;
  onClose: () => void;
}

export default function AuctionSetupForm({
  socket,
  rules,
  firstRun,
  warning,
  note,
  onSave,
  onClose,
}: AuctionSetupFormProps) {
  const reduced = useReducedMotion();
  const sheet = useRef<HTMLDivElement>(null);
  const state = socket.state;
  const options = state?.setup_options ?? FALLBACK_OPTIONS;
  const tiers: FlowTier[] = state?.flow ?? [];
  const factorByKey = useMemo(
    () => Object.fromEntries(options.factors.map((factor) => [factor.key, factor])),
    [options.factors],
  );
  const tierByKey = useMemo(() => Object.fromEntries(tiers.map((tier) => [tier.key, tier])), [tiers]);

  const [scheme, setScheme] = useState<string[]>(() =>
    rules.markingScheme && rules.markingScheme.length > 0
      ? rules.markingScheme
      : firstRun
        ? options.example_scheme
        : [],
  );
  const [flow, setFlow] = useState<string[]>(() => rules.flow ?? tiers.map((tier) => tier.key));
  const [draft, setDraft] = useState({
    // Entered in crore, the unit the auction is spoken in; sent as lakh.
    purse: String(rules.purse / 100),
    maxSquad: String(rules.maxSquad),
    minSquad: String(rules.minSquad),
    maxOverseas: String(rules.maxOverseas),
    maxPlayers: String(rules.maxPlayers ?? ""),
    minOverseas: String(rules.minOverseas ?? ""),
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  useGSAP(
    () => {
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(sheet.current, { y: 26, opacity: 0, duration: 0.42, ease: "power3.out" });
        gsap.from(".setup-section", {
          y: 18,
          opacity: 0,
          duration: 0.4,
          ease: "power2.out",
          stagger: 0.09,
          delay: 0.12,
        });
      });
    },
    { scope: sheet },
  );

  const unused = options.factors.filter((factor) => !scheme.includes(factor.key));
  const full = scheme.length >= options.max_factors;
  const weights = rankWeights(scheme.length);
  const shares = flowShares(flow.length);

  function save() {
    const next: Rules = {
      purse: Math.round(Number(draft.purse) * 100),
      maxSquad: Number(draft.maxSquad),
      minSquad: Number(draft.minSquad),
      maxOverseas: Number(draft.maxOverseas),
      maxPlayers: Number(draft.maxPlayers),
      minOverseas: Number(draft.minOverseas),
      markingScheme: scheme,
      flow,
    };
    // The same checks the room runs, in the same order, so the first broken
    // rule is heard here instead of after a round trip. The room re-checks.
    const counts = [next.maxSquad, next.minSquad, next.maxOverseas];
    const { maxPlayers = 0, minOverseas = 0 } = next;
    if (!Number.isFinite(next.purse) || next.purse <= 0) return setError("Total Budget needs a positive number of crore.");
    if (counts.some((value) => !Number.isInteger(value) || value < 0) || next.maxSquad < 1)
      return setError("Squad fields need whole numbers.");
    if (next.minSquad > next.maxSquad) return setError("Minimum Players cannot exceed the Total Squad.");
    if (next.maxOverseas > next.maxSquad) return setError("Maximum overseas cannot exceed the Total Squad.");
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1)
      return setError("Maximum Players needs a whole number of at least 1.");
    if (!Number.isInteger(minOverseas) || minOverseas < 0) return setError("Minimum overseas needs a whole number.");
    if (minOverseas > next.maxOverseas) return setError("Minimum overseas cannot exceed the maximum.");
    if (minOverseas + 1 > next.maxSquad)
      return setError("The squad must have room for the overseas minimum and one uncapped player.");
    setError(null);
    onSave(next);
  }

  const field = (key: keyof typeof draft, label: string, hint: string, step = "1") => (
    <div>
      <span
        id={`setup-${key}-label`}
        className="block font-ui text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-body"
      >
        {label}
      </span>
      <input
        id={`setup-${key}`}
        aria-labelledby={`setup-${key}-label`}
        type="number"
        min={0}
        step={step}
        value={draft[key]}
        onChange={(event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))}
        className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 font-num text-[17px] font-semibold text-slate-ink outline-none transition-colors focus:border-[#22D3EE]"
      />
      <span className="mt-1 block font-ui text-[10.5px] leading-snug text-slate-faint">{hint}</span>
    </div>
  );

  const iconButton =
    "grid h-7 w-7 place-items-center rounded-md border border-line text-slate-muted transition-colors hover:border-slate-faint/60 hover:text-slate-ink disabled:cursor-not-allowed disabled:opacity-30";

  const heading = (step: string, icon: React.ReactNode, title: string, sub: string) => (
    <div className="mb-3 flex items-start gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-ink font-num text-[15px] font-bold text-white">
        {step}
      </span>
      <div className="min-w-0">
        <h3 className="flex items-center gap-1.5 font-head text-[14px] font-bold uppercase tracking-[0.1em] text-slate-ink">
          {icon}
          {title}
        </h3>
        <p className="mt-0.5 font-ui text-[12px] leading-snug text-slate-muted">{sub}</p>
      </div>
    </div>
  );

  return createPortal(
    <div
      className="console-dark fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-[#020617]/70 px-3 py-6 backdrop-blur-[3px] sm:py-10"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auction-setup-title"
        data-testid="auction-setup-form"
        /* Solid, not the theme's translucent card: a form over a live
           room must not have the room showing through its fields. */
        style={{ backgroundColor: "#0B1124" }}
        className="w-full max-w-[880px] overflow-hidden rounded-2xl border border-line shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line bg-surface-sunken px-5 py-4 sm:px-7">
          <div>
            <div className="font-ui text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
              {firstRun ? "Before the room opens" : "Auctioneer control"}
            </div>
            <h2 id="auction-setup-title" className="mt-0.5 font-head text-[20px] font-extrabold tracking-[0.06em] text-slate-ink">
              AUCTION SETUP
            </h2>
            <p className="mt-1 max-w-[560px] font-ui text-[12.5px] leading-snug text-slate-muted">
              Set how franchises are marked, the order players arrive in and the squad rules. Nothing changes in the room
              until you press Save.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close auction setup" className={iconButton}>
            <X size={14} />
          </button>
        </header>

        <div className="space-y-5 px-5 py-5 sm:px-7">
          {/* ---------------------------------------------------------- 1 */}
          <section className="setup-section rounded-xl border border-line p-4" data-testid="setup-marking">
            {heading(
              "1",
              <ClipboardCheck size={15} />,
              "Auctioneer marking scheme",
              `Each franchise's auction report is graded on these, in priority order. Up to ${options.max_factors} factors; the higher a factor sits, the more it counts.`,
            )}

            <ol className="space-y-2">
              <AnimatePresence initial={false}>
                {scheme.map((key, index) => {
                  const factor = factorByKey[key];
                  return (
                    <motion.li
                      key={key}
                      layout={!reduced}
                      initial={reduced ? false : { opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduced ? undefined : { opacity: 0, x: -12 }}
                      transition={{ type: "spring", stiffness: 520, damping: 38 }}
                      className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5"
                    >
                      <span className="font-num text-[22px] font-bold leading-none text-slate-ink">{index + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="font-head text-[13px] font-bold uppercase tracking-[0.06em] text-slate-ink">
                          {factor?.label ?? key}
                        </div>
                        <div className="font-ui text-[11.5px] leading-snug text-slate-muted">{factor?.blurb}</div>
                      </div>
                      <span
                        className="rounded-md bg-[#34D399]/15 px-2 py-1 font-num text-[13px] font-bold text-[#34D399]"
                        title="Share of the overall mark"
                      >
                        {Math.round(weights[index] * 100)}%
                      </span>
                      <div className="flex gap-1">
                        <button type="button" aria-label={`Move ${factor?.label} up`} disabled={index === 0} onClick={() => setScheme((list) => move(list, index, index - 1))} className={iconButton}>
                          <ArrowUp size={13} />
                        </button>
                        <button type="button" aria-label={`Move ${factor?.label} down`} disabled={index === scheme.length - 1} onClick={() => setScheme((list) => move(list, index, index + 1))} className={iconButton}>
                          <ArrowDown size={13} />
                        </button>
                        <button type="button" aria-label={`Remove ${factor?.label}`} onClick={() => setScheme((list) => list.filter((item) => item !== key))} className={iconButton}>
                          <X size={13} />
                        </button>
                      </div>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ol>

            {scheme.length === 0 && (
              <p className="rounded-lg border border-dashed border-line px-3 py-3 font-ui text-[12px] text-slate-muted">
                No factors chosen: reports use AUCTONIQ's standard rating (squad balance, value found, squad quality, use
                of the purse). Add a factor below to set your own.
              </p>
            )}

            <div className="mt-3">
              <div className="font-ui text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-faint">
                {full ? `All ${options.max_factors} places filled. Remove one to swap it.` : "Add a factor"}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {unused.map((factor) => (
                  <button
                    key={factor.key}
                    type="button"
                    disabled={full}
                    title={factor.blurb}
                    onClick={() => setScheme((list) => [...list, factor.key])}
                    className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 font-ui text-[11px] font-semibold text-slate-body transition-colors hover:border-slate-ink hover:text-slate-ink disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <Plus size={11} />
                    {factor.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* ---------------------------------------------------------- 2 */}
          <section className="setup-section rounded-xl border border-line p-4" data-testid="setup-flow">
            {heading(
              "2",
              <Shuffle size={15} />,
              "Auction flow",
              "The order the AI auctioneer favours when it brings players up. It is a priority, not a queue: tiers are mixed, so the room does not wait through every player of one tier before it sees the next.",
            )}

            <ol className="space-y-2">
              {flow.map((key, index) => {
                const tier = tierByKey[key];
                return (
                  <motion.li
                    key={key}
                    layout={!reduced}
                    transition={{ type: "spring", stiffness: 520, damping: 38 }}
                    className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5"
                  >
                    <span className="font-num text-[22px] font-bold leading-none text-slate-ink">{index + 1}</span>
                    <span aria-hidden className="h-8 w-[3px] rounded-sm" style={{ backgroundColor: TIER_TONE[key] ?? "#64748B" }} />
                    <div className="min-w-0 flex-1">
                      <div className="font-head text-[13px] font-bold uppercase tracking-[0.08em] text-slate-ink">
                        {tier?.label ?? key}
                        {tier && (
                          <span className="ml-2 font-ui text-[10.5px] font-semibold normal-case tracking-normal text-slate-faint">
                            {tier.total} players
                          </span>
                        )}
                      </div>
                      <div className="font-ui text-[11.5px] leading-snug text-slate-muted">{tier?.blurb}</div>
                    </div>
                    <span
                      className="rounded-md bg-surface-sunken px-2 py-1 font-num text-[13px] font-bold text-slate-body"
                      title="How often this tier leads a draw while every tier still has players"
                    >
                      {Math.round(shares[index] * 100)}%
                    </span>
                    <div className="flex gap-1">
                      <button type="button" aria-label={`Move ${tier?.label} up`} disabled={index === 0} onClick={() => setFlow((list) => move(list, index, index - 1))} className={iconButton}>
                        <ArrowUp size={13} />
                      </button>
                      <button type="button" aria-label={`Move ${tier?.label} down`} disabled={index === flow.length - 1} onClick={() => setFlow((list) => move(list, index, index + 1))} className={iconButton}>
                        <ArrowDown size={13} />
                      </button>
                    </div>
                  </motion.li>
                );
              })}
            </ol>
            <p className="mt-2 font-ui text-[11px] leading-snug text-slate-faint">
              Flow now: {flow.map((key) => tierByKey[key]?.label ?? key).join("  →  ")}. Inside a tier, rated players are
              three times as likely to come up as unrated ones, and no more than three players in a row come from one
              tier, or share one role, while another is available.
            </p>
          </section>

          {/* ---------------------------------------------------------- 3 */}
          <section className="setup-section rounded-xl border border-line p-4" data-testid="setup-rules">
            {heading(
              "3",
              <SlidersHorizontal size={15} />,
              "Auction rules",
              "Budget and squad limits. They apply to every franchise in the room.",
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              {field("purse", "Total Budget", "₹ crore per franchise", "0.25")}
              {field("maxSquad", "Total Squad", "most players a team can hold")}
              {field("minSquad", "Minimum Players", "each franchise must fill this many")}
              {field("maxPlayers", "Maximum Players", "players to go under the hammer")}
              {field("maxOverseas", "Maximum overseas", "most overseas players per team")}
              {field("minOverseas", "Minimum overseas", "highlighted in the briefing")}
            </div>
            <p className="mt-3 rounded-md border border-line bg-surface-sunken px-3 py-2 font-ui text-[11px] leading-relaxed text-slate-muted">
              Fixed for every room: {state?.rules.open_seconds ?? 10}-second bid timer · ₹0.25 Cr increments · jump bids of
              +5 / +10 / +15 Cr or more · {state?.rules.timeout_seconds ?? 30}-second decision buffer,{" "}
              {state?.rules.timeouts_per_team ?? 3} per franchise · at least 1 uncapped player.
            </p>
          </section>
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-line bg-surface-sunken px-5 py-3.5 sm:px-7">
          <div className="min-w-0 flex-1 font-ui text-[11.5px] leading-snug">
            {error ? (
              <span className="font-semibold text-unsold" role="alert">{error}</span>
            ) : warning ? (
              <span className="text-unsold">{warning}</span>
            ) : note ? (
              <span className="text-slate-body">{note}</span>
            ) : (
              <span className="text-slate-muted">
                Saving a new budget or marking scheme sends every franchise back to the briefing to acknowledge it.
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-3.5 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:text-slate-ink"
          >
            {firstRun ? "Later" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={save}
            data-testid="setup-save"
            className="rounded-lg bg-[#22D3EE] px-5 py-2 font-ui text-[11px] font-bold uppercase tracking-[0.12em] text-[#020617] transition-opacity hover:opacity-90"
          >
            Save setup
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
