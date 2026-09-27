/**
 * apiBase.ts
 * Where the backend is, decided once for the whole console.
 *
 * Before this file there were three answers to that question, in three places,
 * and they did not agree:
 *
 *   ragClient.ts              VITE_RAG_API_BASE ?? (DEV ? localhost:8001 : "")
 *   useAuctionSocket.ts       VITE_AUCTION_WS   ?? (DEV ? localhost:8001 : ...)
 *   PostAuctionReport.tsx     DEV ? localhost:8001 : ""      <- no override
 *
 * Moving the backend off 8001 therefore fixed nothing and broke things
 * unevenly: the report had no override to set, so it kept dialling 8001 while
 * the other two followed their variables. That is the shape of the failure
 * reported as "the RAG backend is not connected to the port the console is
 * running on" — not a wrong port so much as three ports free to disagree.
 *
 * Everything that talks to the backend now imports from here.
 *
 * ---------------------------------------------------------------------------
 * Why the browser cannot simply read API_PORT
 *
 * The backend's port lives in ipl_auction_rag_backend/.env, read by
 * pydantic-settings inside the Python process. This bundle is a static file
 * served to a browser; it has no filesystem and no access to that process. So
 * "read the port from the backend config" is not something a client can do —
 * the value has to be handed to the build, or the request has to be made
 * same-origin so that no port is named at all.
 *
 * This module supports both, and prefers the second.
 * ---------------------------------------------------------------------------
 */

/** The port the FastAPI app listens on by default. Matches API_PORT in .env. */
const DEFAULT_API_PORT = 8001;

/** The API's mount point. Both REST and the auction socket live under it. */
export const API_PREFIX = "/api/v1";

/**
 * Read one Vite variable defensively.
 *
 * `import.meta.env` is replaced at build time, so a variable that was never
 * defined reads as `undefined` rather than throwing — but the optional chaining
 * is kept because this module is also reachable from unit tests running outside
 * Vite, where `import.meta.env` itself may be absent.
 */
function env(key: string): string | undefined {
  const bag = import.meta.env as Record<string, unknown> | undefined;
  const value = bag?.[key];
  return typeof value === "string" ? value : undefined;
}

function isDev(): boolean {
  return Boolean((import.meta.env as { DEV?: boolean } | undefined)?.DEV);
}

/**
 * The configured backend port, validated.
 *
 * A junk value earns a warning rather than a silent fallback: VITE_RAG_PORT
 * mistyped with a letter O would otherwise produce a console that dials 8001
 * while the operator believes it is dialling something else — the exact class
 * of bug this file exists to end.
 */
function resolvePort(): number {
  const raw = env("VITE_RAG_PORT");
  if (raw === undefined || raw.trim() === "") return DEFAULT_API_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.warn(
      "[apiBase] VITE_RAG_PORT=\"" +
        raw +
        "\" is not a valid port (1-65535). Falling back to " +
        DEFAULT_API_PORT +
        ".",
    );
    return DEFAULT_API_PORT;
  }
  return port;
}

/**
 * The origin to prefix REST calls with. Empty string means "same origin".
 *
 * Precedence, most specific first:
 *
 *   1. VITE_RAG_API_BASE   an explicit origin, or an explicit empty string.
 *                          Setting it empty is how you opt into the Vite dev
 *                          proxy: every request then goes to the page's own
 *                          origin and Vite forwards it, so no port appears in
 *                          client code at all.
 *
 *   2. dev                 http://<the page's hostname>:<VITE_RAG_PORT|8001>
 *
 *   3. production          "" — the FastAPI app serves this bundle itself (see
 *                          api/main.py, `serve_console`), so the API is
 *                          same-origin on whatever host and port it was
 *                          reached at.
 *
 * Rule 2 follows `window.location.hostname` rather than hardcoding `localhost`.
 * vite.config.ts binds the dev server to 0.0.0.0, so the console is routinely
 * opened from another machine on the LAN — and a hardcoded `localhost` there
 * means *that machine's* localhost, where nothing is listening. Following the
 * page's hostname makes a LAN client reach the same backend the developer is
 * looking at.
 */
function resolveHttpBase(): string {
  const override = env("VITE_RAG_API_BASE");
  if (override !== undefined) return override.replace(/\/+$/, "");

  if (!isDev()) return "";

  // `window` is absent under SSR or a node-based test runner; fall back to a
  // loopback origin rather than throwing at module scope.
  const host =
    typeof window !== "undefined" && window.location.hostname
      ? window.location.hostname
      : "localhost";

  return "http://" + host + ":" + resolvePort();
}

/** Resolved once: it cannot change without a reload, and it is read often. */
const HTTP_BASE = resolveHttpBase();

/**
 * The origin REST calls are made against.
 *
 * Returns "" for same-origin, which is a valid prefix — `httpBase() + path`
 * is then just the path, and the browser resolves it against the page.
 */
export function httpBase(): string {
  return HTTP_BASE;
}

/** A full REST URL for a path under the API. `path` must start with "/". */
export function apiUrl(path: string): string {
  return HTTP_BASE + path;
}

/**
 * The auction WebSocket URL.
 *
 * VITE_AUCTION_WS still wins outright, because a socket is occasionally pointed
 * somewhere entirely different from the REST API while debugging. With it unset
 * the socket follows the REST base, so the two can no longer drift apart —
 * which is what allowed a console to load its roster successfully and then fail
 * to join the room.
 *
 * `http` becomes `ws` and `https` becomes `wss`, derived rather than assumed,
 * so a deployment behind TLS does not have to remember a second variable.
 */
export function wsUrl(path: string = API_PREFIX + "/auction/ws"): string {
  const override = env("VITE_AUCTION_WS");
  if (override) return override;

  // Same-origin: follow the page's own scheme and authority.
  if (!HTTP_BASE) {
    const secure =
      typeof window !== "undefined" && window.location.protocol === "https:";
    const host = typeof window !== "undefined" ? window.location.host : "localhost";
    return (secure ? "wss://" : "ws://") + host + path;
  }

  return HTTP_BASE.replace(/^http/, "ws") + path;
}

/**
 * The backend's address in words, for error messages.
 *
 * An unreachable backend should say *which* address failed. "Cannot reach the
 * RAG backend" sends an operator to check a server that may be running
 * perfectly well on a port the console was never looking at.
 */
export function describeTarget(): string {
  if (HTTP_BASE) return HTTP_BASE;
  return typeof window !== "undefined" ? window.location.origin : "the current origin";
}

/**
 * A one-line diagnosis to append to a connection failure.
 *
 * Ordered by how often each cause is actually the cause, which is not the order
 * you would guess. On this project the backend being *stopped* is far more
 * common than the console pointing at the wrong port, and it has a specific
 * cause worth naming: loading the reranker (BAAI/bge-reranker-large, ~2.2 GB)
 * on the first search is the single largest allocation the process makes, and a
 * machine already running a Vite build alongside it can run out of memory and
 * have the server killed mid-request. That looks identical to a wrong port from
 * the browser -- the fetch simply fails -- so the message has to raise it.
 *
 * The port advice stays, second, for the case where it genuinely is the port.
 * The rebuild instruction says `npm run build` rather than `npm run dev`
 * because the backend serves the compiled bundle from dist/; a dev server is
 * not part of how this project is run.
 */
export function connectionHint(): string {
  return (
    "The backend may have stopped -- check the terminal running it. If it was " +
    "killed during a search, the reranker model needs about 2.2 GB and may " +
    "have run out of memory alongside another heavy process. Restart it from " +
    "ipl_auction_rag_backend/ with `uvicorn api.main:app --reload --port " +
    resolvePort() +
    "`. If it is running and reachable on a different port, set VITE_RAG_PORT " +
    "(or VITE_RAG_API_BASE) in a .env.local at the repository root, then " +
    "re-run `npm run build`."
  );
}
