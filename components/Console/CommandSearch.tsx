/**
 * CommandSearch.tsx
 * The masthead search — a command palette over the pool, not a RAG call.
 *
 * On auction day this control has one job: get a named player onto the block
 * before the auctioneer finishes saying the name. So it matches locally against
 * the roster already in memory and answers instantly, with ↑/↓ to move and
 * Enter to put the highlighted player up. A round trip to a cross-encoder would
 * be the wrong instrument for that.
 *
 * The RAG engine is one keystroke away rather than absent: the last row of the
 * dropdown hands whatever is typed to POST /api/v1/search and switches to the
 * Scout tab. Typed text is the shared currency between the two search systems —
 * the local one for "who is this", the remote one for "who should I want".
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { moneyTight, ratingLabel, setMeta } from "../../console/format";
import { highlightSegments, runQuery, SEARCH_HINTS } from "../../console/search";
import type { AuctionEngine } from "../../console/useAuctionEngine";
import type { ConsolePlayer } from "../../console/types";

/** Rows in the dropdown. Beyond a dozen the list stops being scannable. */
const MAX_RESULTS = 12;

export default function CommandSearch({
  engine,
  query,
  onQueryChange,
  onPutUp,
  onAskScout,
}: {
  engine: AuctionEngine;
  query: string;
  onQueryChange: (next: string) => void;
  onPutUp: (player: ConsolePlayer) => void;
  /** Send the raw query to the RAG backend and switch to the Scout tab. */
  onAskScout: (query: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { players, recordFor, teams, block, teamById } = engine;

  const hits = useMemo(() => {
    if (!query.trim()) return [];
    return runQuery(players, query, {
      recordFor,
      teams,
      onBlockId: block?.playerId ?? null,
    })
      .slice()
      .sort((a, b) => b.hit.score - a.hit.score || a.player.sno - b.player.sno)
      .slice(0, MAX_RESULTS);
  }, [players, query, recordFor, teams, block]);

  // A new query invalidates the old highlight position.
  useEffect(() => setSelected(0), [query]);

  // "/" focuses the search from anywhere, as long as the user is not already
  // typing into some other field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Clicking anywhere else dismisses the dropdown.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setIsOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setIsOpen(false);
      return;
    }
    if (!isOpen || hits.length === 0) {
      if (event.key === "Enter" && query.trim()) {
        // Nothing matched locally, so the question is probably a scouting one.
        event.preventDefault();
        onAskScout(query);
        setIsOpen(false);
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((index) => (index + 1) % hits.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) => (index - 1 + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = hits[selected];
      if (chosen) {
        onPutUp(chosen.player);
        setIsOpen(false);
      }
    }
  }

  return (
    <div className="searchwrap" ref={wrapRef}>
      <div className="searchbar">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <circle cx="6.8" cy="6.8" r="4.6" />
          <path d="M10.3 10.3 14 14" />
        </svg>

        <input
          ref={inputRef}
          type="search"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search the player pool"
          aria-expanded={isOpen}
          aria-controls="command-results"
          placeholder="Search a player, or filter with role:bowler cap:uncapped sr:>150"
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
        />

        {query && (
          <button
            type="button"
            className="clear"
            title="Clear search"
            aria-label="Clear search"
            onClick={() => {
              onQueryChange("");
              inputRef.current?.focus();
            }}
          >
            ✕
          </button>
        )}
        <kbd>/</kbd>
      </div>

      {isOpen && query.trim() && (
        <div className="results" id="command-results" role="listbox" aria-label="Search results">
          <div className="rhead">
            <span className="eyebrow">
              {hits.length} match{hits.length === 1 ? "" : "es"}
            </span>
            <span className="eyebrow">↑↓ to move · enter to put up</span>
          </div>

          {hits.length > 0 ? (
            hits.map(({ player }, index) => {
              const meta = setMeta(player.set);
              const record = recordFor(player.id);
              const team = teamById(record.teamId);

              return (
                <button
                  key={player.id}
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  className={`res${record.status === "sold" ? " is-gone" : ""}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => {
                    onPutUp(player);
                    setIsOpen(false);
                  }}
                >
                  <span className="rl" style={{ background: meta.rail }} />
                  <span className="rname">
                    {highlightSegments(player, query).map((segment, i) => {
                      const text = segment.match ? <i>{segment.text}</i> : segment.text;
                      return segment.surname ? <b key={i}>{text}</b> : <span key={i}>{text}</span>;
                    })}
                  </span>
                  <span className="rmeta">
                    {player.roleShort} · {player.country ?? (player.overseas ? "Overseas" : "—")} ·{" "}
                    {player.set}
                    {team && (
                      <b style={{ color: team.color }}>
                        {" "}
                        · {team.code} {moneyTight(record.price)}
                      </b>
                    )}
                  </span>
                  <span className="rrating">{ratingLabel(player.rating)}</span>
                </button>
              );
            })
          ) : (
            <div className="empty">
              <b>No player by that name</b>
              Try a surname, a filter like <code>role:wk</code>, or ask the Scout below.
            </div>
          )}

          <div className="hint">
            <span className="eyebrow">Filters</span>
            {SEARCH_HINTS.map((hint) => (
              <code
                key={hint}
                role="button"
                tabIndex={0}
                onClick={() => onQueryChange(query.trim() ? `${query.trim()} ${hint}` : hint)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onQueryChange(query.trim() ? `${query.trim()} ${hint}` : hint);
                  }
                }}
              >
                {hint}
              </code>
            ))}
            <button
              type="button"
              className="mini ml-auto"
              onClick={() => {
                onAskScout(query);
                setIsOpen(false);
              }}
            >
              Ask Scout instead →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
