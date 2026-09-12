/**
 * Home.tsx
 * The welcome page's driver.
 *
 * Split from WelcomeHero on the same line the console already draws between
 * LiveBlock and BlockView: this file talks to the outside world, the component
 * it renders does not. Everything asynchronous — the backend probe, the
 * document title — happens here, and WelcomeHero receives a finished answer as
 * props. That keeps the landing's visuals testable without a server running,
 * and it means the one piece of network code on this page is four lines in one
 * place rather than a fetch buried in a presentational component.
 *
 * Why probe at all. The pool lives in the RAG backend, and if that backend is
 * not up then both destinations on this page are dead ends — the Data Interface
 * has nothing to show and the auction has no players to put on the block. A
 * user finding that out *after* choosing is a worse experience than a small
 * honest line before they choose, so the landing states what it knows.
 */
import { useCallback, useEffect, useState } from "react";

import { fetchHealth } from "../console/ragClient";
import WelcomeHero, { type BackendStatus } from "../components/WelcomeHero";

export default function Home() {
  const [status, setStatus] = useState<BackendStatus>({ state: "checking" });

  useEffect(() => {
    document.title = "AUCTIQ · IPL 2026 Mega Auction";
  }, []);

  /**
   * Bumped to re-run the probe.
   *
   * Landing while the backend is starting is the normal case, not an edge one:
   * uvicorn takes a few seconds and the console is usually opened straight
   * after it. Without this the only way to re-check is a full page reload,
   * which is a silly thing to ask of someone staring at a status line that
   * says "offline" about a server they just started.
   */
  const [probe, setProbe] = useState(0);
  const recheck = useCallback(() => {
    setStatus({ state: "checking" });
    setProbe((n) => n + 1);
  }, []);

  useEffect(() => {
    // Aborted on unmount so a slow probe cannot set state against a component
    // the user has already navigated away from — which on this page is the
    // common case, since choosing a destination is the whole point of it.
    const controller = new AbortController();

    fetchHealth(controller.signal)
      .then((health) => {
        setStatus({
          state: "up",
          players: health.sqlite_players,
          vectors: health.chroma_documents,
          // The Scout still answers with the deterministic local analyst when
          // no LLM key is configured, so this is reported as a capability
          // rather than as an outage.
          llmReady: health.llm_ready,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus({
          state: "down",
          message: error instanceof Error ? error.message : "Backend unreachable",
        });
      });

    return () => controller.abort();
  }, [probe]);

  return <WelcomeHero status={status} onRecheck={recheck} />;
}
