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
import type { ApiPlayer } from "./types";

/**
 * Where the API lives.
 *
 * In a production build the backend serves this bundle itself, so the API is
 * same-origin and a relative base is correct whatever host or port it is
 * reached on — localhost, a LAN address, or behind a proxy. Under `vite dev`
 * the page is served from :5173 while the API stays on :8001, so that one case
 * needs an absolute origin. `VITE_RAG_API_BASE` overrides both.
 */
const API_BASE =
  (import.meta.env?.VITE_RAG_API_BASE as string | undefined) ??
  (import.meta.env?.DEV ? "http://localhost:8001" : "");

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

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "RagError";
    this.status = status;
  }
}

/**
 * `limit` is capped at 500 by the endpoint's own Query validator, which is
 * comfortably above the ~300 rows in the pool — so the console fetches the
 * roster in a single request and never paginates.
 */
const ROSTER_PAGE_SIZE = 500;

async function request<T>(
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
    const response = await fetch(`${API_BASE}${path}`, {
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
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof RagError) throw error;

    if (error instanceof DOMException && error.name === "AbortError") {
      // A caller-driven abort is not a failure worth reporting; rethrow it so
      // the hook can recognise and ignore it.
      if (signal?.aborted) throw error;
      throw new RagError(
        "The request timed out. The embedding or reranker model may still be loading — try again.",
      );
    }

    throw new RagError(
      `Cannot reach the RAG backend at ${API_BASE || window.location.origin}. ` +
        `Start it with \`uvicorn api.main:app --port 8001\` from ipl_auction_rag_backend/.`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
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

