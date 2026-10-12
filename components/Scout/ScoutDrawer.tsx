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
 *     error, or a research pass's notes, plus the full `AgentOrchestration`
 *     trail behind a disclosure.
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import {
  clearScoutDraft,
  closeScout,
  setScoutDraft,
  useScoutDraft,
  useScoutOpen,
} from "../../console/scoutStore";
import { useScoutOrchestrator } from "../../console/useScoutOrchestrator";
import type { AgentStep, ScoutAdvice } from "../../console/scoutOrchestrator";
import { AuctiqMark } from "../Global/AuctiqLogo";
import AgentOrchestration from "./AgentOrchestration";
import RichStatsResponse from "./RichStatsResponse";
import ScoutEmblem from "./ScoutEmblem";
import ScoutOrb, { type ScoutOrbPhase } from "./ScoutOrb";

gsap.registerPlugin(useGSAP);

/**
 * The quick actions, phrased as a user would type them.
 *
 * Deliberately four, and deliberately spread across things the graph answers
 * well — a metric filter, a purse question, a scarcity question and a value
 * question. A chip that returns a shrug teaches the user the assistant is weak
 * at exactly the moment they are deciding whether to trust it.
 */
const QUICK_ACTIONS = [
  "Suggest a bowler with economy under 5.0",
  "Which team has the most purse left?",
  "Best uncapped batter still available",
  "Value picks under 2 Cr",
];

/** One finished turn, kept in the transcript. */
interface ArchivedTurn {
  id: number;
  question: string;
  result: ScoutAdvice | null;
  error: string | null;
  steps: AgentStep[];
  notes: string[];
}

export default function ScoutDrawer() {
  const container = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const hasMounted = useRef(false);
  const nextId = useRef(1);

  const open = useScoutOpen();
  const draft = useScoutDraft();

  const orchestrator = useScoutOrchestrator();
  const { question, steps, notes, result, error, isRunning, advise, reset } = orchestrator;

  const [history, setHistory] = useState<ArchivedTurn[]>([]);
  const [phase, setPhase] = useState<ScoutOrbPhase>("idle");

  /*
    One thread id for the life of the sheet.

    The backend starts a fresh conversation for every request that does not name
    a thread, so without this each follow-up would be answered with no memory of
    the question before it. Generated once rather than fixed, because a constant
    would make every browser in the building share one checkpoint — which is the
    exact bug `AdviseRequest.thread_id` carries a comment about.
  */
  const threadId = useMemo(() => `ui-${Math.random().toString(36).slice(2, 12)}`, []);

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
    setHistory((current) => [
      ...current,
      { id: nextId.current++, question, result, error, steps, notes },
    ]);
  }, [question, result, error, steps, notes]);

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
      <TurnAnswer question={question} result={result} error={error} steps={steps} notes={notes} reveal />
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
          </div>
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

        <div className="relative min-h-0 flex-1">
          {/* ---- welcome: the emblem, before anything has been asked ---- */}
          <div
            className="pointer-events-none absolute inset-x-0 top-6 z-0 flex flex-col items-center px-6 text-center transition-[opacity,transform] duration-500 ease-out"
            style={{ opacity: showWelcome ? 1 : 0, transform: showWelcome ? "none" : "scale(0.94)" }}
            aria-hidden={!showWelcome}
          >
            <ScoutEmblem variant="full" className="h-[min(26vh,210px)] w-[min(26vh,210px)]" paused={!open || !showWelcome} />
            <p className="mt-3 max-w-[30rem] font-tech text-[12.5px] leading-relaxed text-auctiq-dim">
              Ask about any player, any franchise, or the shape of the market. A
              Data Researcher and a Cricket Advisor answer together, and you can
              watch them work.
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
                  <div className="ml-auto max-w-[85%] rounded-xl rounded-br-sm border border-auctiq-gold/25 bg-auctiq-gold/[0.08] px-3 py-2">
                    <p className="whitespace-pre-wrap font-tech text-[12.5px] leading-relaxed text-auctiq-text">
                      {turn.question}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-[#0d1a3d]/80 p-4">
                    <TurnAnswer
                      question={turn.question}
                      result={turn.result}
                      error={turn.error}
                      steps={turn.steps}
                      notes={turn.notes}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ---- the stage ---- */}
          <div className="absolute inset-0 z-10">
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
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */

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
 * The pipeline at a glance, under the thinking ball: each agent with its live
 * status, how many times it has run, and the latest thing anyone said. The full
 * trail, notes and all, is in the answer card behind "How SCOUT worked it out".
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
 * One turn's answer: the dossier, the error, or a research pass's notes, and
 * the pipeline behind a disclosure. `reveal` marks the blocks the answer card
 * brings in one by one.
 */
function TurnAnswer({
  question,
  result,
  error,
  steps,
  notes,
  reveal = false,
}: {
  question: string;
  result: ScoutAdvice | null;
  error: string | null;
  steps: AgentStep[];
  notes: string[];
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
          <RichStatsResponse recommendation={result.recommendation} elapsedSeconds={result.elapsed_seconds} />
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

      {steps.length > 0 && (
        <details {...r} className="group rounded-xl border border-white/10 bg-black/20">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 font-tech text-[10.5px] uppercase tracking-[0.14em] text-auctiq-dim transition-colors hover:text-auctiq-text">
            How SCOUT worked it out
            <span aria-hidden className="transition-transform duration-200 group-open:rotate-180">▾</span>
          </summary>
          <div className="px-3 pb-3">
            <AgentOrchestration steps={steps} notes={notes} />
          </div>
        </details>
      )}
    </div>
  );
}
