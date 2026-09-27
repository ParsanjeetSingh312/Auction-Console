/**
 * useScoutOrchestrator.ts
 * One turn through SCOUT's multi-agent graph, as React state.
 *
 * The transport in `scoutOrchestrator.ts` is a callback API because a stream is
 * a sequence of events, not a value. This turns that sequence into the four
 * things an interface actually renders: which agent is working, what each one
 * has said, the final dossier, and whether it failed.
 *
 * **Steps are replaced, never mutated in place.** Every handler below rebuilds
 * the array. It is tempting to reach into `steps[i].status = "running"` since
 * the object is right there, and it produces a pipeline that updates once and
 * then freezes — React compares by identity and sees the same array it already
 * rendered. The whole point of the visualiser is that it moves.
 *
 * **A node can run more than once, and the state has to survive that.** The
 * graph has one cyclic edge: the advisor can hand the turn back to the
 * researcher for fresher data, bounded by `SCOUT_MAX_REFRESH_CYCLES`. So
 * `runs` increments on each `running` transition rather than the status simply
 * flipping, and a node returning to `running` after `done` is a legitimate
 * state rather than something to guard against.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  streamAdvice,
  type AgentStatus,
  type AgentStep,
  type ScoutAdvice,
} from "./scoutOrchestrator";
import { RagError } from "./ragClient";

export interface OrchestratorState {
  /** The question this run is answering, kept for the transcript's record. */
  question: string | null;
  /** The pipeline. Empty until the server has described its own shape. */
  steps: AgentStep[];
  /** Notes that belong to the request rather than to any one agent. */
  notes: string[];
  result: ScoutAdvice | null;
  error: string | null;
  isRunning: boolean;
  advise: (question: string, options?: AdviseOptions) => void;
  reset: () => void;
}

export interface AdviseOptions {
  teamId?: number | null;
  onBlockPlayerId?: number | null;
  /**
   * Seconds for the whole turn.
   *
   * Left unset the backend chooses. The console should send something short
   * while a lot is live — the room opens a bid window for seven seconds, and
   * an answer that arrives after the hammer is not an answer.
   */
  budgetSeconds?: number | null;
  /** Naming a thread resumes a conversation; omitting it starts a fresh one. */
  threadId?: string | null;
}

export function useScoutOrchestrator(): OrchestratorState {
  const [question, setQuestion] = useState<string | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [result, setResult] = useState<ScoutAdvice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  // One run at a time. A second question supersedes the first rather than
  // racing it — two streams writing into one pipeline would interleave their
  // node transitions and render a graph that never actually happened.
  const abort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );

  const reset = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setQuestion(null);
    setSteps([]);
    setNotes([]);
    setResult(null);
    setError(null);
    setIsRunning(false);
  }, []);

  const advise = useCallback((asked: string, options: AdviseOptions = {}) => {
    const trimmed = asked.trim();
    if (!trimmed) return;

    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setQuestion(trimmed);
    setSteps([]);
    setNotes([]);
    setResult(null);
    setError(null);
    setIsRunning(true);

    /** Apply a change to one step, leaving the rest untouched. */
    const patch = (id: string, change: (step: AgentStep) => AgentStep) =>
      setSteps((current) =>
        current.map((step) => (step.id === id ? change(step) : step)),
      );

    streamAdvice(
      {
        question: trimmed,
        team_id: options.teamId ?? null,
        on_block_player_id: options.onBlockPlayerId ?? null,
        budget_seconds: options.budgetSeconds ?? null,
        thread_id: options.threadId ?? null,
      },
      {
        onGraph: (fresh) => {
          if (controller.signal.aborted) return;
          setSteps(fresh);
        },

        onNode: (node, status: AgentStatus, detail) => {
          if (controller.signal.aborted) return;
          patch(node, (step) => ({
            ...step,
            status,
            detail: detail ?? null,
            // See the header: the researcher legitimately runs twice when the
            // advisor asks for fresher data.
            runs: status === "running" ? step.runs + 1 : step.runs,
          }));
        },

        onNotes: (fresh, node) => {
          if (controller.signal.aborted) return;
          if (node) {
            patch(node, (step) => ({ ...step, notes: [...step.notes, ...fresh] }));
          } else {
            setNotes((current) => [...current, ...fresh]);
          }
        },

        onResult: (output) => {
          if (controller.signal.aborted) return;
          setResult(output);
          // The run is over, so any node that never started never will. See
          // the note on `AgentStatus` — a branch not taken has to look
          // different from a branch still pending.
          setSteps((current) =>
            current.map((step) =>
              step.status === "idle" ? { ...step, status: "skipped" } : step,
            ),
          );
        },

        onError: (message) => {
          if (controller.signal.aborted) return;
          setError(message);
          // Anything still lit would stay lit forever otherwise, which reads
          // as an agent that is still working on a question that has failed.
          setSteps((current) =>
            current.map((step) =>
              step.status === "running" ? { ...step, status: "failed" } : step,
            ),
          );
        },
      },
      controller.signal,
    )
      .catch((thrown: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          thrown instanceof RagError
            ? thrown.message
            : "SCOUT could not be reached.",
        );
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setIsRunning(false);
      });
  }, []);

  return { question, steps, notes, result, error, isRunning, advise, reset };
}
