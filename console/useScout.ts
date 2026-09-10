/**
 * useScout.ts
 * The RAG side of the console: hybrid search, the conversational assistant, and
 * the backend health probe.
 *
 * The one idea worth explaining is context injection. When a player is on the
 * block, every question the user asks is implicitly about that player — "is he
 * worth it?", "who else could do this job?" — but the backend has no way to
 * know that, and `ChatRequest` has no field for it. So the hook prefixes the
 * question with a compact factual brief drawn from the roster row the console
 * already holds. Nothing is invented: the brief is the same 17 attributes the
 * backend served, restated in a sentence the retriever and the LLM can both
 * use.
 *
 * The prefix is budgeted rather than blindly prepended, because `query` is
 * capped at 500 characters by the endpoint's own validator. The user's question
 * always wins; the brief is trimmed to whatever room is left.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { count, money, stat } from "./format";
import {
  fetchHealth,
  postChat,
  postSearch,
  RagError,
} from "./ragClient";
import type {
  ChatResponse,
  ChatTurn,
  HealthResponse,
  SearchResponse,
} from "./ragClient";
import type { ConsolePlayer } from "./types";

/** Matches ChatRequest.query / QueryRequest.query `max_length=500`. */
const QUERY_LIMIT = 500;

/** A rendered turn in the assistant transcript. */
export interface ChatMessage extends ChatTurn {
  id: number;
  /** Route and sources, on assistant turns that came from the backend. */
  route?: string;
  sources?: ChatResponse["sources"];
  sqlQuery?: string | null;
  /** Which engine wrote the answer — "llm" or "local_analyst". */
  mode?: string;
  /** Fallbacks the backend reported for this turn. */
  notes?: string[];
  /** Set when the turn is an error rather than a real answer. */
  failed?: boolean;
  /** The player the question was asked against, for the transcript's own record. */
  contextName?: string;
}

export interface ScoutState {
  /* health */
  health: HealthResponse | null;
  isReachable: boolean | null;
  /**
   * Probe the backend. Not fired on mount: `/api/v1/health` constructs a
   * ChromaManager, which loads the embedding model, and the route is a sync
   * handler — so on a cold start it holds FastAPI's event loop for as long as
   * the model takes. Probing before the roster is in would stall the one
   * request the console cannot open without. The caller decides when.
   */
  checkHealth: () => void;

  /* search */
  searchResult: SearchResponse | null;
  searchQuery: string;
  isSearching: boolean;
  searchError: string | null;
  runSearch: (query: string) => void;
  clearSearch: () => void;

  /* chat */
  messages: ChatMessage[];
  isAnswering: boolean;
  ask: (question: string, context: ConsolePlayer | null) => void;
  clearChat: () => void;
}

/**
 * A one-line factual brief on the player currently on the block.
 *
 * Only figures the dataset actually holds are included — an absent statistic is
 * omitted rather than reported as zero, which would tell the model something
 * false about the player.
 */
export function playerBrief(player: ConsolePlayer): string {
  const facts: string[] = [
    player.role,
    player.cap === "CAPPED" ? "capped" : "uncapped",
  ];
  if (player.country) facts.push(player.country);
  else if (player.overseas) facts.push("overseas");
  facts.push(`base ${money(player.base)}`);
  if (player.rating != null) facts.push(`rating ${stat(player.rating, 2)}`);

  const s = player.stats;
  const figures: string[] = [];
  if (s.matches != null) figures.push(`${count(s.matches)} matches`);

  if (player.roleShort === "BOWL") {
    if (s.wickets != null) figures.push(`${count(s.wickets)} wickets`);
    if (s.economy != null) figures.push(`economy ${stat(s.economy)}`);
    if (s.bowl_avg != null) figures.push(`avg ${stat(s.bowl_avg)}`);
    if (s.econ_vs_lhb != null) figures.push(`econ v LHB ${stat(s.econ_vs_lhb)}`);
    if (s.econ_vs_rhb != null) figures.push(`econ v RHB ${stat(s.econ_vs_rhb)}`);
  } else {
    if (s.total_runs != null) figures.push(`${count(s.total_runs)} runs`);
    if (s.bat_avg != null) figures.push(`avg ${stat(s.bat_avg)}`);
    if (s.bat_sr != null) figures.push(`SR ${stat(s.bat_sr)}`);
    if (s.sr_vs_spin != null) figures.push(`SR v spin ${stat(s.sr_vs_spin)}`);
    if (s.sr_vs_fast != null) figures.push(`SR v pace ${stat(s.sr_vs_fast)}`);
  }

  const tail = figures.length ? `; ${figures.join(", ")}` : "";
  return `${player.name} (${facts.join(", ")}${tail})`;
}

/**
 * Fold the on-block player into a question, within the endpoint's length cap.
 *
 * If the question alone leaves no useful room, the brief is dropped entirely
 * rather than truncated to a fragment that would misreport a figure.
 */
export function withPlayerContext(question: string, player: ConsolePlayer | null): string {
  const asked = question.trim();
  if (!player) return asked.slice(0, QUERY_LIMIT);

  const prefix = `On the auction block: ${playerBrief(player)}. Question: `;
  if (prefix.length + asked.length <= QUERY_LIMIT) return prefix + asked;

  // Fall back to naming the player, which is still enough for the retriever to
  // pull the right profile even though the figures did not fit.
  const short = `On the auction block: ${player.name} (${player.role}). Question: `;
  if (short.length + asked.length <= QUERY_LIMIT) return short + asked;

  return asked.slice(0, QUERY_LIMIT);
}

function messageFor(error: unknown): string {
  if (error instanceof RagError) return error.message;
  return "The Scout backend did not answer.";
}

export function useScout(): ScoutState {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [isReachable, setIsReachable] = useState<boolean | null>(null);

  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isAnswering, setIsAnswering] = useState(false);

  // One in-flight request per channel. A newer query supersedes an older one
  // rather than racing it — otherwise a slow first search can land after a fast
  // second one and overwrite the results the user is actually reading.
  const searchAbort = useRef<AbortController | null>(null);
  const chatAbort = useRef<AbortController | null>(null);
  const nextId = useRef(1);

  const checkHealth = useCallback(() => {
    fetchHealth()
      .then((data) => {
        setHealth(data);
        setIsReachable(true);
      })
      .catch(() => {
        setHealth(null);
        setIsReachable(false);
      });
  }, []);

  // Abandon anything still in flight when the console unmounts.
  useEffect(
    () => () => {
      searchAbort.current?.abort();
      chatAbort.current?.abort();
    },
    [],
  );

  const runSearch = useCallback((query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;

    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;

    setSearchQuery(trimmed);
    setIsSearching(true);
    setSearchError(null);

    postSearch(trimmed.slice(0, QUERY_LIMIT), {}, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setSearchResult(result);
        setIsSearching(false);
        setIsReachable(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSearchError(messageFor(error));
        setIsSearching(false);
      });
  }, []);

  const clearSearch = useCallback(() => {
    searchAbort.current?.abort();
    setSearchResult(null);
    setSearchError(null);
    setSearchQuery("");
    setIsSearching(false);
  }, []);

  /**
   * The transcript, mirrored into a ref so `ask` can read the history it needs
   * without listing `messages` as a dependency — which would rebuild the
   * callback on every turn and re-render the composer mid-typing.
   */
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const ask = useCallback(
    (question: string, context: ConsolePlayer | null) => {
      const trimmed = question.trim();
      if (!trimmed) return;

      chatAbort.current?.abort();
      const controller = new AbortController();
      chatAbort.current = controller;

      // Only successful turns become history; a failed one is a transport
      // error, not something the model said.
      const history: ChatTurn[] = messagesRef.current
        .filter((m) => !m.failed)
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content }));

      // The transcript keeps the question as the user typed it; only the wire
      // payload carries the context prefix, so re-reading the conversation does
      // not mean re-reading the same brief a dozen times.
      setMessages((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: "user",
          content: trimmed,
          contextName: context?.name,
        },
      ]);
      setIsAnswering(true);

      postChat(withPlayerContext(trimmed, context), history, {}, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setMessages((current) => [
            ...current,
            {
              id: nextId.current++,
              role: "assistant",
              content: response.answer,
              route: response.route,
              sources: response.sources,
              sqlQuery: response.sql_query,
              // Which engine wrote this turn, and any fallback that fired.
              // Carried per-message rather than read from health, because the
              // mode can change between turns — a rate-limited LLM answers one
              // question and not the next.
              mode: response.mode,
              notes: response.notes,
            },
          ]);
          setIsAnswering(false);
          setIsReachable(true);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setMessages((current) => [
            ...current,
            {
              id: nextId.current++,
              role: "assistant",
              content: messageFor(error),
              failed: true,
            },
          ]);
          setIsAnswering(false);
        });
    },
    [],
  );

  const clearChat = useCallback(() => {
    chatAbort.current?.abort();
    setMessages([]);
    setIsAnswering(false);
  }, []);

  return {
    health,
    isReachable,
    checkHealth,

    searchResult,
    searchQuery,
    isSearching,
    searchError,
    runSearch,
    clearSearch,

    messages,
    isAnswering,
    ask,
    clearChat,
  };
}
