/**
 * scoutOrchestrator.ts
 * The door to SCOUT's multi-agent graph, and the shapes that come back.
 *
 * Sibling to `ragClient.ts` and deliberately the same kind of module: transport
 * only, no React, no formatting. `ragClient` speaks to the single-shot RAG
 * chain at `/api/v1/chat`; this speaks to the LangGraph pipeline at
 * `/api/v1/scout/advise/stream`, which is a different backend with a different
 * contract and deserves its own file rather than a third mode bolted onto the
 * first.
 *
 * **Why `fetch` and not `EventSource`.** `EventSource` is the obvious tool for
 * Server-Sent Events and cannot be used here: it only issues GET requests, and
 * the question, the team context and the time budget are a POST body. So the
 * stream is read off `response.body` and the handful of lines of SSE framing
 * are parsed below. The upside is that `AbortController` works normally, which
 * `EventSource` does not support either.
 *
 * **The frame parser is the part worth reading carefully.** A network chunk has
 * no relationship to an event boundary: one `read()` can deliver half an event,
 * three events, or two and a half. So `buffer` holds whatever has not yet been
 * terminated by a blank line, and only complete `data:` blocks are dispatched.
 * Parsing each chunk independently works in testing — where events are small
 * and arrive one per chunk — and corrupts the moment a real answer is long
 * enough to split.
 */
import { apiUrl } from "./apiBase";
import { RagError } from "./ragClient";

/* -------------------------------------------------------------------------
 * What the graph produces
 * ---------------------------------------------------------------------- */

/** Mirrors `scout/schemas/queries.py::Candidate`. */
export interface Candidate {
  player_id: number;
  player_name: string;
  role: string;
  rationale: string;
  /**
   * The figures the rationale rests on. The backend requires this to be
   * non-empty — an advisor that cannot cite anything is generating prose — so
   * the interface can render it as a citation block without an empty state.
   */
  evidence: string[];
  suggested_max_bid_lakh: number | null;
  risks: string[];
}

/** Mirrors `scout/schemas/queries.py::AdvisorRecommendation`. */
export interface AdvisorRecommendation {
  answer: string;
  candidates: Candidate[];
  engine_used: string;
  notes: string[];
  /** The ceiling in force when this was produced, copied from the team. */
  max_bid_lakh: number | null;
  refresh_cycles: number;
}

/** Mirrors `scout/graph/state.py::ScoutOutput`. */
export interface ScoutAdvice {
  intent: "advise" | "research" | string;
  recommendation: AdvisorRecommendation | null;
  research: Record<string, unknown> | null;
  engine_used: string | null;
  notes: string[];
  refresh_cycles: number;
  elapsed_seconds: number;
}

/* -------------------------------------------------------------------------
 * What the pipeline reports while it runs
 * ---------------------------------------------------------------------- */

/**
 * `skipped` is not a server status — it is derived when a run ends.
 *
 * The graph branches: the supervisor sends an ordinary "who should I bid on"
 * question straight to the advisor, and the Data Researcher only runs for a
 * research intent or when the advisor asks for fresher data. So a completed run
 * routinely leaves a node that never started, and leaving it on "Waiting" after
 * the answer has arrived reads as a pipeline that hung rather than a branch that
 * was not taken.
 */
export type AgentStatus = "idle" | "running" | "done" | "failed" | "skipped";

/** One node of the graph, as the visualiser draws it. */
export interface AgentStep {
  /** The node's real name in `scout/graph/workflow.py`. */
  id: string;
  title: string;
  /** What it says while running, and what it says once finished. */
  running: string;
  done: string;
  status: AgentStatus;
  /** Notes this node emitted, in the order it emitted them. */
  notes: string[];
  /** Set when the node failed. */
  detail?: string | null;
  /**
   * How many times this node has run.
   *
   * Not decoration: the graph has one cyclic edge, advisor → researcher, so
   * the Researcher genuinely runs twice when the advisor asks for fresher
   * data. Counting it is what makes a slow answer explicable instead of
   * looking like a stuck pipeline.
   */
  runs: number;
}

/** The labels map the server sends before anything runs. */
type NodeLabels = Record<string, { title: string; running: string; done: string }>;

/** Everything a caller needs to hear about. */
export interface OrchestratorHandlers {
  /** The pipeline's shape, before any node has run. */
  onGraph: (steps: AgentStep[]) => void;
  onNode: (node: string, status: AgentStatus, detail?: string | null) => void;
  /** Notes as they are produced. `node` is absent for request-level notes. */
  onNotes: (notes: string[], node?: string) => void;
  onResult: (output: ScoutAdvice) => void;
  onError: (message: string) => void;
}

export interface AdviseRequest {
  question: string;
  team_id?: number | null;
  on_block_player_id?: number | null;
  budget_seconds?: number | null;
  thread_id?: string | null;
}

/** One decoded SSE payload. Every event carries a `type`. */
interface StreamEvent {
  type: "graph" | "node" | "notes" | "result" | "error" | string;
  labels?: NodeLabels;
  node?: string;
  status?: AgentStatus;
  detail?: string | null;
  notes?: string[];
  output?: ScoutAdvice;
}

/**
 * The order the pipeline is drawn in.
 *
 * The server sends the labels but not an order, because a dict has none worth
 * relying on. This is the order the graph actually runs in — START goes
 * unconditionally to `supervisor`, and everything else is downstream of it —
 * and any node the server names that is not listed here is appended rather
 * than dropped, so a fourth agent shows up without a frontend change.
 */
const STEP_ORDER = ["supervisor", "researcher", "advisor"] as const;

function stepsFrom(labels: NodeLabels): AgentStep[] {
  const known = STEP_ORDER.filter((id) => id in labels);
  const extra = Object.keys(labels).filter(
    (id) => !STEP_ORDER.includes(id as (typeof STEP_ORDER)[number]),
  );

  return [...known, ...extra].map((id) => ({
    id,
    title: labels[id].title,
    running: labels[id].running,
    done: labels[id].done,
    status: "idle" as AgentStatus,
    notes: [],
    runs: 0,
  }));
}

/**
 * Run one question through the graph, reporting progress as it happens.
 *
 * Resolves when the stream closes. Rejects only on a transport failure that
 * happens before the stream opens — once it is open, a backend failure arrives
 * as an `error` event through `onError`, because a stream that has already sent
 * its first byte cannot go back and become an HTTP error.
 */
export async function streamAdvice(
  request: AdviseRequest,
  handlers: OrchestratorHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;

  try {
    response = await fetch(apiUrl("/api/v1/scout/advise/stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) return;
    throw new RagError(
      "Could not reach SCOUT. Is the backend running?",
      null,
      true,
    );
  }

  if (!response.ok || !response.body) {
    throw new RagError(
      `SCOUT refused the request (${response.status}).`,
      response.status,
      response.status >= 500,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (raw: string) => {
    // Strip the `data: ` prefix from each line and rejoin, which is the SSE
    // rule for a payload that spans lines. Our payloads are single-line JSON,
    // but honouring the framing costs one line and removes a latent bug.
    const payload = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");

    if (!payload) return;

    let event: StreamEvent;
    try {
      event = JSON.parse(payload) as StreamEvent;
    } catch {
      // A malformed frame is not worth tearing the stream down for; the run
      // is still producing useful events after it.
      return;
    }

    switch (event.type) {
      case "graph":
        if (event.labels) handlers.onGraph(stepsFrom(event.labels));
        break;
      case "node":
        if (event.node && event.status) {
          handlers.onNode(event.node, event.status, event.detail);
        }
        break;
      case "notes":
        if (event.notes?.length) handlers.onNotes(event.notes, event.node);
        break;
      case "result":
        if (event.output) handlers.onResult(event.output);
        break;
      case "error":
        handlers.onError(event.detail || "SCOUT failed.");
        break;
      default:
        break;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. Everything after the last one is
      // an incomplete event and stays in the buffer for the next read.
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        dispatch(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
      }
    }

    // A final event with no trailing blank line — legal, and dropped by the
    // loop above.
    if (buffer.trim()) dispatch(buffer);
  } catch (error) {
    if (signal?.aborted) return;
    handlers.onError("The connection to SCOUT was lost.");
  } finally {
    reader.releaseLock();
  }
}
