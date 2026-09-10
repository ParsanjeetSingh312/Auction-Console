/**
 * ScoutView.tsx
 * The RAG workspace: the conversational assistant, hybrid search, and the
 * briefing on whoever is currently on the block.
 *
 * This is where the two halves of the console meet. The auction engine holds
 * the on-block player; this view reads it, shows the 17-attribute breakdown for
 * that player, and passes them as context on every question — so "is he worth
 * it?" resolves against the right profile without the user naming anyone. In
 * the other direction, every player the backend returns carries a Put up button
 * that hands them straight to the block, matched back to the roster by name.
 *
 * Sources come back with a `player_name` and nothing else — SourceDocument has
 * no id — so the link back to a roster row is a normalised-name lookup. When
 * that lookup fails the row still renders; it simply loses its Put up button
 * rather than pretending to be actionable.
 */
import { useMemo, useState } from "react";

import {
  boldSegments,
  columnLabel,
  cssVars,
  money,
  parseAnswer,
  ratingLabel,
  roleGlyphClass,
  roleGlyphText,
  roleShort,
  setMeta,
  stat,
  statLines,
} from "../../console/format";
import type { SearchResponse, SourceDocument } from "../../console/ragClient";
import type { ConsolePlayer } from "../../console/types";
import type { AuctionEngine } from "../../console/useAuctionEngine";
import type { ChatMessage, ScoutState } from "../../console/useScout";

/** How the backend router resolved a query, and what that means. */
const ROUTES: Record<string, { label: string; hint: string; tag: string }> = {
  METRIC_SQL: {
    label: "SQL",
    hint: "Answered by a generated SQL query over the stats table",
    tag: "tag-sold",
  },
  SEMANTIC_VECTOR: {
    label: "Semantic",
    hint: "Answered by vector search plus cross-encoder reranking",
    tag: "tag-neutral",
  },
  HYBRID: {
    label: "Hybrid",
    hint: "Combined SQL filtering and semantic retrieval",
    tag: "tag-live",
  },
};

/**
 * Which engine produced an answer.
 *
 * The deterministic analyst is a genuine answer, not an error state — every
 * figure in it came from the player table — so it gets a neutral badge and a
 * tooltip explaining the trade-off, rather than a warning banner.
 */
const MODES: Record<string, { label: string; hint: string; tag: string }> = {
  llm: {
    label: "LLM",
    hint: "Written by a language model from the retrieved data",
    tag: "tag-sold",
  },
  local_analyst: {
    label: "Rule-based",
    hint:
      "Composed from the player table without a language model. Every figure is " +
      "read straight from the database; the trade-off is narrower phrasing and " +
      "no follow-up memory.",
    tag: "tag-neutral",
  },
};

/** Fallbacks the backend reported, listed under an answer. */
function Notes({ notes }: { notes?: string[] }) {
  if (!notes?.length) return null;
  return (
    <ul className="mt-2 space-y-0.5 border-t border-rule-soft pt-2">
      {notes.map((note) => (
        <li key={note} className="font-mono text-tiny text-muted">
          {note}
        </li>
      ))}
    </ul>
  );
}

/** One per retrieval archetype the router recognises. */
const EXAMPLES = [
  "explosive finisher who dominates spin in the death overs",
  "economical bowler with economy under 8 against right handers",
  "reliable anchor with a batting average above 35",
  "uncapped keeper with no IPL record",
  "all-rounders with a strike rate above 150",
];

export default function ScoutView({
  scout,
  engine,
  onNotice,
}: {
  scout: ScoutState;
  engine: AuctionEngine;
  onNotice: (message: string, kind?: "err") => void;
}) {
  const [question, setQuestion] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const active = engine.activePlayer;

  /**
   * Name → roster row, for resolving what the backend sends back. Names are
   * normalised because the vector store's copy has been through an Excel round
   * trip and can differ in punctuation and spacing.
   */
  const byName = useMemo(() => {
    const index = new Map<string, ConsolePlayer>();
    for (const player of engine.players) index.set(normalise(player.name), player);
    return index;
  }, [engine.players]);

  function putUp(name: string) {
    const player = byName.get(normalise(name));
    if (!player) {
      onNotice(`${name} is not in the loaded pool.`, "err");
      return;
    }
    const result = engine.putOnBlock(player.id);
    onNotice(result.message ?? `${player.name} is on the block.`, result.ok ? undefined : "err");
  }

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-3">
        <section className="panel shadow-card">
          <header className="panel-head">
            <span className="eyebrow">Scout assistant</span>
            <span className="flex items-center gap-2">
              <BackendStatus scout={scout} />
              {scout.messages.length > 0 && (
                <button type="button" className="linkbtn" onClick={scout.clearChat}>
                  clear
                </button>
              )}
            </span>
          </header>

          {active && (
            <div className="flex items-center gap-2 border-b border-rule-soft bg-teal-tint px-3 py-2">
              <span
                className={`roleglyph shrink-0 ${roleGlyphClass(active.roleShort)}`}
                aria-hidden
              >
                {roleGlyphText(active.roleShort)}
              </span>
              <span className="min-w-0 flex-1 truncate text-mini">
                Answering about <b className="font-semibold">{active.name}</b> — the player on the
                block.
              </span>
            </div>
          )}

          <Transcript messages={scout.messages} isAnswering={scout.isAnswering} onPutUp={putUp} />

          <form
            className="flex items-stretch gap-2 border-t border-rule-soft p-3"
            onSubmit={(event) => {
              event.preventDefault();
              scout.ask(question, active);
              setQuestion("");
            }}
          >
            <label htmlFor="scout-ask" className="sr-only">
              Ask the scout
            </label>
            <input
              id="scout-ask"
              className="field"
              value={question}
              maxLength={500}
              autoComplete="off"
              placeholder={
                active
                  ? `Ask about ${active.surname}, or anyone else in the pool`
                  : "Ask about any player, role or matchup"
              }
              onChange={(event) => setQuestion(event.target.value)}
            />
            <button type="submit" className="btn" disabled={scout.isAnswering || !question.trim()}>
              {scout.isAnswering ? "Thinking…" : "Ask"}
            </button>
          </form>
        </section>

        <section className="panel shadow-card">
          <header className="panel-head">
            <span className="eyebrow">Hybrid search</span>
            <span className="eyebrow">sql · vector · reranked</span>
          </header>

          <div className="p-3">
            <p className="mb-2.5 text-mini text-muted">
              Ask in plain English, or state the metrics outright. The backend routes each query to
              SQL, semantic retrieval, or both.
            </p>

            <form
              className="flex items-stretch gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                scout.runSearch(searchDraft);
              }}
            >
              <label htmlFor="scout-search" className="sr-only">
                Search the player pool
              </label>
              <input
                id="scout-search"
                className="field"
                value={searchDraft}
                maxLength={500}
                autoComplete="off"
                spellCheck={false}
                placeholder="e.g. death-overs finisher with a strike rate over 180"
                onChange={(event) => setSearchDraft(event.target.value)}
              />
              <button
                type="submit"
                className="btn"
                disabled={scout.isSearching || !searchDraft.trim()}
              >
                {scout.isSearching ? "Searching…" : "Search"}
              </button>
            </form>

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="eyebrow mr-1">Try</span>
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="chip disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={scout.isSearching}
                  onClick={() => {
                    setSearchDraft(example);
                    scout.runSearch(example);
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        </section>

        <SearchResults scout={scout} onPutUp={putUp} />
      </div>

      <aside className="min-w-0">
        <BlockBriefing player={active} engine={engine} />
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Transcript
 * ------------------------------------------------------------------ */

function Transcript({
  messages,
  isAnswering,
  onPutUp,
}: {
  messages: ChatMessage[];
  isAnswering: boolean;
  onPutUp: (name: string) => void;
}) {
  if (messages.length === 0 && !isAnswering) {
    return (
      <p className="px-3 py-8 text-center text-mini text-muted">
        Put a player on the block and the assistant answers about them by default — or ask about
        anyone in the pool.
      </p>
    );
  }

  return (
    <div className="chatlog max-h-[46vh]">
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.id} className="bubble from-user">
            {message.contextName && <span className="ctx">re: {message.contextName}</span>}
            {message.content}
          </div>
        ) : (
          <div
            key={message.id}
            className={`bubble from-bot${message.failed ? " is-error" : ""}`}
          >
            {message.failed ? (
              message.content
            ) : (
              <AssistantTurn message={message} onPutUp={onPutUp} />
            )}
          </div>
        ),
      )}

      {isAnswering && (
        <div className="bubble from-bot" aria-busy="true">
          <span className="eyebrow">retrieving · reranking · synthesising…</span>
        </div>
      )}
    </div>
  );
}

function AssistantTurn({
  message,
  onPutUp,
}: {
  message: ChatMessage;
  onPutUp: (name: string) => void;
}) {
  const answer = parseAnswer(message.content);
  const route = message.route ? ROUTES[message.route] : undefined;
  const mode = message.mode ? MODES[message.mode] : undefined;

  return (
    <>
      {answer.llmAvailable ? (
        <Prose text={answer.body} />
      ) : (
        <LlmUnavailableNotice notices={answer.notices} />
      )}

      {(route || mode || (message.sources?.length ?? 0) > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-rule-soft pt-2">
          {mode && (
            <span className={`tag ${mode.tag}`} title={mode.hint}>
              {mode.label}
            </span>
          )}
          {route && (
            <span className={`tag ${route.tag}`} title={route.hint}>
              {route.label}
            </span>
          )}
          {message.sources?.slice(0, 4).map((source) => (
            <button
              key={source.player_name}
              type="button"
              className="mini"
              title={`Put ${source.player_name} on the block`}
              onClick={() => onPutUp(source.player_name)}
            >
              {source.player_name} ↑
            </button>
          ))}
        </div>
      )}

      <Notes notes={message.notes} />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Search results
 * ------------------------------------------------------------------ */

function SearchResults({
  scout,
  onPutUp,
}: {
  scout: ScoutState;
  onPutUp: (name: string) => void;
}) {
  if (scout.isSearching) return <SearchSkeleton />;

  if (scout.searchError) {
    return (
      <section className="panel border-unsold/40 bg-unsold-tint shadow-card" role="alert">
        <header className="panel-head border-unsold/20">
          <span className="eyebrow text-unsold">Search failed</span>
          <button type="button" className="linkbtn text-unsold" onClick={scout.clearSearch}>
            dismiss
          </button>
        </header>
        <p className="px-3 py-2.5 text-mini text-unsold">{scout.searchError}</p>
      </section>
    );
  }

  const result = scout.searchResult;
  if (!result) return null;

  const route = ROUTES[result.route] ?? {
    label: String(result.route),
    hint: "Routing path reported by the backend",
    tag: "tag-neutral",
  };
  const mode = MODES[result.mode];
  const answer = parseAnswer(result.answer);

  return (
    <>
      <section className="panel shadow-card">
        <header className="panel-head">
          <span className="eyebrow">Analysis · “{scout.searchQuery}”</span>
          <span className="flex items-center gap-2">
            {mode && (
              <span className={`tag ${mode.tag}`} title={mode.hint}>
                {mode.label}
              </span>
            )}
            <span className={`tag ${route.tag}`} title={route.hint}>
              {route.label}
            </span>
            <button type="button" className="linkbtn" onClick={scout.clearSearch}>
              clear
            </button>
          </span>
        </header>

        {answer.llmAvailable ? (
          <>
            <Prose text={answer.body} className="px-3 py-2.5" />
            {answer.notices.length > 0 && (
              <ul className="border-t border-rule-soft px-3 py-2">
                {answer.notices.map((notice) => (
                  <li key={notice} className="font-mono text-tiny text-live">
                    {notice}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <LlmUnavailableNotice notices={answer.notices} />
        )}

        {result.notes.length > 0 && (
          <div className="px-3 pb-2.5">
            <Notes notes={result.notes} />
          </div>
        )}

        {result.sql_query && (
          <details className="border-t border-rule-soft">
            <summary className="eyebrow cursor-pointer px-3 py-2 hover:text-ink-soft">
              Generated SQL
            </summary>
            <pre className="overflow-x-auto border-t border-rule-soft bg-paper px-3 py-2.5 font-mono text-tiny text-teal-ink">
              {result.sql_query}
            </pre>
          </details>
        )}
      </section>

      {result.sources.length > 0 && (
        <section className="panel shadow-card">
          <header className="panel-head">
            <span className="eyebrow">Top matches</span>
            <span className="eyebrow">reranked · cross-encoder</span>
          </header>
          <ol>
            {result.sources.map((source, index) => (
              <SourceRow
                key={`${source.player_name}-${index}`}
                rank={index + 1}
                source={source}
                onPutUp={onPutUp}
              />
            ))}
          </ol>
        </section>
      )}

      {result.sql_results.length > 0 && <SqlTable rows={result.sql_results} />}
    </>
  );
}

function SourceRow({
  rank,
  source,
  onPutUp,
}: {
  rank: number;
  source: SourceDocument;
  onPutUp: (name: string) => void;
}) {
  const code = roleShort(source.role);

  return (
    <li className="flex items-start gap-2.5 border-b border-rule-soft px-3 py-2.5 last:border-b-0">
      <span className="num mt-0.5 w-4 text-right font-mono text-micro text-muted">{rank}</span>
      <span className={`roleglyph mt-0.5 shrink-0 ${roleGlyphClass(code)}`} aria-hidden>
        {roleGlyphText(code)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate font-semibold uppercase tracking-[0.01em]">
            {source.player_name}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {source.relevance_score !== null && (
              <span
                className="num font-display text-[15px] font-bold text-teal-ink"
                title="Cross-encoder relevance score"
              >
                {stat(source.relevance_score, 3)}
              </span>
            )}
            <button type="button" className="mini" onClick={() => onPutUp(source.player_name)}>
              Put up
            </button>
          </span>
        </div>
        {source.role && <span className="eyebrow">{source.role}</span>}
        {source.text && <p className="clamp-2 mt-1 text-mini text-muted">{source.text}</p>}
      </div>
    </li>
  );
}

/**
 * The rows a generated SQL query returned.
 *
 * The surrogate key and any column that is null across every row are dropped —
 * a bowler-only result set would otherwise render seven empty batting columns.
 */
function SqlTable({ rows }: { rows: SearchResponse["sql_results"] }) {
  const columns = Object.keys(rows[0]).filter(
    (column) => column !== "id" && rows.some((row) => row[column] !== null),
  );

  return (
    <section className="panel shadow-card">
      <header className="panel-head">
        <span className="eyebrow">Query results</span>
        <span className="eyebrow">
          <span className="num">{rows.length}</span> rows
        </span>
      </header>
      <div className="max-h-[420px] overflow-auto">
        <table className="sheet">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col">
                  {columnLabel(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => {
                  const value = row[column];
                  const numeric = typeof value === "number";
                  return (
                    <td key={column} className={numeric ? "c-num font-mono text-tiny" : ""}>
                      {value == null ? "—" : numeric ? stat(value) : String(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * On-the-block briefing
 * ------------------------------------------------------------------ */

/**
 * The full attribute breakdown for the player being bid on, alongside what each
 * team could still afford to pay for them. This is the sheet the room actually
 * wants open while the price climbs.
 */
function BlockBriefing({
  player,
  engine,
}: {
  player: ConsolePlayer | null;
  engine: AuctionEngine;
}) {
  if (!player) {
    return (
      <section className="panel border-dashed shadow-none">
        <p className="px-3 py-10 text-center text-mini text-muted">
          Put a player on the block to see their full breakdown here.
        </p>
      </section>
    );
  }

  const meta = setMeta(player.set);
  const lines = statLines(player);

  return (
    <section className="panel shadow-card">
      <header className="panel-head" style={cssVars({ "--band": meta.rail })}>
        <span className="eyebrow">On the block</span>
        <span className="setpill" style={cssVars({ "--band": meta.band })}>
          {player.set}
        </span>
      </header>

      <div className="border-b border-rule-soft px-3 py-2.5">
        <div className="font-display text-[22px] font-bold uppercase leading-none">
          {player.surname}
        </div>
        <div className="eyebrow mt-1">
          {player.first} · {player.role} · {player.cap === "CAPPED" ? "Capped" : "Uncapped"}
        </div>
      </div>

      <div className="kv">
        <div>
          <div className="eyebrow">Country</div>
          <b>
            {player.country ?? "—"}
            {player.overseas && " ✈"}
          </b>
        </div>
        <div>
          <div className="eyebrow">Base</div>
          <b>{money(player.base)}</b>
        </div>
        <div>
          <div className="eyebrow">Rating</div>
          <b>{ratingLabel(player.rating)}</b>
        </div>
        {lines.map((line) => (
          <div key={line.label}>
            <div className="eyebrow">{line.label}</div>
            <b>{line.value}</b>
          </div>
        ))}
      </div>

      <header className="panel-head border-t border-rule-soft">
        <span className="eyebrow">Who can still pay</span>
        <span className="eyebrow">max bid</span>
      </header>
      <div className="bars">
        {engine.summaries.map((summary) => {
          const ceiling = Math.max(1, ...engine.summaries.map((s) => s.maxBid));
          const blocked = engine.blockedReason(summary.team.id, player, engine.nextAsk);
          return (
            <div
              key={summary.team.id}
              className="barrow"
              style={cssVars({ "--band": summary.team.color })}
              title={blocked ?? "Can bid"}
            >
              <span className={`bl ${blocked ? "text-muted line-through" : ""}`}>
                {summary.team.name}
              </span>
              <span className="bt">
                <i style={{ width: `${(summary.maxBid / ceiling) * 100}%` }} />
              </span>
              <span className="bv">{money(summary.maxBid)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Shared bits
 * ------------------------------------------------------------------ */

function BackendStatus({ scout }: { scout: ScoutState }) {
  if (scout.isReachable === null) return <span className="eyebrow">checking…</span>;

  if (!scout.isReachable) {
    return (
      <span className="flex items-center gap-2">
        <span className="tag tag-unsold">
          <span aria-hidden className="mr-1.5 h-1.5 w-1.5 rounded-full bg-unsold" />
          RAG offline · port 8001
        </span>
        <button type="button" className="linkbtn" onClick={scout.checkHealth}>
          retry
        </button>
      </span>
    );
  }

  return (
    <span className="tag tag-sold" title="Rows indexed in the vector store">
      <span aria-hidden className="mr-1.5 h-1.5 w-1.5 rounded-full bg-sold" />
      <span className="num">{scout.health?.sqlite_players ?? 0}</span>
      <span className="ml-1">indexed</span>
    </span>
  );
}

/** Renders the LLM's prose, honouring the `**bold**` its prompt produces. */
function Prose({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  return (
    <div className={className}>
      {boldSegments(text).map((segment, index) =>
        segment.bold ? (
          <strong key={index} className="font-semibold text-ink">
            {segment.text}
          </strong>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </div>
  );
}

/**
 * Shown when the backend answered without an LLM. The ranked matches are still
 * genuine — only the written synthesis is missing — so this explains the gap
 * instead of surfacing the backend's raw fallback dump.
 */
function LlmUnavailableNotice({ notices }: { notices: string[] }) {
  return (
    <div className="border-l-2 border-live bg-live-tint px-3 py-2.5">
      <p className="text-ink-soft">
        Retrieval ran, but no language model is configured — so there is no written analysis, only
        the ranked matches.
      </p>
      <p className="mt-1.5 text-mini text-muted">
        Add <code className="font-mono text-tiny text-ink">GROQ_API_KEY</code> to{" "}
        <code className="font-mono text-tiny text-ink">ipl_auction_rag_backend/.env</code> and
        restart the backend to enable synthesis, routing and text-to-SQL.
      </p>
      {notices.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t border-live/20 pt-2">
          {notices.map((notice) => (
            <li key={notice} className="font-mono text-tiny text-live">
              {notice}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchSkeleton() {
  return (
    <section className="panel shadow-card" aria-busy="true" aria-label="Searching">
      <header className="panel-head">
        <span className="eyebrow">Analysis</span>
        <span className="eyebrow">working…</span>
      </header>
      <div className="space-y-2 px-3 py-3">
        {[100, 94, 88, 62].map((width) => (
          <div
            key={width}
            className="h-2.5 animate-pulse rounded-sm bg-rule-soft"
            style={{ width: `${width}%` }}
          />
        ))}
      </div>
    </section>
  );
}

/** Punctuation and spacing differ between the two stores; letters do not. */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
