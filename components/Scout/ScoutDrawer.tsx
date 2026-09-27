/**
 * ScoutDrawer.tsx
 * The floating assistant panel, reachable from every route.
 *
 * **It is mounted for the life of the app and hidden with `autoAlpha`, not
 * conditionally rendered.** GSAP has no equivalent of `AnimatePresence`: if
 * React removes the node when `open` goes false, the close tween has nothing
 * left to animate and the panel vanishes on a frame. `gsap.set(..., {
 * autoAlpha: 0 })` sets `opacity: 0` *and* `visibility: hidden`, which takes
 * the panel out of the accessibility tree and stops it catching clicks — so a
 * hidden-but-mounted panel is genuinely inert, not merely transparent. Keeping
 * it mounted is also what lets a half-typed question survive a close.
 *
 * `inert` is applied imperatively rather than as a JSX prop because React 18
 * does not recognise it as an attribute and would drop it silently. It belongs
 * alongside `autoAlpha` rather than instead of it: `visibility: hidden` already
 * satisfies the pointer and the screen reader, and `inert` is what stops a Tab
 * press walking into the composer of an invisible panel.
 *
 * **Phase 2 answers through the multi-agent graph.** The composer now calls
 * `/api/v1/scout/advise/stream` by way of `useScoutOrchestrator`, so a question
 * shows the Supervisor, the Data Researcher and the Cricket Advisor working in
 * turn and then returns a typed dossier. `useScout`'s single-shot `/chat` path
 * is untouched and still serves the Data Interface's own SCOUT tab — this panel
 * simply reaches the better backend.
 *
 * **Why a turn archive rather than one live turn.** The orchestrator hook owns
 * exactly one run, because a pipeline is a thing that is happening rather than
 * a list. But losing the previous answer the moment a follow-up is asked would
 * be a regression from the Phase 1 transcript, so a completed turn is moved
 * into `history` before the next one starts. `threadId` is held steady across
 * them, which is what makes the backend treat them as one conversation instead
 * of resuming from a checkpoint that belongs to someone else.
 *
 * Every moving thing here is GSAP: the panel's open and close, the entrance of
 * each archived turn, and — in `AgentOrchestration` — the pipeline itself.
 */
import { useEffect, useMemo, useRef, useState } from "react";

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
import type { ScoutAdvice } from "../../console/scoutOrchestrator";
import AgentOrchestration from "./AgentOrchestration";
import RichStatsResponse from "./RichStatsResponse";

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
] as const;

/** One finished turn, kept above the live one. */
interface ArchivedTurn {
  id: number;
  question: string;
  result: ScoutAdvice | null;
  error: string | null;
}

export default function ScoutDrawer() {
  const container = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const hasMounted = useRef(false);
  const nextId = useRef(1);

  const open = useScoutOpen();
  const draft = useScoutDraft();

  const orchestrator = useScoutOrchestrator();
  const { question, steps, notes, result, error, isRunning, advise } = orchestrator;

  const [history, setHistory] = useState<ArchivedTurn[]>([]);

  /*
    One thread id for the life of the panel.

    The backend starts a fresh conversation for every request that does not name
    a thread, so without this each follow-up would be answered with no memory of
    the question before it. Generated once rather than fixed, because a constant
    would make every browser in the building share one checkpoint — which is the
    exact bug `AdviseRequest.thread_id` carries a comment about.
  */
  const threadId = useMemo(
    () => `ui-${Math.random().toString(36).slice(2, 12)}`,
    [],
  );

  /* ---- the panel itself ------------------------------------------------ */

  useGSAP(
    () => {
      const node = panel.current;
      if (!node) return;

      // The first run is the initial paint, not a transition. Tweening from
      // nothing to nothing would flash the panel for a frame on every cold
      // load of every route.
      if (!hasMounted.current) {
        hasMounted.current = true;
        gsap.set(
          node,
          open ? { autoAlpha: 1 } : { autoAlpha: 0, y: 16, scale: 0.96 },
        );
        return;
      }

      // The house settle curve: power4.out at 520ms. Four eases and four
      // durations for the whole product — see the prototype's motion/gsap.ts.
      if (open) {
        gsap.to(node, {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.52,
          ease: "power4.out",
        });
      } else {
        gsap.to(node, {
          autoAlpha: 0,
          y: 16,
          scale: 0.96,
          duration: 0.26,
          ease: "power2.in",
        });
      }
    },
    { dependencies: [open], scope: container },
  );

  /* ---- each question as it is asked ------------------------------------ */

  useGSAP(
    () => {
      if (!question) return;
      gsap.from(".scout-ask:last-of-type", {
        y: 10,
        autoAlpha: 0,
        duration: 0.42,
        ease: "power3.out",
      });
    },
    { dependencies: [question, history.length], scope: container },
  );

  /* ---- focus, inert, and the scroll floor ------------------------------ */

  useEffect(() => {
    const node = panel.current;
    if (!node) return;

    if (open) {
      node.removeAttribute("inert");
      // After the tween has begun, so focus does not land on a node the
      // browser still considers hidden.
      const id = window.setTimeout(() => composer.current?.focus(), 60);
      return () => window.clearTimeout(id);
    }

    node.setAttribute("inert", "");
    return undefined;
  }, [open]);

  // Follow the pipeline as it grows. `steps` is in the dependency list because
  // each node transition adds a line, and a pipeline that scrolls out of view
  // while it runs is the one thing this panel exists to show.
  useEffect(() => {
    const node = transcript.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [history.length, question, steps, result, error]);

  /* ---- sending --------------------------------------------------------- */

  function send(asked: string) {
    const trimmed = asked.trim();
    if (!trimmed || isRunning) return;

    // Archive the turn on screen before the hook clears it for the next run.
    if (question) {
      setHistory((current) => [
        ...current,
        { id: nextId.current++, question, result, error },
      ]);
    }

    advise(trimmed, { threadId });
    clearScoutDraft();
  }

  return (
    <div ref={container} id="scout-drawer">
      <div
        ref={panel}
        role="dialog"
        aria-label="SCOUT assistant"
        aria-modal="false"
        className="fixed bottom-24 right-6 z-40 flex h-[min(38rem,calc(100vh-9rem))] w-[min(26.5rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl border border-white/12 bg-auctiq-card/95 shadow-glass backdrop-blur-2xl"
      >
        {/* ---- header ---- */}
        <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.4" opacity=".55" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
              <line x1="12" y1="12" x2="12" y2="3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </span>

          <div className="min-w-0 flex-1">
            <div className="font-auctiq text-[13px] tracking-[0.14em] text-auctiq-text">
              SCOUT
            </div>
            <div className="font-tech text-[10px] uppercase tracking-[0.16em] text-auctiq-dim">
              {isRunning ? "Agents working" : "Multi-agent auction intelligence"}
            </div>
          </div>

          <button
            type="button"
            onClick={closeScout}
            aria-label="Close SCOUT"
            className="grid h-7 w-7 place-items-center rounded-md text-auctiq-dim transition-colors hover:bg-white/5 hover:text-auctiq-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {/* ---- transcript ---- */}
        <div ref={transcript} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {history.length === 0 && !question && (
            <div className="space-y-4">
              <p className="font-tech text-[12.5px] leading-relaxed text-auctiq-dim">
                Ask about any player, any franchise, or the shape of the market.
                A Data Researcher and a Cricket Advisor answer together, and you
                can watch them work.
              </p>
              <div className="flex flex-wrap gap-2">
                {QUICK_ACTIONS.map((action) => (
                  <button
                    key={action}
                    type="button"
                    onClick={() => send(action)}
                    className="rounded-full border border-white/12 px-3 py-1.5 text-left font-tech text-[11px] text-auctiq-dim transition-colors duration-150 hover:border-cyan-400/45 hover:bg-cyan-400/10 hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
                  >
                    {action}
                  </button>
                ))}
              </div>
            </div>
          )}

          {history.map((turn) => (
            <Turn
              key={turn.id}
              question={turn.question}
              result={turn.result}
              error={turn.error}
            />
          ))}

          {question && (
            <Turn
              question={question}
              result={result}
              error={error}
              steps={steps}
              notes={notes}
              live
            />
          )}
        </div>

        {/* ---- composer ---- */}
        <div className="border-t border-white/10 p-3">
          <div className="flex items-end gap-2 rounded-xl border border-white/12 bg-black/25 px-3 py-2 transition-colors focus-within:border-cyan-400/50">
            <textarea
              ref={composer}
              rows={1}
              value={draft}
              onChange={(event) => setScoutDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter is a newline. A composer where Enter
                // inserts a line break is a composer people forget to submit.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send(draft);
                }
              }}
              placeholder="Ask SCOUT anything"
              className="max-h-28 min-h-[1.5rem] flex-1 resize-none bg-transparent font-tech text-[12.5px] text-auctiq-text placeholder:text-auctiq-dim/70 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => send(draft)}
              disabled={!draft.trim() || isRunning}
              aria-label="Send"
              className="grid h-7 w-7 flex-none place-items-center rounded-lg bg-cyan-400/15 text-cyan-300 transition-colors hover:bg-cyan-400/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
                <path
                  d="M2.5 8h10M8.5 3.5L13 8l-4.5 4.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One question and whatever came back from it.
 *
 * The live turn additionally renders the pipeline; an archived one does not,
 * because a finished graph is a picture of something that already happened and
 * the dossier below it is the part worth keeping.
 */
function Turn({
  question,
  result,
  error,
  steps = [],
  notes = [],
  live = false,
}: {
  question: string;
  result: ScoutAdvice | null;
  error: string | null;
  steps?: React.ComponentProps<typeof AgentOrchestration>["steps"];
  notes?: string[];
  live?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="scout-ask ml-auto max-w-[85%] rounded-xl rounded-br-sm border border-cyan-400/25 bg-cyan-400/10 px-3 py-2">
        <p className="whitespace-pre-wrap font-tech text-[12.5px] leading-relaxed text-auctiq-text">
          {question}
        </p>
      </div>

      {live && <AgentOrchestration steps={steps} notes={notes} />}

      {error && (
        <div className="rounded-xl border border-auctiq-out/35 bg-auctiq-out/10 px-3 py-2">
          <p className="font-tech text-[11.5px] leading-relaxed text-auctiq-out">
            {error}
          </p>
        </div>
      )}

      {result?.recommendation && (
        <RichStatsResponse
          recommendation={result.recommendation}
          elapsedSeconds={result.elapsed_seconds}
        />
      )}

      {/* A run that finished without a recommendation — a research pass, or an
          intent the advisor did not answer. Its notes are the only thing worth
          showing, and showing nothing at all would read as a hang. */}
      {result && !result.recommendation && result.notes.length > 0 && (
        <ul className="space-y-0.5 rounded-lg border border-white/10 bg-black/20 p-2">
          {result.notes.map((note, index) => (
            <li
              key={index}
              className="font-tech text-[10.5px] leading-snug text-auctiq-dim/85"
            >
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
