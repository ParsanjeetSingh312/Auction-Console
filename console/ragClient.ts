/**
 * ragClient.ts
 * The console's only door to the Phase 2 RAG backend.
 *
 * Every network shape the backend returns is declared here and nowhere else, so
 * a change to the FastAPI schemas has exactly one place to land. The client is
 * deliberately transport-only: no React, no state, no formatting — it hands
 * back the payload the backend sent and lets the hooks decide what to do with
 * a failure.
 *
 * Timeouts are per-endpoint rather than global because the endpoints have wildly
 * different cost profiles. `/players` is a SQLite read and should answer in
 * milliseconds; `/search` and `/chat` may have to load a cross-encoder into
 * memory on the first call and legitimately take a minute.
 */
import { apiUrl, connectionHint, describeTarget } from "./apiBase";
import type { ApiPlayer } from "./types";

/**
 * Where the API lives is no longer decided here.
 *
 * It used to be a local constant, and so were two others — one in
 * `useAuctionSocket.ts` and one in `PostAuctionReport.tsx`. Three constants
 * meant three chances to disagree about the backend's address, and the report's
 * copy had no override variable at all. `apiBase.ts` is now the single answer;
 * see its header for how it is resolved and why a browser cannot simply read
 * the backend's own API_PORT.
 */

/** How the backend router resolved a query. */
export type Route = "METRIC_SQL" | "SEMANTIC_VECTOR" | "HYBRID";

/** One reranked vector hit. Mirrors SourceDocument. */
export interface SourceDocument {
  player_name: string;
  role: string | null;
  relevance_score: number | null;
  text: string | null;
}

/**
 * How the backend produced an answer.
 *
 * `local_analyst` means no language model was involved: the answer was composed
 * from the player table by rule. It is narrower than an LLM answer but every
 * figure in it came out of the database, so it is worth labelling rather than
 * hiding.
 */
export type AnswerMode = "llm" | "local_analyst";

/** POST /api/v1/search. Mirrors SearchResponse. */
export interface SearchResponse {
  answer: string;
  route: Route | string;
  sql_query: string | null;
  sql_results: Record<string, unknown>[];
  sources: SourceDocument[];
  mode: AnswerMode | string;
  /** Every fallback that fired while answering, in plain English. */
  notes: string[];
}

/** POST /api/v1/chat. Mirrors ChatResponse — note: no `sql_results`. */
export interface ChatResponse {
  answer: string;
  route: Route | string;
  sources: SourceDocument[];
  sql_query: string | null;
  mode: AnswerMode | string;
  notes: string[];
}

/** GET /api/v1/players. Mirrors PlayerListResponse. */
export interface PlayerListResponse {
  total: number;
  players: ApiPlayer[];
  limit: number;
  offset: number;
}

/** GET /api/v1/health. Mirrors HealthResponse. */
export interface HealthResponse {
  status: string;
  version: string;
  sqlite_players: number | null;
  chroma_documents: number | null;
  /** True when a well-formed synthesis key is configured. */
  llm_ready: boolean;
  /** Which path answers questions right now. */
  answer_mode: AnswerMode | string;
  /** Settings the backend's startup check flagged. */
  config_warnings: string[];
}

/** A turn of conversation, as ChatRequest.history expects it. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Raised for any non-2xx response or transport failure, with a usable message. */
export class RagError extends Error {
  readonly status: number | null;
  /**
   * Whether trying the same request again might succeed.
   *
   * Set by the transport, read by the retry loop, and left on the error so a
   * caller can tell "the backend is restarting" from "the backend said no".
   */
  readonly retryable: boolean;

  constructor(message: string, status: number | null = null, retryable = false) {
    super(message);
    this.name = "RagError";
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * `limit` is capped at 500 by the endpoint's own Query validator, which is
 * comfortably above the ~300 rows in the pool — so the console fetches the
 * roster in a single request and never paginates.
 */
const ROSTER_PAGE_SIZE = 500;

/**
 * Attempts per request: the first, plus two retries.
 *
 * Kept small on purpose. The failures this covers resolve in a second or two or
 * not at all, and a console that spends thirty seconds insisting before it
 * admits the backend is down is worse company than one that says so quickly.
 */
const MAX_ATTEMPTS = 3;

/** Pause before the second and third attempts, in ms. */
const RETRY_BACKOFF = [300, 900];

/**
 * Statuses worth a second try.
 *
 * All three mean "the server is there but cannot answer right now" — which is
 * what a reverse proxy in front of a restarting uvicorn reports. A 4xx is the
 * backend answering correctly and is never retried; nor is a 500, which is a
 * bug that will reproduce.
 */
const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** Sleep, unless the caller gives up first. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One trip to the backend. Throws `RagError` carrying its own retryability. */
async function attempt<T>(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  // One controller aborts on either the timeout or the caller's own signal, so
  // an unmounting component and a stalled model load unwind the same way.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  signal?.addEventListener("abort", relay);

  try {
    const response = await fetch(apiUrl(path), {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });

    if (!response.ok) {
      // FastAPI puts the useful part in `detail`; fall back to raw text.
      const body = await response.text().catch(() => "");
      let detail = body.slice(0, 300);
      try {
        const parsed = JSON.parse(body) as { detail?: string };
        if (parsed.detail) detail = parsed.detail;
      } catch {
        /* not JSON — the raw text is the best we have */
      }
      throw new RagError(
        `${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`,
        response.status,
        RETRYABLE_STATUS.has(response.status),
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof RagError) throw error;

    if (error instanceof DOMException && error.name === "AbortError") {
      // A caller-driven abort is not a failure worth reporting; rethrow it so
      // the hook can recognise and ignore it.
      if (signal?.aborted) throw error;

      // A timeout is deliberately NOT retryable. These deadlines are long — two
      // minutes for /chat — and a second attempt would double a wait the user
      // has already sat through, on a backend that is demonstrably busy.
      throw new RagError(
        "The request timed out. The embedding or reranker model may still be loading — try again.",
      );
    }

    // Everything left is a transport failure: connection refused, DNS, a
    // socket closed mid-flight. On this project that is most often uvicorn
    // restarting under `--reload`, which is over in about a second — so it is
    // the one case most worth trying again.
    throw new RagError(
      `Cannot reach the RAG backend at ${describeTarget()}. ${connectionHint()}`,
      null,
      true,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

/**
 * A request, with a short retry for failures that are plausibly transient.
 *
 * Retrying is safe for every endpoint here because all of them are reads:
 * `/players`, `/search`, `/chat` and `/health` answer questions and change
 * nothing, so a duplicate request costs time and no correctness. Were a
 * mutating endpoint ever added, it would need to opt out of this.
 */
async function request<T>(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let last: unknown;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await attempt<T>(path, init, timeoutMs, signal);
    } catch (error) {
      last = error;

      // The caller gave up; stop immediately and let the hook ignore it.
      if (signal?.aborted) throw error;
      if (!(error instanceof RagError) || !error.retryable) throw error;
      if (i === MAX_ATTEMPTS - 1) break;

      await pause(RETRY_BACKOFF[i], signal);
    }
  }

  // Out of attempts. The last error already carries the right message; only
  // note that this was not a one-off, so the reader knows it was given a
  // fair chance before being told the backend is down.
  if (last instanceof RagError) {
    throw new RagError(
      `${last.message} (tried ${MAX_ATTEMPTS} times)`,
      last.status,
      false,
    );
  }
  throw last;
}

/** GET /api/v1/players — the master roster the console runs on. */
export function fetchPlayers(signal?: AbortSignal): Promise<PlayerListResponse> {
  const params = new URLSearchParams({ limit: String(ROSTER_PAGE_SIZE), offset: "0" });
  return request<PlayerListResponse>(`/api/v1/players?${params}`, undefined, 30_000, signal);
}

/** POST /api/v1/search — hybrid natural-language + metric search. */
export function postSearch(
  query: string,
  options: { topK?: number; useReranker?: boolean } = {},
  signal?: AbortSignal,
): Promise<SearchResponse> {
  return request<SearchResponse>(
    "/api/v1/search",
    {
      method: "POST",
      body: JSON.stringify({
        query,
        top_k: options.topK ?? 8,
        use_reranker: options.useReranker ?? true,
      }),
    },
    120_000,
    signal,
  );
}

/** POST /api/v1/chat — conversational RAG with history. */
export function postChat(
  query: string,
  history: ChatTurn[],
  options: { topK?: number } = {},
  signal?: AbortSignal,
): Promise<ChatResponse> {
  return request<ChatResponse>(
    "/api/v1/chat",
    {
      method: "POST",
      body: JSON.stringify({ query, history, top_k: options.topK ?? 5 }),
    },
    120_000,
    signal,
  );
}

/** GET /api/v1/health — cheap reachability probe for the status pill. */
export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>("/api/v1/health", undefined, 10_000, signal);
}

