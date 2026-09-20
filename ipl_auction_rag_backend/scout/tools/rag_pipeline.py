"""
rag_pipeline.py
Where research is stored, and how it survives.

The problem this file exists to solve: `POST /api/v1/ingest` defaults to
`reset=True`, which drops the `ipl_players` Chroma collection and rebuilds the
`players` table from the spreadsheet. Anything the Researcher had written into
either would disappear -- silently, with no error, and only noticeable later
when the advisor stopped knowing about an injury.

So research lives in two places of its own:

    scout_player_updates   a SQLite ledger, one row per observation
    scout_research         a Chroma collection, separate from ipl_players

**The ledger is the durable record; `players` is a projection of it.** Every
scraped figure is appended to `scout_player_updates` with its source, its
timestamp and its confidence, and only then applied to `players`. That ordering
is what makes `replay_research()` possible: after an ingest has rebuilt the
pool from the spreadsheet, the ledger is replayed and the research goes back.
Storing only the final value in `players` would make the rebuild lossy, and
nothing would report the loss.

It also buys two things that are awkward otherwise. Two sources disagreeing
about a strike rate is visible, because both rows are there. And a fact can be
aged out by its `retrieved_at` rather than by guesswork.

**Three rules the writer enforces**, which the schemas cannot enforce alone:

1. Identity is never written. `PlayerStatUpdate` and `PlayerValuation` have no
   field for `player_name`, `role`, `cap_status`, `overseas` or `country`, and
   the column allowlist below is a second lock on the same door.
2. Valuation fills, it does not overwrite. `base_price` and `rating` are set
   only where the column is NULL -- 191 of 284 rows -- because the room reads
   base prices to open a lot and caches the pool at startup.
3. Nothing is written to `players` while an auction is running.
   `api/routes.py` already refuses to refresh the room's pool mid-auction for
   the same reason; this refuses for the same reason, and says so.
"""
from __future__ import annotations

import logging
import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any

from config.settings import get_settings
from scout.schemas.player import (
    PlayerFact,
    PlayerMatch,
    PlayerStatUpdate,
    PlayerUpdate,
    PlayerValuation,
)

logger = logging.getLogger(__name__)

#: The ledger. Append-only: rows are never updated, so a later observation sits
#: beside an earlier one rather than erasing it.
CREATE_LEDGER = """
CREATE TABLE IF NOT EXISTS scout_player_updates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id     INTEGER NOT NULL,
    field         TEXT    NOT NULL,
    value         REAL    NOT NULL,
    kind          TEXT    NOT NULL,          -- 'stat' or 'valuation'
    source_id     TEXT    NOT NULL,
    source_url    TEXT,
    method        TEXT,                      -- 'scrape' or 'search'
    confidence    REAL    NOT NULL DEFAULT 0.5,
    retrieved_at  TEXT    NOT NULL,
    recorded_at   TEXT    NOT NULL
);
"""

CREATE_LEDGER_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_spu_player ON scout_player_updates(player_id);",
    "CREATE INDEX IF NOT EXISTS idx_spu_field  ON scout_player_updates(field);",
    "CREATE INDEX IF NOT EXISTS idx_spu_time   ON scout_player_updates(retrieved_at);",
]

#: Columns the Researcher may write, built from the schemas rather than typed
#: out. A second lock on the identity door: even if someone later adds a
#: `player_name` field to PlayerStatUpdate, it still has to pass this.
_STAT_COLUMNS = frozenset(PlayerStatUpdate.model_fields)
_VALUATION_COLUMNS = frozenset(PlayerValuation.model_fields)
WRITABLE_COLUMNS = _STAT_COLUMNS | _VALUATION_COLUMNS

#: Never writable, whatever a schema says. Listed explicitly so the rule is
#: readable rather than implied by what is absent elsewhere.
SEALED_COLUMNS = frozenset({"id", "player_name", "country", "role", "cap_status", "overseas"})

assert not (WRITABLE_COLUMNS & SEALED_COLUMNS), "a sealed column became writable"

#: Below this, a name match is recorded but not applied. Wrong attribution is
#: worse than no attribution: it writes one player's form onto another's record,
#: where nothing will ever flag it.
MATCH_THRESHOLD = 0.86


# ---------------------------------------------------------------------------
# Name resolution
# ---------------------------------------------------------------------------


def _normalise(name: str) -> str:
    """Casefold, strip accents and punctuation, collapse whitespace."""
    decomposed = unicodedata.normalize("NFKD", name)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9 ]+", " ", stripped.casefold()).strip()


def _initial_form(name: str) -> str:
    """'virat kohli' -> 'v kohli'. What a scorecard usually prints."""
    parts = _normalise(name).split()
    return f"{parts[0][0]} {' '.join(parts[1:])}" if len(parts) > 1 else _normalise(name)


def _initial_and_surname(name: str) -> tuple[str, str]:
    """
    ('a', 'russell') from both 'AD Russell' and 'Andre Russell'.

    Scorecards write every initial a player has -- 'AD Russell', 'RJW Topley',
    'MJ Henry' -- and the pool holds full names. Neither the exact nor the
    single-initial pass bridges that, so 'AD Russell' was scoring 0.48 against
    'Adil Rashid' and being held as ambiguous. Comparing only the FIRST initial
    and the surname bridges it, and stays strict enough that a genuine clash
    (two Sharmas, both R) still ties and is still refused.
    """
    parts = _normalise(name).split()
    if len(parts) < 2:
        return ("", _normalise(name))
    return (parts[0][0], parts[-1])


def _uncomma(name: str) -> str:
    """
    'Kohli, Virat' -> 'Virat Kohli'. 'Kohli, V' -> 'V Kohli'.

    Surname-first is how scorecards, squad lists and most exports write a name,
    and without this it scored 0.52 against the forename-first pool and went
    unresolved -- a whole category of source silently producing nothing.
    Applied before anything else so the other three passes see a normal name.
    """
    if "," not in name:
        return name
    surname, _, rest = name.partition(",")
    return f"{rest.strip()} {surname.strip()}".strip()


@dataclass
class _Candidate:
    player_id: int
    player_name: str
    score: float


def resolve_player(raw_name: str, pool: list[dict[str, Any]]) -> PlayerMatch:
    """
    Map a scraped name onto a row in `players`.

    Four passes, most certain first: exact, normalised, initial-and-surname,
    then fuzzy. The fuzzy pass is the only one that can be wrong in an
    interesting way, so it is also the only one that can be beaten by a tie.

    **A tie is a refusal.** If two players score within 0.02 of each other the
    match is abandoned rather than decided by list order -- this pool has
    players who share surnames, and picking the first one silently attributes a
    career to the wrong person.
    """
    raw_name = raw_name or "?"
    candidate_name = _uncomma(raw_name)
    target = _normalise(candidate_name)
    target_initial = _initial_form(candidate_name)
    target_key = _initial_and_surname(candidate_name)
    if not target:
        return PlayerMatch(raw_name=raw_name or "?", confidence=0.0)

    scored: list[_Candidate] = []
    for row in pool:
        name = str(row.get("player_name") or "")
        norm = _normalise(name)
        if not norm:
            continue
        if norm == target:
            score = 1.0
        elif _initial_form(name) == target_initial or norm == _normalise(target_initial):
            score = 0.90
        elif target_key[1] and _initial_and_surname(name) == target_key:
            # 'AD Russell' -> 'Andre Russell'. Scored just below the single-
            # initial form because it discards more information.
            score = 0.88
        else:
            score = SequenceMatcher(None, target, norm).ratio()
        scored.append(_Candidate(int(row["id"]), name, score))

    if not scored:
        return PlayerMatch(raw_name=raw_name, confidence=0.0)

    scored.sort(key=lambda c: c.score, reverse=True)
    best = scored[0]

    if len(scored) > 1 and (best.score - scored[1].score) < 0.02 and best.score < 1.0:
        logger.info(
            "ambiguous name %r: %s (%.2f) vs %s (%.2f) - holding",
            raw_name, best.player_name, best.score, scored[1].player_name, scored[1].score,
        )
        return PlayerMatch(raw_name=raw_name, confidence=round(best.score, 3))

    if best.score < MATCH_THRESHOLD:
        return PlayerMatch(raw_name=raw_name, confidence=round(best.score, 3))

    return PlayerMatch(
        raw_name=raw_name,
        player_id=best.player_id,
        resolved_name=best.player_name,
        confidence=round(best.score, 3),
    )


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(get_settings().SQLITE_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_schema() -> None:
    """Create the ledger if it is not there. Safe to call repeatedly."""
    with _connect() as conn:
        conn.execute(CREATE_LEDGER)
        for statement in CREATE_LEDGER_INDEXES:
            conn.execute(statement)
    logger.info("scout_player_updates ready")


def auction_is_running() -> tuple[bool, str]:
    """
    Whether a lot is in play, and the room's phase.

    Imported inside the function on purpose: `auction/room.py` builds a
    module-level `AuctionRoom()` at import time, and a pipeline that is merely
    being inspected should not construct one.
    """
    try:
        from auction.room import room

        return room.phase not in ("lobby", "finished"), room.phase
    except Exception as exc:  # noqa: BLE001 - no room is not an auction
        logger.debug("no auction room available (%s); treating as idle", exc)
        return False, "unavailable"


@dataclass
class IngestReport:
    """What one call to `record` actually did."""

    facts_embedded: int = 0
    ledger_rows: int = 0
    players_touched: int = 0
    columns_written: int = 0
    unresolved: list[str] = field(default_factory=list)
    skipped_low_confidence: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"{self.ledger_rows} ledger row(s), {self.columns_written} column(s) on "
            f"{self.players_touched} player(s), {self.facts_embedded} fact(s) embedded"
            + (f", {len(self.unresolved)} unresolved" if self.unresolved else "")
        )


# ---------------------------------------------------------------------------
# The vector side
# ---------------------------------------------------------------------------


def research_collection():
    """
    SCOUT's own Chroma collection.

    Built through a ChromaManager pointed at a different collection name, so it
    shares the BGE embedding model with `ipl_players` and the two are directly
    comparable. `reset_collection()` on the pool does not touch this one --
    which is the entire reason it exists.
    """
    from db.chroma_manager import ChromaManager

    manager = ChromaManager()
    name = get_settings().SCOUT_COLLECTION_NAME
    # Reach past the property, which is hardcoded to COLLECTION_NAME.
    return manager._client.get_or_create_collection(  # noqa: SLF001
        name=name, metadata={"hnsw:space": "cosine"}
    ), manager


def embed_facts(facts: list[tuple[PlayerFact, PlayerMatch]]) -> int:
    """
    Put facts in the research collection.

    Ids are deterministic -- source, player and a hash of the text -- so
    re-scraping the same page updates the same document instead of stacking
    duplicates that all retrieve at once.
    """
    if not facts:
        return 0

    import hashlib

    collection, manager = research_collection()
    texts, metadatas, ids = [], [], []
    for fact, match in facts:
        digest = hashlib.sha1(fact.text.encode("utf-8")).hexdigest()[:12]
        ids.append(f"{fact.source.source_id}:{match.player_id or 'unmatched'}:{digest}")
        texts.append(fact.text)
        metadatas.append({
            "player_id": match.player_id or -1,
            "player_name": match.resolved_name or match.raw_name,
            "kind": fact.kind,
            "source_id": fact.source.source_id,
            "source_url": fact.source.url,
            "method": fact.source.method,
            "confidence": fact.source.confidence,
            "retrieved_at": fact.source.retrieved_at.isoformat(),
            "as_of": fact.as_of.isoformat() if fact.as_of else "",
            # Marks these as research rather than spreadsheet, so a retriever
            # reading both collections can weight and attribute them.
            "from_research": True,
        })

    embeddings = manager._embedding_model.embed_documents(texts)  # noqa: SLF001
    collection.upsert(ids=ids, embeddings=embeddings, documents=texts, metadatas=metadatas)
    logger.info("embedded %d fact(s) into %s", len(ids), get_settings().SCOUT_COLLECTION_NAME)
    return len(ids)


# ---------------------------------------------------------------------------
# The writer
# ---------------------------------------------------------------------------


def _apply_columns(
    conn: sqlite3.Connection, player_id: int, stats: dict[str, Any], valuation: dict[str, Any]
) -> int:
    """
    Write to `players`. Stats overwrite; valuation fills only.

    Column names come from the schemas' own field sets and are checked against
    WRITABLE_COLUMNS before they reach the SQL, so the interpolation below
    cannot carry anything a caller chose.
    """
    written = 0

    for column, value in stats.items():
        if column not in _STAT_COLUMNS:
            continue
        conn.execute(f'UPDATE players SET "{column}" = ? WHERE id = ?', (value, player_id))
        written += 1

    for column, value in valuation.items():
        if column not in _VALUATION_COLUMNS:
            continue
        # Fill, never overwrite -- the WHERE clause is the rule.
        cursor = conn.execute(
            f'UPDATE players SET "{column}" = ? WHERE id = ? AND "{column}" IS NULL',
            (value, player_id),
        )
        written += cursor.rowcount

    return written


def record(updates: list[PlayerUpdate], *, apply_to_players: bool = True) -> IngestReport:
    """
    Store a batch of research: ledger, then `players`, then the vector store.

    `apply_to_players=False` records and embeds without touching the pool --
    which is what a dry run wants, and what the auction guard falls back to.
    """
    report = IngestReport()
    if not updates:
        return report

    ensure_schema()
    running, phase = auction_is_running()
    if running and apply_to_players:
        apply_to_players = False
        report.notes.append(
            f"Auction is {phase}; research was recorded and embedded but not written "
            "to the player pool. Replay it with replay_research() once the auction ends."
        )

    now = datetime.now(timezone.utc).isoformat()
    facts_to_embed: list[tuple[PlayerFact, PlayerMatch]] = []
    touched: set[int] = set()

    with _connect() as conn:
        for update in updates:
            match = update.match

            if match.player_id is None:
                report.unresolved.append(match.raw_name)
                # Facts still go to the vector store: an unattributed note about
                # a player we could not name is still retrievable text, and
                # dropping it loses the scrape entirely.
                facts_to_embed.extend((f, match) for f in update.facts)
                continue

            if match.confidence < MATCH_THRESHOLD:
                report.skipped_low_confidence.append(
                    f"{match.raw_name} -> {match.resolved_name} ({match.confidence:.2f})"
                )
                continue

            stats = update.stats.populated()
            valuation = update.valuation.populated()

            for kind, values in (("stat", stats), ("valuation", valuation)):
                for column, value in values.items():
                    conn.execute(
                        """
                        INSERT INTO scout_player_updates
                          (player_id, field, value, kind, source_id, source_url,
                           method, confidence, retrieved_at, recorded_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (match.player_id, column, float(value), kind,
                         update.source.source_id, update.source.url, update.source.method,
                         update.source.confidence, update.source.retrieved_at.isoformat(), now),
                    )
                    report.ledger_rows += 1

            if apply_to_players and (stats or valuation):
                written = _apply_columns(conn, match.player_id, stats, valuation)
                if written:
                    report.columns_written += written
                    touched.add(match.player_id)

            facts_to_embed.extend((f, match) for f in update.facts)

    report.players_touched = len(touched)
    report.facts_embedded = embed_facts(facts_to_embed)
    return report


def replay_research() -> IngestReport:
    """
    Reapply the ledger to `players`. Call this after an ingest has reset the pool.

    Walks the ledger oldest-first so the most recent observation of a field wins,
    which is the same ordering `record` would have produced had the pool never
    been rebuilt. Valuation rows still only fill -- a rebuilt pool has its
    spreadsheet values back, and research does not get to overrule them.
    """
    report = IngestReport()
    ensure_schema()

    running, phase = auction_is_running()
    if running:
        report.notes.append(f"Auction is {phase}; refusing to rewrite the pool mid-auction.")
        return report

    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT player_id, field, value, kind
              FROM scout_player_updates
             ORDER BY retrieved_at ASC, id ASC
            """
        ).fetchall()

        touched: set[int] = set()
        for row in rows:
            column = row["field"]
            if column not in WRITABLE_COLUMNS:
                continue
            stats = {column: row["value"]} if row["kind"] == "stat" else {}
            valuation = {column: row["value"]} if row["kind"] == "valuation" else {}
            written = _apply_columns(conn, row["player_id"], stats, valuation)
            if written:
                report.columns_written += written
                touched.add(row["player_id"])

        report.ledger_rows = len(rows)
        report.players_touched = len(touched)

    logger.info("replayed research: %s", report.summary())
    return report


def ledger_stats() -> dict[str, Any]:
    """A count of what the ledger holds, for /api/v1/scout/health."""
    ensure_schema()
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) AS rows,
                   COUNT(DISTINCT player_id) AS players,
                   COUNT(DISTINCT source_id) AS sources,
                   MAX(retrieved_at) AS newest
              FROM scout_player_updates
            """
        ).fetchone()
    return dict(row) if row else {}


# ---------------------------------------------------------------------------
# CLI
#
#   python -m scout.tools.rag_pipeline              what the ledger holds
#   python -m scout.tools.rag_pipeline replay       reapply it to the pool
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO, format="%(name)-26s | %(message)s")
    argv = sys.argv[1:]

    if argv and argv[0] == "replay":
        print(replay_research().summary())
        raise SystemExit(0)

    stats = ledger_stats()
    print(f"ledger  : {stats.get('rows', 0)} row(s), {stats.get('players', 0)} player(s), "
          f"{stats.get('sources', 0)} source(s)")
    print(f"newest  : {stats.get('newest') or 'nothing recorded yet'}")
    running, phase = auction_is_running()
    print(f"auction : {phase}{' - writes to the pool are blocked' if running else ''}")
    print(f"writable: {len(WRITABLE_COLUMNS)} columns, {len(SEALED_COLUMNS)} sealed")
