"""
search_engine.py
Finding candidates: structured filtering, semantic retrieval, and the web.

Three sources, and they answer different questions.

**Constraints go straight to SQL, with no model in the way.** `/api/v1/search`
has to send a sentence to a language model and hope for valid SQL back -- and
this afternoon that model spent 248 of its 300 tokens reasoning and returned a
statement truncated mid-expression. The advisor does not have that problem,
because `Constraints` is already structured: "All-Rounder under 15 Cr with SR
above 140" arrives as fields, not as prose. Building a parameterised query from
validated fields is deterministic, costs nothing, and cannot be truncated.

**Semantic retrieval reads both collections.** `ipl_players` holds one synthetic
summary per player from the spreadsheet; `scout_research` holds what the
Researcher scraped. Querying only the first makes fresh research invisible to
the advisor, which would make the whole acquisition pipeline pointless. Results
carry `from_research`, so the advisor can weight them and say which it used.

**Reranking is off by default here, and that is a deliberate trade.** The
cross-encoder improves ordering and costs 13.7 seconds per query on CPU --
measured, against 0.08s without it. The auction opens a lot for seven seconds.
An advisor that reranks is an advisor that answers after the hammer, so the
caller opts in when there is time rather than opting out when there is not.

**Web search is the primary path for prose, not a fallback.** Three of the four
configured sources refuse an identified crawler, so form, injury and
availability text cannot be fetched directly. A search API has licensed access
we do not. With no key it reports itself unavailable, in the same way a missing
LLM key degrades the RAG chain instead of failing it.
"""
from __future__ import annotations

import asyncio
import logging
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from config.settings import get_settings
from scout.graph.state import RetrievedRef
from scout.schemas.queries import Constraints

logger = logging.getLogger(__name__)

#: Constraint field -> (column, SQL comparison). Every column here is one the
#: schemas already validated against the real table, so nothing in this map can
#: name a column that does not exist.
_NUMERIC_FILTERS: dict[str, tuple[str, str]] = {
    "max_price_lakh": ("base_price", "<="),
    "min_price_lakh": ("base_price", ">="),
    "min_rating": ("rating", ">="),
    "min_bat_sr": ("bat_sr", ">="),
    "min_bat_avg": ("bat_avg", ">="),
    "max_economy": ("economy", "<="),
    "min_wickets": ("wickets", ">="),
    "min_matches": ("matches", ">="),
}

#: How old research may be before the advisor should consider refreshing it.
#: Not a hard rule -- the graph decides, and `SCOUT_MAX_REFRESH_CYCLES` bounds
#: what it may do about it.
STALE_AFTER_DAYS = 7.0


@dataclass
class RetrievalResult:
    """Everything one retrieval pass found, and everything that went wrong."""

    refs: list[RetrievedRef] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    #: The SQL that ran, for the same reason /api/v1/search returns it: a user
    #: who can see the query can see why a name is missing from the answer.
    sql: str | None = None
    matched_by_constraints: int = 0
    research_age_days: float | None = None
    searched_web: bool = False

    @property
    def is_stale(self) -> bool:
        """True when nothing has been researched recently enough to trust."""
        return self.research_age_days is None or self.research_age_days > STALE_AFTER_DAYS


# ---------------------------------------------------------------------------
# Structured filtering
# ---------------------------------------------------------------------------


def constraints_to_sql(c: Constraints) -> tuple[str, list[Any]]:
    """
    A parameterised SELECT from validated constraints.

    Every value is bound, never interpolated, and every column name comes from
    `_NUMERIC_FILTERS` or a literal below -- so there is no path from a user's
    question to the text of this statement. That is the difference between this
    and text-to-SQL, and it is why `validate_select_only` is not needed here.
    """
    where: list[str] = []
    params: list[Any] = []

    if c.role:
        where.append("role = ?")
        params.append(c.role)
    if c.cap_status:
        where.append("cap_status = ?")
        params.append(c.cap_status)
    if c.overseas is not None:
        where.append("overseas = ?")
        params.append(1 if c.overseas else 0)

    for field_name, (column, op) in _NUMERIC_FILTERS.items():
        value = getattr(c, field_name, None)
        if value is None:
            continue

        if field_name == "max_price_lakh":
            # A price CEILING must admit players with no listed base price.
            # 191 of the 284 rows have none, and they are overwhelmingly the
            # uncapped ones -- who start at BASE_PRICE_FLOOR, 30 lakh, and are
            # therefore under any ceiling worth asking about. Excluding them
            # (which `base_price <= ?` does on its own, because NULL <= 1500 is
            # NULL and therefore falsy) hides exactly the cheap players a
            # budget-constrained franchise is looking for.
            where.append(f'("{column}" IS NULL OR "{column}" <= ?)')
        else:
            # Every other filter is a claim about a player we would be asserting
            # without evidence. We cannot say an unrated player clears a rating
            # floor, or that a batter with no recorded strike rate clears 140,
            # so an unknown value fails the test rather than passing it.
            where.append(f'"{column}" IS NOT NULL AND "{column}" {op} ?')

        params.append(value)

    if c.exclude_player_ids:
        placeholders = ",".join("?" * len(c.exclude_player_ids))
        where.append(f"id NOT IN ({placeholders})")
        params.extend(c.exclude_player_ids)

    clause = f" WHERE {' AND '.join(where)}" if where else ""
    # Rating first because it is the pool's own quality signal, then strike
    # rate. NULLs last either way, so an unrated player never leads a shortlist.
    sql = (
        "SELECT id, player_name, country, role, cap_status, overseas, base_price, "
        "rating, matches, total_runs, bat_avg, bat_sr, wickets, economy "
        f"FROM players{clause} "
        "ORDER BY rating IS NULL, rating DESC, bat_sr IS NULL, bat_sr DESC "
        "LIMIT ?"
    )
    params.append(c.limit)
    return sql, params


def _describe(row: dict[str, Any]) -> str:
    """
    A player as a sentence, for a model to read.

    Built from whichever columns are populated rather than a fixed template:
    two thirds of the pool has no rating, and "rating None" in a prompt is worse
    than no mention of rating at all.
    """
    bits = [f"{row['player_name']} ({row['country']}), {row['role']}, {row['cap_status'].lower()}"]
    if row.get("overseas"):
        bits.append("overseas")
    for label, key, unit in (
        ("base price", "base_price", " lakh"), ("rating", "rating", ""),
        ("matches", "matches", ""), ("runs", "total_runs", ""),
        ("batting average", "bat_avg", ""), ("strike rate", "bat_sr", ""),
        ("wickets", "wickets", ""), ("economy", "economy", ""),
    ):
        value = row.get(key)
        if value is not None:
            bits.append(f"{label} {value}{unit}")
    return ". ".join([bits[0], ", ".join(bits[1:])]) + "."


def by_constraints(c: Constraints) -> tuple[list[RetrievedRef], str, int]:
    """Players matching the structured constraints, best first."""
    sql, params = constraints_to_sql(c)
    conn = sqlite3.connect(f"file:{get_settings().SQLITE_DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = [dict(r) for r in conn.execute(sql, params)]
    finally:
        conn.close()

    refs = [
        RetrievedRef(
            player_id=row["id"],
            player_name=row["player_name"],
            text=_describe(row),
            # A structured match is exact, not scored. Saying so is more honest
            # than inventing a similarity number for a WHERE clause.
            score=None,
            scored_by="keyword",
            from_research=False,
        )
        for row in rows
    ]
    return refs, sql, len(rows)


# ---------------------------------------------------------------------------
# Semantic retrieval, across both collections
# ---------------------------------------------------------------------------


def semantic(query: str, *, n_results: int = 8, include_research: bool = True) -> list[RetrievedRef]:
    """
    Vector search over the pool and, optionally, over scraped research.

    One ChromaManager for both, so both are embedded by the same BGE model and
    their distances are directly comparable. Querying a collection that does not
    exist yet is not an error -- it means the Researcher has not run.
    """
    from db.chroma_manager import ChromaManager

    settings = get_settings()
    manager = ChromaManager()
    embedding = manager._embedding_model.embed_query(query)  # noqa: SLF001
    refs: list[RetrievedRef] = []

    targets = [("ipl_players", False)]
    if include_research:
        targets.append((settings.SCOUT_COLLECTION_NAME, True))

    for name, from_research in targets:
        try:
            collection = manager._client.get_collection(name)  # noqa: SLF001
        except Exception:  # noqa: BLE001 - absent collection, not a failure
            if from_research:
                logger.debug("research collection %r not present yet", name)
            continue

        count = collection.count()
        if not count:
            continue

        result = collection.query(query_embeddings=[embedding], n_results=min(n_results, count))
        ids = (result.get("ids") or [[]])[0]
        for i in range(len(ids)):
            meta = (result.get("metadatas") or [[{}]])[0][i] or {}
            distance = (result.get("distances") or [[0.0]])[0][i]
            pid = meta.get("player_id")
            refs.append(RetrievedRef(
                player_id=int(pid) if isinstance(pid, (int, float)) and int(pid) > 0 else None,
                player_name=str(meta.get("player_name") or "Unknown"),
                text=(result.get("documents") or [[""]])[0][i] or "",
                # Cosine distance, so lower is closer. Converted to a similarity
                # because every other score in this file reads "higher is better"
                # and mixing the two conventions in one list invites a sort bug.
                score=round(1.0 - float(distance), 4),
                scored_by="vector",
                from_research=from_research,
            ))

    refs.sort(key=lambda r: r.score or 0.0, reverse=True)
    return refs


def rerank(query: str, refs: list[RetrievedRef], *, top_k: int = 5) -> list[RetrievedRef]:
    """
    Reorder with the cross-encoder. Costs about 13.7 seconds on CPU.

    Kept opt-in and separate rather than folded into `semantic`, so the cost is
    always a decision someone made rather than a default they inherited.
    """
    if not refs:
        return refs
    # The existing loader, rather than a second CrossEncoder: it is lru_cached,
    # so the console's own reranking and SCOUT's share one 2.2 GB model in
    # memory instead of loading it twice.
    from models.reranker_loader import rerank as _rerank_texts

    ranked = _rerank_texts(query, [r.text for r in refs], top_k=top_k)
    # RankedResult carries the index into the list we passed, which is how the
    # score gets back onto the right ref.
    return [
        refs[r.index].model_copy(
            update={"score": round(float(r.score), 4), "scored_by": "reranker"}
        )
        for r in ranked
        if 0 <= r.index < len(refs)
    ]


# ---------------------------------------------------------------------------
# The web
# ---------------------------------------------------------------------------


def search_available() -> bool:
    """Whether a web search could be made at all."""
    return bool((get_settings().TAVILY_API_KEY or "").strip())


async def web_search(query: str, *, max_results: int | None = None,
                     timeout: float = 15.0) -> tuple[list[RetrievedRef], list[str]]:
    """
    Ask a search API, and say plainly when we cannot.

    Returns refs and notes rather than raising: an unavailable search is a
    degraded answer, not a failed request, and the note is what tells a user why
    an injury from yesterday is missing.
    """
    import httpx

    settings = get_settings()
    key = (settings.TAVILY_API_KEY or "").strip()
    if not key:
        return [], ["Web search unavailable: TAVILY_API_KEY is not set."]

    limit = max_results or settings.SCOUT_SEARCH_MAX_RESULTS
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                "https://api.tavily.com/search",
                # The key travels in both places on purpose: Tavily moved from a
                # body field to a bearer header, and sending both works against
                # either generation without pinning this file to one of them.
                headers={"Authorization": f"Bearer {key}"},
                json={"api_key": key, "query": query, "max_results": limit,
                      "search_depth": "basic"},
            )
    except Exception as exc:  # noqa: BLE001
        return [], [f"Web search failed ({type(exc).__name__}); answered without it."]

    if response.status_code != 200:
        detail = response.text[:120].replace("\n", " ")
        return [], [f"Web search returned {response.status_code}: {detail}"]

    refs = [
        RetrievedRef(
            player_id=None,
            player_name=str(item.get("title") or "web result")[:120],
            text=(item.get("content") or "").strip()[:2000],
            score=float(item.get("score") or 0.0),
            scored_by="keyword",
            from_research=True,
        )
        for item in (response.json().get("results") or [])
        if (item.get("content") or "").strip()
    ]
    return refs, ([] if refs else ["Web search returned nothing usable."])


# ---------------------------------------------------------------------------
# Freshness
# ---------------------------------------------------------------------------


def research_age_days() -> float | None:
    """
    How long since anything was researched. None when nothing ever has been.

    Read from the ledger rather than from the vector store, because the ledger
    records when a fact was *retrieved* and the collection only records that a
    document exists.
    """
    from scout.tools.rag_pipeline import ledger_stats

    newest = (ledger_stats() or {}).get("newest")
    if not newest:
        return None
    try:
        when = datetime.fromisoformat(newest)
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return round((datetime.now(timezone.utc) - when).total_seconds() / 86_400, 2)


# ---------------------------------------------------------------------------
# The entry point the advisor calls
# ---------------------------------------------------------------------------


async def retrieve_for(
    question: str,
    constraints: Constraints,
    *,
    use_reranker: bool = False,
    use_web: bool = False,
    semantic_results: int = 8,
) -> RetrievalResult:
    """
    Everything the advisor needs to answer one question.

    Structured constraints first, because an exact match beats a similar one;
    semantic retrieval second, to catch what a WHERE clause cannot express
    ("suits a spin-heavy pitch"); the web only when asked, because it is the
    slowest and the only one that leaves this machine.
    """
    result = RetrievalResult()
    seen: set[tuple[int | None, str]] = set()

    def add(refs: list[RetrievedRef]) -> None:
        for ref in refs:
            # Dedupe on player where we know it, on text where we do not -- the
            # same player can arrive from SQL and from both collections.
            fingerprint = (ref.player_id, "" if ref.player_id else ref.text[:120])
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            result.refs.append(ref)

    if not constraints.is_empty():
        # SQLite is fast enough to be uninteresting, but `semantic` below
        # runs a BGE embedding on CPU and `rerank` runs a cross-encoder for
        # ~14 seconds. Both are pure CPU work with no await in them, so both
        # belong in a thread -- see the note in cricket_advisor.advise.
        refs, sql, matched = await asyncio.to_thread(by_constraints, constraints)
        result.sql = sql
        result.matched_by_constraints = matched
        add(refs)
        if matched == 0:
            result.notes.append(
                "No player satisfies every constraint; falling back to semantic "
                "matches, which may not meet all of them."
            )

    semantic_refs = await asyncio.to_thread(
        semantic, question, n_results=semantic_results
    )
    if use_reranker and semantic_refs:
        semantic_refs = await asyncio.to_thread(rerank, question, semantic_refs)
        result.notes.append("Reranked with the cross-encoder (adds roughly 14s).")
    add(semantic_refs)

    result.research_age_days = await asyncio.to_thread(research_age_days)
    if result.research_age_days is None:
        result.notes.append("No research recorded yet; answering from the spreadsheet alone.")
    elif result.is_stale:
        result.notes.append(
            f"Research is {result.research_age_days:.0f} days old; form and injury "
            "information may be out of date."
        )

    if use_web:
        web_refs, web_notes = await web_search(question)
        result.searched_web = True
        add(web_refs)
        result.notes.extend(web_notes)

    return result


# ---------------------------------------------------------------------------
# CLI
#
#   python -m scout.tools.search_engine "all-rounders above 150 strike rate"
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import asyncio
    import sys

    logging.basicConfig(level=logging.WARNING)
    question = " ".join(sys.argv[1:]) or "explosive finisher who dominates spin"

    demo = Constraints(role="All-Rounder", min_bat_sr=150, limit=5)
    sql, params = constraints_to_sql(demo)
    print(f"question   : {question}")
    print(f"constraints: {[(k, v) for k, v in demo.model_dump().items() if v not in (None, [])]}")
    print(f"\nSQL:\n  {sql}\n  params {params}\n")

    out = asyncio.run(retrieve_for(question, demo, use_web=search_available()))
    print(f"matched by constraints : {out.matched_by_constraints}")
    print(f"research age (days)    : {out.research_age_days}  (stale={out.is_stale})")
    print(f"web search             : {'used' if out.searched_web else 'not used'}")
    for note in out.notes:
        print(f"  ! {note}")
    print(f"\n{len(out.refs)} result(s):")
    for ref in out.refs[:10]:
        tag = "research" if ref.from_research else "pool    "
        score = f"{ref.score:.3f}" if ref.score is not None else "exact"
        print(f"  [{tag}] {score:<7} {ref.scored_by:<9} {ref.player_name[:34]:<34} "
              f"{' '.join(ref.text.split())[:60]}")
