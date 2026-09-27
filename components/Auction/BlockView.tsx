/**
 * BlockView.tsx
 * The war-room lot view: one player, one price, one decision.
 *
 * Purely presentational and fully controlled — it holds no auction state of its
 * own. That is what lets the same view run on a simulated feed (AuctionBlock)
 * and on the live Phase 2 engine (LiveBlock) with no branching inside it: the
 * animation and layout logic has exactly one implementation, so a fix to either
 * lands in both.
 *
 * Three ideas drive the design.
 *
 * **Progressive disclosure.** The centre carries the only thing that matters in
 * the moment — who is up, what it costs, and the one button that acts. Budget
 * and history sit in the bottom corners at a size meant for peripheral vision.
 *
 * **The button does the arithmetic.** A bidder under time pressure should never
 * have to work out the next rung of the ladder, or whether they can afford it.
 * The button states the figure it will commit to, and refuses — visibly — when
 * that figure is out of reach.
 *
 * **Colour carries state before text does.** A glance at the frame edge says
 * whether you are winning, whether you have been outbid, or whether you are out
 * of the running.
 *
 * Data flows one way: state in, GSAP reacts. Animations never drive state, so a
 * killed tween cannot desynchronise the display from the auction.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import type { LotClock } from "../../hooks/useAuctionSocket";
import { crore, GLOW, incrementFor, type Lot, type TickerEntry } from "./blockTypes";
import AlarmPulse from "./fx/AlarmPulse";
import CoinDrop from "./fx/CoinDrop";
import HammerDrop from "./fx/HammerDrop";
import { jumpSize, useNewEntry, useSecondsLeft } from "./fx/useBlockFx";
import TimerDisplay from "./TimerDisplay";

gsap.registerPlugin(useGSAP);

// Development affordance. GSAP is driven by requestAnimationFrame, so wherever
// the page is not painting — a hidden tab, a backgrounded window, a headless
// harness — tweens sit frozen at their start values and look broken when they
// are merely unticked. Exposing the instance lets you advance
// `gsap.globalTimeline.time(t)` by hand to confirm the interpolation is real.
// Stripped from production builds.
if (import.meta.env.DEV) {
  (window as unknown as { gsap?: typeof gsap }).gsap = gsap;
}

/**
 * Where the bidder stands. Derived once and read by the button, the frame glow
 * and the vault caption alike, so those three can never contradict each other.
 */
export type Stance = "winning" | "counter" | "blocked";

export interface BlockViewProps {
  lot: Lot | null;
  /** Standing bid, ₹ lakh. */
  currentBid: number;
  /** Code of the franchise holding the bid, or "" when nobody has bid. */
  leadingTeam: string;
  /** The franchise this station bids for. */
  myTeam: string;
  /** Opening purse, ₹ lakh — the denominator for the vault bar. */
  purse: number;
  /** Purse remaining, ₹ lakh. */
  purseLeft: number;
  ticker: TickerEntry[];
  /** Called with the exact amount to commit. */
  onBid: (amount: number) => void;
  /**
   * An extra reason this station cannot bid, beyond affordability — a full
   * squad or an exhausted overseas quota. Shown verbatim on the button.
   */
  blockedReason?: string | null;
  /** Rendered top-left; lets the host offer a way back to the main console. */
  corner?: React.ReactNode;
  /**
   * Commit an arbitrary figure, skipping the increment ladder.
   *
   * Optional: supplying it is what makes the jumpbid control appear. The Phase
   * 3 demo and the single-operator console do not, and are unchanged.
   */
  onJumpBid?: (amount: number) => void;

  /* ---------------- the room's clock, and the two controls that answer it ----
     Every one of these is optional and every one of them gates its own piece of
     UI. A driver that passes none of them gets precisely the view it got
     before this phase, which is what keeps the Phase 3 demo and the Phase 2
     single-operator console working untouched. */

  /** The running countdown. Supplying it is what makes the dial appear. */
  clock?: LotClock | null;
  /** Code of the franchise whose lifeline is burning, when one is. */
  timeoutBy?: string | null;
  /** Codes of every franchise still in the contest for this lot. */
  contenders?: string[];

  /** Supplying this is what makes the WITHDRAW control appear. */
  onWithdraw?: () => void;
  /** Whether the room would actually accept a withdrawal right now. */
  canWithdraw?: boolean;

  /** Supplying this is what makes the TIMEOUT control appear. */
  onTimeout?: () => void;
  /** Whether the room would actually accept a timeout right now. */
  canTimeout?: boolean;
  /** Lifelines this franchise has left, rendered as pips on the control. */
  timeoutsLeft?: number;
}

export default function BlockView({
  lot,
  currentBid,
  leadingTeam,
  myTeam,
  purse,
  purseLeft,
  ticker,
  onBid,
  blockedReason = null,
  corner,
  onJumpBid,
  clock = null,
  timeoutBy = null,
  contenders,
  onWithdraw,
  canWithdraw = false,
  onTimeout,
  canTimeout = false,
  timeoutsLeft = 0,
}: BlockViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const bidValueRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const vaultBarRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  /* ---------------- derived state ---------------- */

  const nextBid = leadingTeam ? currentBid + incrementFor(currentBid) : currentBid;
  const isWinning = leadingTeam !== "" && leadingTeam === myTeam;
  const canAfford = nextBid <= purseLeft;
  const barred = blockedReason !== null && blockedReason !== "";

  const stance: Stance = isWinning ? "winning" : canAfford && !barred ? "counter" : "blocked";
  const pursePct = purse > 0 ? Math.max(0, Math.min(100, (purseLeft / purse) * 100)) : 0;

  /* ---------------- animation ---------------- */

  const { contextSafe } = useGSAP({ scope: container });

  /**
   * The price change: a count-up paired with a scale punch.
   *
   * The number is written straight to the DOM rather than through state,
   * because a 60fps tween would otherwise re-render the whole view sixty times
   * a second. React owns the committed figure; GSAP owns only the transition
   * toward it.
   */
  const shownBid = useRef(0);
  useGSAP(
    () => {
      const el = bidValueRef.current;
      if (!el || !currentBid) return;

      const proxy = { v: shownBid.current };
      const isRaise = currentBid > shownBid.current;

      gsap
        .timeline()
        .to(
          proxy,
          {
            v: currentBid,
            duration: 0.45,
            ease: "power2.out",
            onUpdate: () => {
              el.textContent = crore(proxy.v);
            },
            onComplete: () => {
              shownBid.current = currentBid;
              el.textContent = crore(currentBid);
            },
          },
          0,
        )
        .from(
          el,
          {
            scale: isRaise ? 1.65 : 1,
            color: "#22d3ee",
            duration: 0.45,
            ease: "back.out(1.7)",
          },
          0,
        );
    },
    { scope: container, dependencies: [currentBid] },
  );

  /**
   * The frame glow — the traffic light.
   *
   * The pulse is held in a ref and killed explicitly rather than left to the
   * hook's context lifecycle: a repeating tween whose kill and revert interleave
   * can strand the element at its start value, which reads as a glow that stops
   * breathing. Owning the tween makes the transition depend on nothing else.
   *
   * Only "counter" animates. A steady green or red is a status; a pulse is a
   * summons. Reserving motion for the one state that wants a response is what
   * keeps it meaningful.
   */
  const pulseRef = useRef<gsap.core.Tween | null>(null);
  useGSAP(
    () => {
      const frame = frameRef.current;
      if (!frame) return;

      pulseRef.current?.kill();
      pulseRef.current = null;

      if (stance === "counter") {
        gsap.set(frame, { boxShadow: GLOW.counterLow });
        pulseRef.current = gsap.to(frame, {
          boxShadow: GLOW.counterHigh,
          duration: 0.85,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut",
        });
        return;
      }

      gsap.to(frame, {
        boxShadow: stance === "winning" ? GLOW.winning : GLOW.blocked,
        duration: 0.35,
        ease: "power2.out",
      });
    },
    { scope: container, dependencies: [stance] },
  );

  /** The vault bar: width and colour tween together, so a big spend reads as one. */
  useGSAP(
    () => {
      const bar = vaultBarRef.current;
      if (!bar) return;
      gsap.to(bar, {
        width: `${pursePct}%`,
        backgroundColor: pursePct > 50 ? "#10b981" : pursePct > 20 ? "#f59e0b" : "#ef4444",
        duration: 0.7,
        ease: "power3.out",
      });
    },
    { scope: container, dependencies: [pursePct] },
  );

  /** A new lot arrives: the card drops in so the change of subject is obvious. */
  useGSAP(
    () => {
      if (!lot) return;
      gsap.from(".lot-card", { y: -28, opacity: 0, duration: 0.55, ease: "power3.out" });
      gsap.from(".lot-meta > *", {
        y: 10,
        opacity: 0,
        duration: 0.4,
        stagger: 0.06,
        ease: "power2.out",
        delay: 0.12,
      });
    },
    { scope: container, dependencies: [lot?.id] },
  );

  /** Ticker: only the newest row animates; the rest are already in place. */
  useGSAP(
    () => {
      gsap.from(".ticker-row:first-child", {
        x: -22,
        opacity: 0,
        duration: 0.4,
        ease: "power2.out",
      });
    },
    { scope: container, dependencies: [ticker[0]?.id] },
  );

  /**
   * The refusal. The button stays clickable when a bid is unaffordable
   * precisely so this can fire — a disabled button that does nothing teaches
   * the user nothing about why.
   */
  const rejectBid = contextSafe(() => {
    gsap.fromTo(
      buttonRef.current,
      { x: -9 },
      { x: 0, duration: 0.5, ease: "elastic.out(1.4, 0.28)", clearProps: "x" },
    );
    gsap.fromTo(
      frameRef.current,
      { boxShadow: GLOW.reject },
      { boxShadow: GLOW.blocked, duration: 0.6 },
    );
  });

  /** Confirmation that a bid left the building. */
  const confirmBid = contextSafe(() => {
    gsap.fromTo(buttonRef.current, { scale: 0.94 }, { scale: 1, duration: 0.42, ease: "back.out(2.2)" });
  });

  const placeBid = useCallback(() => {
    if (isWinning) return;
    if (!canAfford || barred) {
      rejectBid();
      return;
    }
    confirmBid();
    onBid(nextBid);
  }, [isWinning, canAfford, barred, rejectBid, confirmBid, onBid, nextBid]);

  /** Space bids, the way a paddle would. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        placeBid();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placeBid]);

  /* ---------------- block effects ----------------
     Three one-shot animations driven by room state. Every trigger below
     already existed; none of this adds a new event to the protocol. */

  const sold = useNewEntry(ticker, "sold");
  const lastBid = useNewEntry(ticker, "bid");
  const secondsLeft = useSecondsLeft(clock);

  // The figure standing before this bid landed, for sizing the cascade.
  const previousBid = useRef<number | null>(null);
  const increments = jumpSize(lastBid?.amount ?? null, previousBid.current, incrementFor);
  useEffect(() => {
    if (lastBid?.amount != null) previousBid.current = lastBid.amount;
  }, [lastBid]);

  // The hammer dismisses itself; this is what unmounts it.
  const [hammerFor, setHammerFor] = useState<number | null>(null);
  useEffect(() => {
    if (sold) setHammerFor(sold.id);
  }, [sold]);

  /* ---------------- render ---------------- */

  const button = BUTTON_STATES[stance];
  const label = barred && stance === "blocked" ? blockedReason!.toUpperCase() : button.label;

  return (
    <div
      ref={container}
      className="relative grid h-full min-h-screen w-full grid-rows-[auto_1fr_auto] overflow-hidden bg-neutral-950 text-neutral-100 antialiased"
    >
      {/* The frame carries the traffic light. Nothing else needs to know. */}
      <div ref={frameRef} aria-hidden className="pointer-events-none absolute inset-3 rounded-2xl" />

      {/* Coins fall over the block; the alarm sits above it. Both are
          pointer-events:none so neither can ever intercept a bid. */}
      <CoinDrop
        eventId={lastBid?.id ?? null}
        increments={increments}
        mine={lastBid?.mine ?? false}
      />
      <AlarmPulse
        secondsLeft={secondsLeft}
        clockKind={clock?.kind ?? null}
        myTeam={myTeam}
        leadingTeam={leadingTeam}
      />

      <div className="relative z-10 flex items-center justify-between px-6 pt-5">
        <div>{corner}</div>
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-600">
          bidding as <span className="text-neutral-300">{myTeam}</span>
        </div>
      </div>

      {/* ---- Focus tunnel: the lot, the price, the decision ---- */}
      <main className="relative flex flex-col items-center justify-center px-6">
        {lot ? (
          <>
            <div className="lot-card flex flex-col items-center">
              <span className="font-mono text-[11px] uppercase tracking-[0.4em] text-neutral-500">
                On the block
              </span>
              <h1 className="mt-2 text-center font-display text-6xl font-bold uppercase leading-none tracking-tight sm:text-7xl lg:text-8xl">
                {lot.name}
              </h1>
              <div className="lot-meta mt-4 flex flex-wrap items-center justify-center gap-2">
                <Chip>{lot.role}</Chip>
                {lot.country && <Chip>{lot.country}</Chip>}
                <Chip>Base {crore(lot.base)}</Chip>
                {lot.rating !== null && <Chip>Rating {lot.rating}</Chip>}
                {lot.headline && <Chip>{lot.headline}</Chip>}
              </div>
            </div>

            <div className="mt-10 flex flex-col items-center">
              <span className="font-mono text-[11px] uppercase tracking-[0.4em] text-neutral-500">
                {leadingTeam ? "Current bid" : "Opening ask"}
              </span>
              <span
                ref={bidValueRef}
                className="bid-text mt-1 font-display text-7xl font-bold leading-none tabular-nums sm:text-8xl lg:text-9xl"
              >
                {crore(currentBid)}
              </span>
              <span className="mt-3 h-6 font-mono text-sm uppercase tracking-[0.2em]">
                {leadingTeam ? (
                  <span className={isWinning ? "text-emerald-400" : "text-amber-400"}>
                    {isWinning ? "held by you" : `held by ${leadingTeam}`}
                  </span>
                ) : (
                  <span className="text-neutral-600">no bids yet</span>
                )}
              </span>
            </div>

            {/*
              The clock, between the price and the button that answers it.

              Placed here rather than in a corner because it is the second most
              important thing on the screen after the figure itself: how long
              you have is exactly as decision-relevant as what it costs, and a
              countdown in the periphery is a countdown nobody reads until it
              has already run out.
            */}
            {clock && (
              <div className="mt-6 w-full max-w-2xl">
                <TimerDisplay clock={clock} timeoutBy={timeoutBy} />
                {contenders && contenders.length > 1 && (
                  <div className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.25em] text-neutral-600">
                    in the contest · {contenders.join(" · ")}
                  </div>
                )}
              </div>
            )}

            <button
              ref={buttonRef}
              type="button"
              onClick={placeBid}
              // Left clickable when refused so the rejection can be *shown*. A
              // dead button explains nothing; the shake and red frame do.
              aria-disabled={stance !== "counter"}
              className={`mt-9 w-full max-w-2xl rounded-xl border-2 px-8 py-6 font-display text-3xl font-bold uppercase tracking-[0.06em] transition-colors sm:text-4xl ${button.className}`}
            >
              {stance === "counter" ? `${label} ${crore(nextBid)}` : label}
            </button>

            <span className="mt-3 font-mono text-[11px] uppercase tracking-[0.25em] text-neutral-600">
              {stance === "counter" ? "space to bid" : button.hint}
            </span>

            {/*
              The jumpbid.

              Rendered only when a host supplies `onJumpBid`, so the Phase 3
              demo and the single-operator console are untouched. It sits below
              the main button and is deliberately small: skipping the ladder is
              a tactic, not the default, and a room where jumping is as easy as
              bidding is a room where the ladder stops meaning anything.
            */}
            {onJumpBid && (
              <JumpBid
                floor={nextBid}
                disabled={stance === "blocked" && barred}
                onJump={onJumpBid}
              />
            )}

            {/*
              The two ways out of a lot that are not bidding on it.

              Both sit below the main button and both are deliberately quiet.
              Raising is the default action on this screen and should look like
              it; stepping back and freezing the room are considered moves, and
              a control that is as loud as the bid button invites being pressed
              by reflex. Neither is disabled-and-silent: the tooltip on a dead
              control says which rule is stopping it.
            */}
            {(onWithdraw || onTimeout) && (
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {onTimeout && (
                  <button
                    type="button"
                    onClick={onTimeout}
                    disabled={!canTimeout}
                    title={
                      canTimeout
                        ? `Freeze the block for 30 seconds — ${timeoutsLeft} lifeline${
                            timeoutsLeft === 1 ? "" : "s"
                          } left`
                        : timeoutsLeft === 0
                          ? "No lifelines left"
                          : "A timeout answers a standing bid — you cannot call one on your own"
                    }
                    className="flex items-center gap-2 rounded-md border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:border-neutral-800 disabled:bg-transparent disabled:text-neutral-700"
                  >
                    timeout
                    {/* Pips, not a number: three of anything is countable at a
                        glance, and this is read under time pressure. */}
                    <span className="flex gap-0.5" aria-hidden>
                      {[0, 1, 2].map((index) => (
                        <i
                          key={index}
                          className={`h-1.5 w-1.5 rounded-full ${
                            index < timeoutsLeft ? "bg-cyan-400" : "bg-neutral-700"
                          }`}
                        />
                      ))}
                    </span>
                    <span className="sr-only">{timeoutsLeft} left</span>
                  </button>
                )}

                {onWithdraw && (
                  <button
                    type="button"
                    onClick={onWithdraw}
                    disabled={!canWithdraw}
                    title={
                      canWithdraw
                        ? "Step out of this player — the lot goes to the standing bid"
                        : "You can withdraw only from a player you have bid on, and not while you hold the bid"
                    }
                    className="rounded-md border border-neutral-700 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-neutral-400 transition-colors hover:border-red-500/60 hover:text-red-300 disabled:cursor-not-allowed disabled:border-neutral-900 disabled:text-neutral-700"
                  >
                    withdraw
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="text-center">
            <div className="font-display text-4xl uppercase text-neutral-700">
              Nobody on the block
            </div>
            <div className="mt-2 font-mono text-xs uppercase tracking-[0.3em] text-neutral-800">
              waiting for the next lot
            </div>
          </div>
        )}
      </main>

      {/* ---- Periphery: history left, money right ---- */}
      <footer className="relative z-10 grid grid-cols-1 gap-3 p-5 lg:grid-cols-[1fr_auto]">
        <section aria-label="Bid history" className="min-w-0">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-600">Ticker</h2>
          <ul className="mt-2 h-24 space-y-1 overflow-hidden">
            {ticker.length === 0 && (
              <li className="font-mono text-xs text-neutral-700">awaiting the first bid…</li>
            )}
            {ticker.slice(0, 4).map((entry) => (
              <li
                key={entry.id}
                className={`ticker-row flex items-baseline gap-3 font-mono text-xs ${TICKER_TONE(entry)}`}
              >
                <span className="w-10 shrink-0 text-neutral-700">
                  {String(entry.id).padStart(3, "0")}
                </span>
                <span className="truncate">{entry.text}</span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {entry.amount === null ? "—" : crore(entry.amount)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Franchise vault" className="w-full min-w-0 lg:w-80">
          <div className="flex items-baseline justify-between">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-600">
              {myTeam} vault
            </h2>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-600">
              {Math.round(pursePct)}%
            </span>
          </div>
          <div className="mt-2 font-display text-3xl font-bold tabular-nums">{crore(purseLeft)}</div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-800">
            <div ref={vaultBarRef} className="h-full w-full rounded-full bg-emerald-500" />
          </div>
          <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-600">
            {barred
              ? blockedReason
              : canAfford
                ? `${crore(purseLeft - nextBid)} left after this bid`
                : `${crore(nextBid - purseLeft)} over budget`}
          </div>
        </section>
      </footer>

      {/* Full-bleed, so it renders last and over everything. */}
      {hammerFor !== null && sold && (
        <HammerDrop
          playerName={lot?.name ?? sold.text}
          teamCode={leadingTeam}
          amount={sold.amount}
          basePrice={lot?.base ?? null}
          onDone={() => setHammerFor(null)}
        />
      )}
    </div>
  );
}

/** The three button states, kept together so they stay visibly parallel. */
const BUTTON_STATES: Record<Stance, { label: string; hint: string; className: string }> = {
  counter: {
    label: "RAISE BID TO",
    hint: "",
    className:
      "border-amber-400 bg-amber-400 text-neutral-950 hover:border-amber-300 hover:bg-amber-300 cursor-pointer",
  },
  winning: {
    label: "YOU ARE WINNING",
    hint: "hold — wait for a counter",
    className: "border-emerald-500 bg-emerald-500/15 text-emerald-400 cursor-default",
  },
  blocked: {
    label: "EXCEEDS YOUR PURSE",
    hint: "the vault cannot cover the next rung",
    className: "border-red-500/70 bg-red-500/10 text-red-400 cursor-not-allowed",
  },
};

/**
 * Ticker row colour. A sale and a pass are the two outcomes worth spotting from
 * across a room, so they get their own hues; everything this station did is
 * cyan, and the rest of the traffic stays grey.
 */
const TICKER_TONE = (entry: TickerEntry): string => {
  if (entry.kind === "sold") return "text-emerald-400";
  if (entry.kind === "unsold") return "text-red-400";
  if (entry.kind === "timeout") return "text-cyan-400";
  if (entry.mine) return "text-cyan-300";
  // Dimmer than ordinary traffic on purpose: a withdrawal is context for the
  // teams still in, not an event anyone needs to chase across the room.
  if (entry.kind === "withdraw") return "text-neutral-500";
  return "text-neutral-400";
};

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-neutral-400">
      {children}
    </span>
  );
}

/**
 * Name your own price.
 *
 * Held in crore because that is how the room talks — "eleven crore" is said
 * aloud, "1100 lakh" is not — and converted on submit, since every figure the
 * engine and the room handle is an integer of lakh.
 *
 * The floor is enforced here as well as on the server, for the ordinary reason
 * that a control which lets you type an impossible number and then rejects it
 * is worse than one that will not let you. The server checks regardless; this
 * is courtesy, not security.
 */
function JumpBid({
  floor,
  disabled,
  onJump,
}: {
  /** ₹ lakh: the standard next ask, which a jump must beat. */
  floor: number;
  disabled: boolean;
  onJump: (amount: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const crores = Number(text);
  const lakh = Math.round(crores * 100);
  const valid = text.trim() !== "" && Number.isFinite(crores) && lakh >= floor;

  const submit = () => {
    if (!valid) return;
    onJump(lakh);
    setText("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="mt-4 rounded-md border border-neutral-800 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-neutral-500 transition-colors hover:border-neutral-600 hover:text-neutral-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        jumpbid
      </button>
    );
  }

  return (
    <div className="mt-4 flex items-center gap-2">
      <div className="flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-600">
          ₹
        </span>
        <input
          autoFocus
          type="number"
          inputMode="decimal"
          step="0.25"
          min={floor / 100}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
            if (event.key === "Escape") setOpen(false);
            // The view binds Space to bid; typing a figure must not also
            // place one.
            event.stopPropagation();
          }}
          placeholder={(floor / 100).toFixed(2)}
          aria-label="Jumpbid amount in crore"
          className="w-24 bg-transparent font-display text-lg font-bold text-neutral-100 outline-none placeholder:text-neutral-700"
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-600">
          Cr
        </span>
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={!valid}
        title={
          valid
            ? `Commit ${crore(lakh)}`
            : `Must be at least ${crore(floor)}`
        }
        className="rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-300 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:border-neutral-800 disabled:bg-transparent disabled:text-neutral-700"
      >
        jump
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-600 hover:text-neutral-400"
      >
        esc
      </button>
    </div>
  );
}
