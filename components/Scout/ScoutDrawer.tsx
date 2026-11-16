/**
 * ScoutDrawer.tsx
 * SCOUT, reachable from every route: a full-height sheet on the right with the
 * ask-and-answer stage (ScoutOrb) inside it.
 *
 * **What it connects, unchanged from the panel it replaces.**
 *   - Questions go through the multi-agent graph — `/api/v1/scout/advise/stream`
 *     by way of `useScoutOrchestrator` — on one `threadId` for the life of the
 *     sheet, so follow-ups are one conversation rather than strangers.
 *   - The pipeline is shown as it runs: the label under the ball is the working
 *     agent's own status line from the server, the orbit's light pattern is
 *     that agent's, and the rail beneath lists Supervisor, Data Researcher and
 *     Cricket Advisor with live status and run counts (the researcher can run
 *     twice). Nothing here is on a timer.
 *   - The answer card holds the typed dossier (`RichStatsResponse`), or the
 *     error, or a research pass's notes — and nothing about how it was made.
 *     The pipeline trail and the "answered by" strip were removed as filler.
 *   - SCOUT remembers the conversation (scout/memory.py on the server), so a
 *     follow-up like "and his economy?" is answered about the right player.
 *     The header shows how full that memory is, with Compact (fold older
 *     turns into a summary) and New chat (forget it and start over).
 *   - Finished turns move to a transcript above the pill. Once the answer card
 *     has played in it files itself there and the pill comes back, ready for
 *     the next question — there is no "Ask another" step.
 *   - The composer is the shared draft in `scoutStore`, so closing mid-sentence
 *     and reopening returns the sentence. Quick actions ask immediately.
 *   - Ctrl/⌘K and the launcher toggle the sheet (`useScoutHotkey`). Escape
 *     cancels a question in flight; at rest it closes the sheet.
 *
 * **Still mounted while closed, and hidden with `autoAlpha` + `inert`.** GSAP has
 * no `AnimatePresence`: removing the node on close leaves the close tween
 * nothing to animate. `autoAlpha` also sets `visibility: hidden`, which takes
 * the sheet out of the accessibility tree and stops it catching clicks, and
 * `inert` stops a Tab press walking into an invisible composer. React 18 drops
 * `inert` as a JSX prop, hence the imperative attribute.
 *
 * **Non-modal on purpose.** The page to the left stays live and usable — SCOUT
 * is consulted during a lot, and covering the block to answer a question about
 * it would defeat the point. Below `md` the sheet is the full width.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import {
  clearScoutDraft,
  closeScout,
  setScoutDraft,
  useScoutAsk,
  useScoutDraft,
  useScoutOpen,
} from "../../console/scoutStore";
import { useScoutOrchestrator } from "../../console/useScoutOrchestrator";
import {
  clearThread,
  compactThread,
  type AgentStep,
  type ScoutAdvice,
  type ScoutContext,
} from "../../console/scoutOrchestrator";
import { AuctiqMark } from "../Global/AuctiqLogo";
import RichStatsResponse from "./RichStatsResponse";
import ScoutEmblem from "./ScoutEmblem";
import ScoutQuotaMeter from "./ScoutQuotaMeter";
import ScoutOrb, { type ScoutOrbPhase } from "./ScoutOrb";
import StatsFreshness from "../UI/StatsFreshness";

gsap.registerPlugin(useGSAP);

/**
 * The quick actions, phrased as a user would type them.
 *
 * Three questions an auction room actually asks: a split against a kind of
 * bowling, a split against a kind of batter, and a bar nobody clears -- which
 * shows the honest "no players match" answer rather than a shortlist of near
 * misses. The earlier generic chips (economy under 5.0, purse, uncapped, value
 * picks) were removed at Parsanjeet's request.
 */
const QUICK_ACTIONS = [
  "Batter with strike rate above 180 against fast bowlers",
  "Bowler with economy under 8 against left-handed batters",
  "Batter with strike rate above 300 against fast bowlers",
];

/** One finished turn, kept in the transcript. */
interface ArchivedTurn {
  id: number;
  question: string;
  result: ScoutAdvice | null;
  error: string | null;
  /** Set on the first turn after a compaction: a divider is drawn above it. */
  compactedBefore?: boolean;
}

/** Turns kept word for word when a conversation is compacted (server default). */
const KEEP_TURNS = 2;

function newThreadId(): string {
  return `ui-${Math.random().toString(36).slice(2, 12)}`;
}

export default function ScoutDrawer() {
  const container = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const hasMounted = useRef(false);
  const nextId = useRef(1);

  const open = useScoutOpen();
  const draft = useScoutDraft();
  // A question asked from another surface (a player card's "Ask Scout").
  const queuedAsk = useScoutAsk();

  const orchestrator = useScoutOrchestrator();
  const { question, steps, notes, result, error, isRunning, advise, reset } = orchestrator;

  const [history, setHistory] = useState<ArchivedTurn[]>([]);
  const [phase, setPhase] = useState<ScoutOrbPhase>("idle");

  /*
    One thread id per conversation.

    The backend remembers a conversation by this id, so every follow-up on it
    is read with the turns before it. Random rather than fixed, because a
    constant would make every browser in the building share one memory — the
    exact bug `AdviseRequest.thread_id` carries a comment about. New chat
    replaces it.
  */
  const [threadId, setThreadId] = useState(newThreadId);
  const [context, setContext] = useState<ScoutContext | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  const compactPending = useRef(false);

  // Each answer reports how full the memory is now. A thread that passed its
  // limit compacted itself on the server; the transcript marks where.
  useEffect(() => {
    const next = result?.context;
    if (!next) return;
    setContext((previous) => {
      if (previous && next.compactions > previous.compactions) compactPending.current = true;
      return next;
    });
  }, [result]);

  const onCompact = useCallback(async () => {
    if (compacting || isRunning) return;
    setCompacting(true);
    setMemoryNote(null);
    try {
      const after = await compactThread(threadId);
      setContext(after);
      compactPending.current = true;
      setMemoryNote(
        after.tokens_before != null && after.tokens_before > after.tokens
          ? `Compacted: ${after.tokens_before.toLocaleString()} → ${after.tokens.toLocaleString()} tokens`
          : "Nothing to compact yet",
      );
    } catch {
      setMemoryNote("Could not compact this conversation");
    } finally {
      setCompacting(false);
    }
  }, [compacting, isRunning, threadId]);

  const onNewChat = useCallback(() => {
    if (isRunning) return;
    void clearThread(threadId);
    setThreadId(newThreadId());
    setHistory([]);
    setContext(null);
    setMemoryNote(null);
    compactPending.current = false;
    reset();
  }, [isRunning, threadId, reset]);

  /* ---- the sheet itself ------------------------------------------------- */

  useGSAP(
    () => {
      const node = panel.current;
      if (!node) return;

      // The first run is the initial paint, not a transition.
      if (!hasMounted.current) {
        hasMounted.current = true;
        gsap.set(node, open ? { autoAlpha: 1, x: 0 } : { autoAlpha: 0, x: 40 });
        return;
      }

      // The house settle curve: power4.out at 520ms in, power2.in at 260ms out.
      if (open) {
        gsap.to(node, { autoAlpha: 1, x: 0, duration: 0.52, ease: "power4.out" });
      } else {
        gsap.to(node, { autoAlpha: 0, x: 40, duration: 0.26, ease: "power2.in" });
      }
    },
    { dependencies: [open], scope: container },
  );

  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    if (open) node.removeAttribute("inert");
    else node.setAttribute("inert", "");
  }, [open]);

  /* ---- asking ----------------------------------------------------------- */

  /*
    The stage waits on a promise; the orchestrator reports through state. This
    bridges them: the promise settles once the run has started and stopped, and
    only after React has committed the result — so the stage measures the
    answer card with the dossier already in it.
  */
  const pending = useRef<{ resolve: () => void; sawRunning: boolean } | null>(null);
  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    if (isRunning) {
      p.sawRunning = true;
      return;
    }
    if (p.sawRunning || result || error) {
      pending.current = null;
      p.resolve();
    }
  }, [isRunning, result, error]);

  const onSubmit = useCallback(
    (text: string) =>
      new Promise<void>((resolve) => {
        pending.current?.resolve();
        pending.current = { resolve, sawRunning: false };
        advise(text, { threadId });
        clearScoutDraft();
      }),
    [advise, threadId],
  );

  /** Move the live turn into the transcript. */
  const archive = useCallback(() => {
    if (!question) return;
    const compactedBefore = compactPending.current;
    compactPending.current = false;
    setHistory((current) => [
      ...current,
      { id: nextId.current++, question, result, error, compactedBefore },
    ]);
  }, [question, result, error]);

  /*
    The live turn is cleared only once the stage is back at rest. Clearing it on
    the click would empty the card during its fade-out, which reads as a flicker.
  */
  const clearOnIdle = useRef(false);
  const onReset = useCallback(() => {
    archive();
    clearOnIdle.current = true;
  }, [archive]);

  const onCancel = useCallback(() => {
    if (result || error) {
      onReset();
      return;
    }
    // Abandoned mid-thought: stop the stream; there is nothing to keep.
    pending.current = null;
    reset();
  }, [result, error, onReset, reset]);

  const onPhaseChange = useCallback(
    (next: ScoutOrbPhase) => {
      setPhase(next);
      if (next === "idle" && clearOnIdle.current) {
        clearOnIdle.current = false;
        reset();
      }
    },
    [reset],
  );

  // Keep the newest archived turn in view.
  useEffect(() => {
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [history.length]);

  /* ---- what the stage shows ------------------------------------------- */

  const runningIndex = steps.findIndex((step) => step.status === "running");
  const running = runningIndex >= 0 ? steps[runningIndex] : null;
  const lastDone = [...steps].reverse().find((step) => step.status === "done");
  const statusText = running
    ? running.running
    : steps.length === 0
      ? "Briefing the agents"
      : lastDone
        ? lastDone.done
        : "Scouting";

  const answer =
    question && (result || error) ? (
      <TurnAnswer question={question} result={result} error={error} reveal />
    ) : null;

  const idle = phase === "idle";
  const showWelcome = idle && history.length === 0;
  // Shown during the hand-back too, so the card cross-fades into its place in
  // the transcript rather than vanishing first.
  const showTranscript = (idle || phase === "reset") && history.length > 0;

  return (
    <div ref={container} id="scout-drawer">
      <div
        ref={panel}
        role="dialog"
        aria-label="SCOUT assistant"
        aria-modal="false"
        className="fixed inset-y-0 right-0 z-40 flex w-full flex-col overflow-hidden border-l border-auctiq-gold/15 bg-[linear-gradient(180deg,#0b1736_0%,#060c1f_55%,#040817_100%)] shadow-[-24px_0_60px_-20px_rgba(0,0,0,0.75)] md:w-[min(720px,100vw)]"
      >
        {/* ---- header ---- */}
        <header className="relative z-20 flex items-center gap-3 border-b border-white/[0.08] px-4 py-3 sm:px-5">
          <span className="grid h-10 w-10 place-items-center overflow-hidden rounded-full border border-auctiq-gold/30 bg-black/30">
            <ScoutEmblem variant="mark" className="h-9 w-9" paused={!open} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <AuctiqMark className="h-4 w-4" />
              <span className="font-auctiq text-[14px] tracking-[0.18em] text-auctiq-text">SCOUT</span>
            </div>
            <div className="font-tech text-[10px] uppercase tracking-[0.16em] text-auctiq-dim">
              {isRunning ? "Agents working" : "Multi-agent auction intelligence"}
            </div>
            <StatsFreshness tone="dark" className="mt-1" />
          </div>
          <MemoryControls
            context={context}
            hasTurns={history.length > 0 || Boolean(result)}
            busy={isRunning || compacting}
            compacting={compacting}
            onCompact={onCompact}
            onNewChat={onNewChat}
          />
          <button
            type="button"
            onClick={closeScout}
            aria-label="Close SCOUT"
            className="grid h-9 w-9 place-items-center rounded-md text-auctiq-dim transition-colors hover:bg-white/5 hover:text-auctiq-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        {memoryNote && (
          <p
            role="status"
            className="border-b border-white/[0.06] px-4 py-1.5 text-center font-tech text-[10.5px] text-auctiq-dim sm:px-5"
          >
            {memoryNote}
          </p>
        )}
        <ScoutQuotaMeter open={open} />

        <div className="relative min-h-0 flex-1">
          {/* ---- welcome: the emblem, before anything has been asked ---- */}
          <div
            className="pointer-events-none absolute inset-x-0 top-6 z-0 flex flex-col items-center px-6 text-center transition-[opacity,transform] duration-500 ease-out"
            style={{ opacity: showWelcome ? 1 : 0, transform: showWelcome ? "none" : "scale(0.94)" }}
            aria-hidden={!showWelcome}
          >
            <ScoutEmblem variant="full" className="h-[min(26vh,210px)] w-[min(26vh,210px)]" paused={!open || !showWelcome} />
            <p className="mt-3 max-w-[30rem] font-tech text-[12.5px] leading-relaxed text-auctiq-dim">
              Ask about any player, a season, a trade or the shape of the market.
              SCOUT is trained on the site&rsquo;s IPL data and remembers the
              conversation, so follow-ups like &ldquo;and his economy?&rdquo; just work.
            </p>
          </div>

          {/* ---- transcript: every turn already answered ---- */}
          <div
            ref={transcript}
            className="absolute inset-x-0 top-0 z-0 overflow-y-auto px-4 pb-6 pt-4 transition-opacity duration-300 sm:px-6"
            style={{
              bottom: 150,
              opacity: showTranscript ? 1 : 0,
              pointerEvents: showTranscript ? "auto" : "none",
              visibility: history.length > 0 ? "visible" : "hidden",
            }}
            aria-hidden={!showTranscript}
          >
            <div className="mx-auto max-w-[600px] space-y-6">
              {history.map((turn) => (
                <div key={turn.id} className="space-y-2.5">
                  {turn.compactedBefore && (
                    <div className="flex items-center gap-2 py-1" role="separator">
                      <span className="h-px flex-1 bg-white/10" />
                      <span className="font-tech text-[9.5px] uppercase tracking-[0.16em] text-auctiq-dim/70">
                        Compacted · older turns kept as a summary
                      </span>
                      <span className="h-px flex-1 bg-white/10" />
                    </div>
                  )}
                  <div className="ml-auto max-w-[85%] rounded-xl rounded-br-sm border border-auctiq-gold/25 bg-auctiq-gold/[0.08] px-3 py-2">
                    <p className="whitespace-pre-wrap font-tech text-[12.5px] leading-relaxed text-auctiq-text">
                      {turn.question}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-[#0d1a3d]/80 p-4">
                    <TurnAnswer question={turn.question} result={turn.result} error={turn.error} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ---- the stage ----
              Click-through: it covers the transcript, and the wheel has to
              reach it. ScoutOrb turns pointer events back on for its pill,
              card and chips. */}
          <div className="pointer-events-none absolute inset-0 z-10">
            <ScoutOrb
              active={open}
              value={draft}
              onValueChange={setScoutDraft}
              onSubmit={onSubmit}
              minThinkMs={900}
              suggestions={history.length === 0 ? QUICK_ACTIONS : undefined}
              submitSuggestions
              statusText={statusText}
              program={runningIndex >= 0 ? runningIndex : 0}
              belowStatus={<AgentRail steps={steps} notes={notes} />}
              answer={answer}
              autoReturnMs={1400}
              onReset={onReset}
              onCancel={onCancel}
              onPhaseChange={onPhaseChange}
              autoSubmit={queuedAsk}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */

/**
 * How much of the conversation SCOUT is carrying, and the two things to do
 * about it: Compact folds older turns into a summary (fewer tokens, same
 * meaning), New chat forgets the conversation entirely.
 */
function MemoryControls({
  context,
  hasTurns,
  busy,
  compacting,
  onCompact,
  onNewChat,
}: {
  context: ScoutContext | null;
  hasTurns: boolean;
  busy: boolean;
  compacting: boolean;
  onCompact: () => void;
  onNewChat: () => void;
}) {
  if (!hasTurns) return null;
  const percent = context?.percent ?? 0;
  const canCompact = !busy && (context?.live_turns ?? 0) > KEEP_TURNS;
  const tone = percent >= 80 ? "bg-auctiq-out" : percent >= 50 ? "bg-auctiq-gold" : "bg-emerald-400";
  const title = context
    ? `SCOUT remembers ${context.turns} turn${context.turns === 1 ? "" : "s"} · ` +
      `${context.tokens.toLocaleString()} of ${context.limit.toLocaleString()} tokens` +
      (context.compactions ? ` · compacted ${context.compactions}×` : "")
    : "SCOUT remembers this conversation";

  const button =
    "rounded-md border border-white/10 px-2 py-1 font-tech text-[10px] uppercase tracking-[0.12em] text-auctiq-dim transition-colors hover:border-white/25 hover:text-auctiq-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex flex-none items-center gap-1.5">
      <div className="hidden items-center gap-1.5 sm:flex" title={title} aria-label={title}>
        <span className="font-tech text-[9.5px] uppercase tracking-[0.12em] text-auctiq-dim/70">Context</span>
        <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-white/10">
          <span
            className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${tone}`}
            style={{ width: `${Math.max(3, percent)}%` }}
          />
        </span>
        <span className="font-num text-[10px] text-auctiq-dim">{percent}%</span>
      </div>
      <button
        type="button"
        className={button}
        onClick={onCompact}
        disabled={!canCompact}
        title="Fold older turns into a short summary so the conversation uses less context"
      >
        {compacting ? "Compacting…" : "Compact"}
      </button>
      <button
        type="button"
        className={button}
        onClick={onNewChat}
        disabled={busy}
        title="Forget this conversation and start a new one"
      >
        New chat
      </button>
    </div>
  );
}

const RAIL_TONE: Record<AgentStep["status"], string> = {
  idle: "border-white/12 text-auctiq-dim/70",
  running: "border-auctiq-gold/70 text-auctiq-gold shadow-[0_0_16px_-4px_rgba(245,185,43,0.8)]",
  done: "border-emerald-400/45 text-emerald-300",
  failed: "border-auctiq-out/60 text-auctiq-out",
  skipped: "border-white/[0.07] text-auctiq-dim/45",
};
const DOT_TONE: Record<AgentStep["status"], string> = {
  idle: "bg-white/25",
  running: "bg-auctiq-gold animate-pulse",
  done: "bg-emerald-400",
  failed: "bg-auctiq-out",
  skipped: "bg-white/15",
};

/**
 * The pipeline at a glance, under the thinking ball while SCOUT works: each
 * agent with its live status and the latest thing anyone said. It is shown
 * only while a question is in flight; answers carry no pipeline trail.
 */
function AgentRail({ steps, notes }: { steps: AgentStep[]; notes: string[] }) {
  const latest =
    [...steps.flatMap((step) => step.notes), ...notes].slice(-1)[0] ??
    steps.find((step) => step.status === "failed")?.detail ??
    null;

  if (steps.length === 0) {
    return (
      <p className="text-center font-tech text-[10.5px] uppercase tracking-[0.16em] text-auctiq-dim/70">
        Connecting to the agents…
      </p>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2.5">
      <ol className="flex flex-wrap items-center justify-center gap-1.5" aria-label="SCOUT agents">
        {steps.map((step, i) => (
          <li key={step.id} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden className="h-px w-3 bg-white/15" />}
            <span
              data-agent-status={step.status}
              className={`flex items-center gap-1.5 rounded-full border bg-[#0a1430]/80 px-2.5 py-1 font-tech text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors duration-300 ${RAIL_TONE[step.status]}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${DOT_TONE[step.status]}`} />
              {step.title}
              {step.runs > 1 && <span className="text-auctiq-dim">×{step.runs}</span>}
            </span>
          </li>
        ))}
      </ol>
      {latest && (
        <p className="max-w-full truncate px-2 text-center font-tech text-[11px] text-auctiq-dim/85">
          {latest}
        </p>
      )}
    </div>
  );
}

/**
 * One turn's answer: the dossier, the error, or a research pass's notes.
 * `reveal` marks the blocks the answer card brings in one by one.
 */
function TurnAnswer({
  question,
  result,
  error,
  reveal = false,
}: {
  question: string;
  result: ScoutAdvice | null;
  error: string | null;
  reveal?: boolean;
}) {
  const r = reveal ? { "data-reveal": "" } : {};
  return (
    <div className="space-y-3">
      {reveal && (
        <p {...r} className="font-tech text-[11px] uppercase tracking-[0.14em] text-auctiq-dim">
          <span className="text-auctiq-gold">Q</span> · {question}
        </p>
      )}

      {error && (
        <div {...r} className="rounded-xl border border-auctiq-out/35 bg-auctiq-out/10 px-3 py-2">
          <p className="font-tech text-[12px] leading-relaxed text-auctiq-out">{error}</p>
        </div>
      )}

      {result?.recommendation && (
        <div {...r}>
          <RichStatsResponse recommendation={result.recommendation} />
        </div>
      )}

      {/* A run that finished without a recommendation — a research pass, or an
          intent the advisor did not answer. Its notes are the only thing worth
          showing, and showing nothing at all would read as a hang. */}
      {result && !result.recommendation && result.notes.length > 0 && (
        <ul {...r} className="space-y-0.5 rounded-lg border border-white/10 bg-black/20 p-2">
          {result.notes.map((note, index) => (
            <li key={index} className="font-tech text-[11px] leading-snug text-auctiq-dim/85">
              {note}
            </li>
          ))}
        </ul>
      )}

      {result && !result.recommendation && result.notes.length === 0 && !error && (
        <p {...r} className="font-tech text-[12.5px] leading-relaxed text-auctiq-dim">
          SCOUT finished without a recommendation for this one. Try naming a player, a team or a role.
        </p>
      )}
    </div>
  );
}
