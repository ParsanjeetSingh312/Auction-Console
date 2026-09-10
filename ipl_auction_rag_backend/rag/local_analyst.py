"""
local_analyst.py
The Scout Agent's no-LLM path: a deterministic analyst that answers from the
player table directly.

Three LLM-dependent stages exist in the pipeline — query routing, text-to-SQL,
and answer synthesis. Routing already has a keyword fallback. This module
supplies the other two, so the agent stays useful with no API key at all:

  * `build_sql`      — parses metric constraints out of plain English and emits
                       a parameterised SELECT. Replaces text-to-SQL.
  * `keyword_search` — ranks players by term overlap against the same profile
                       text the vector store indexes. Replaces retrieval when
                       Chroma is unavailable.
  * `compose`        — writes the answer from the rows themselves: rankings,
                       percentile standing within a role, and the spin/pace
                       splits. Replaces synthesis.

The design rule throughout is that every sentence is derived from a number that
came out of the database. Nothing here estimates, guesses, or fills a gap with
plausible prose — an absent statistic is reported as absent. That is what makes
this a usable substitute for a language model rather than a convincing one: it
says less, but nothing it says is invented.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

from db.sqlite_manager import SQLiteManager

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Metric:
    """One queryable column and the English that refers to it."""

    column: str
    label: str
    #: Phrases that name this metric, longest first so "batting average" wins
    #: over "average".
    phrases: tuple[str, ...]
    #: True when a bigger number is better. Drives ORDER BY for superlatives
    #: and the wording of comparisons.
    higher_is_better: bool
    #: "batting" | "bowling" | "any" — used to disambiguate shared words like
    #: "strike rate" and "average".
    side: str = "any"
    digits: int = 2


METRICS: tuple[Metric, ...] = (
    # Batting
    Metric("bat_sr", "batting strike rate", ("batting strike rate", "bat sr", "bat strike rate"), True, "batting"),
    Metric("bat_avg", "batting average", ("batting average", "bat avg", "batting avg"), True, "batting"),
    Metric("total_runs", "runs", ("total runs", "runs scored", "run scorers", "run scorer", "runs"), True, "batting", 0),
    Metric("sr_vs_spin", "strike rate against spin", ("strike rate vs spin", "sr vs spin", "sr against spin", "strike rate against spin"), True, "batting"),
    Metric("sr_vs_fast", "strike rate against pace", ("strike rate vs pace", "sr vs pace", "sr vs fast", "sr against pace", "strike rate against pace"), True, "batting"),
    Metric("boundary_pct_spin", "boundary % against spin", ("boundary percentage vs spin", "boundary % vs spin", "boundary pct spin"), True, "batting", 1),
    Metric("boundary_pct_fast", "boundary % against pace", ("boundary percentage vs pace", "boundary % vs pace", "boundary pct pace"), True, "batting", 1),
    # Bowling
    Metric("economy", "economy rate", ("economy rate", "economical", "economy", "econ"), False, "bowling"),
    Metric("wickets", "wickets", ("wicket takers", "wicket-takers", "wicket taker", "wickets", "wkts"), True, "bowling", 0),
    Metric("bowl_avg", "bowling average", ("bowling average", "bowl avg", "bowling avg"), False, "bowling"),
    Metric("bowl_sr", "bowling strike rate", ("bowling strike rate", "bowl sr", "bowling sr"), False, "bowling", 1),
    Metric("econ_vs_lhb", "economy against left-handers", ("economy vs lhb", "econ vs lhb", "economy against left", "econ lhb"), False, "bowling"),
    Metric("econ_vs_rhb", "economy against right-handers", ("economy vs rhb", "econ vs rhb", "economy against right", "econ rhb"), False, "bowling"),
    Metric("runs_conceded", "runs conceded", ("runs conceded", "conceded"), False, "bowling", 0),
    # Shared
    Metric("matches", "matches", ("matches", "games", "caps"), True, "any", 0),
    Metric("rating", "rating", ("rating",), True, "any"),
    Metric("base_price", "base price", ("base price", "base"), False, "any", 0),
    # Ambiguous words, resolved by context in `_resolve_metric`.
    Metric("bat_sr", "strike rate", ("strike rate", "sr"), True, "batting"),
    Metric("bat_avg", "average", ("average", "avg"), True, "batting"),
)

ROLES = {
    "Batter": ("batter", "batsman", "batsmen", "batters"),
    "Bowler": ("bowler", "bowlers", "seamer", "pacer", "spinner"),
    "All-Rounder": ("all-rounder", "all rounder", "allrounder", "all-rounders", "all rounders"),
    "Wicket Keeper": ("wicket keeper", "wicketkeeper", "keeper", "keepers", "wk"),
}

#: Comparison words, mapped to SQL operators. Ordered longest-first at use time
#: so "at least" is not shadowed by "least".
OPERATORS: tuple[tuple[str, str], ...] = (
    ("greater than or equal to", ">="),
    ("less than or equal to", "<="),
    ("no more than", "<="),
    ("no less than", ">="),
    ("at least", ">="),
    ("at most", "<="),
    ("greater than", ">"),
    ("more than", ">"),
    ("higher than", ">"),
    ("less than", "<"),
    ("fewer than", "<"),
    ("lower than", "<"),
    ("better than", ">"),
    ("above", ">"),
    ("over", ">"),
    ("below", "<"),
    ("under", "<"),
    ("exceeding", ">"),
    ("beneath", "<"),
    (">=", ">="),
    ("<=", "<="),
    (">", ">"),
    ("<", "<"),
    ("=", "="),
)

SUPERLATIVE_HIGH = ("most", "highest", "best", "top", "leading", "strongest")
SUPERLATIVE_LOW = ("least", "lowest", "cheapest", "most economical", "tightest", "worst")

#: Columns safe to interpolate into SQL. Every column name reaching a query is
#: checked against this set, so a parsed metric can never become injection.
ALLOWED_COLUMNS = {m.column for m in METRICS} | {
    "player_name", "country", "role", "cap_status", "overseas", "id",
}

DEFAULT_LIMIT = 10
MAX_LIMIT = 50


# ---------------------------------------------------------------------------
# Query parsing
# ---------------------------------------------------------------------------


@dataclass
class Constraint:
    """A single parsed filter, e.g. bat_sr > 150."""

    metric: Metric
    operator: str
    value: float

    def describe(self) -> str:
        word = {">": "above", ">=": "at least", "<": "below", "<=": "at most", "=": "exactly"}[
            self.operator
        ]
        return f"{self.metric.label} {word} {_trim(self.value)}"


@dataclass
class ParsedQuery:
    """Everything the parser could recover from the user's sentence."""

    constraints: list[Constraint] = field(default_factory=list)
    role: str | None = None
    cap_status: str | None = None
    overseas: int | None = None
    #: Column to order by, and the direction.
    sort_column: str | None = None
    sort_desc: bool = True
    sort_label: str | None = None
    limit: int = DEFAULT_LIMIT
    #: True when the query asked for players with no top-flight record.
    no_record: bool = False
    #: Player names mentioned that exist in the pool.
    named_players: list[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        """True when nothing structured was recovered — SQL would be pointless."""
        return not (
            self.constraints
            or self.role
            or self.cap_status
            or self.overseas is not None
            or self.sort_column
            or self.no_record
            or self.named_players
        )


def _ordinal(n: int) -> str:
    """1st, 2nd, 3rd, 4th — with the 11-13 exception English insists on."""
    if 11 <= (n % 100) <= 13:
        return f"{n}th"
    return f"{n}{ {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th') }".replace(" ", "")


def _trim(value: float) -> str:
    """Render a number without a trailing .0."""
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


def _bowling_context(text: str) -> bool:
    """Whether the sentence is talking about bowling."""
    return bool(
        re.search(r"\b(bowl\w*|econom\w*|wicket-taking|wickets|seam\w*|spin\w*|pace\w*)\b", text)
    ) and not re.search(r"\b(bat\w*|runs|boundar\w*)\b", text)


def _resolve_metric(phrase: str, text: str) -> Metric | None:
    """
    Find the metric a phrase names.

    "strike rate" and "average" belong to both halves of the sheet, so when the
    surrounding sentence is about bowling they resolve to the bowling column.
    Getting this wrong is not a cosmetic error: `bat_sr > 150` and
    `bowl_sr > 150` select opposite ends of the pool.
    """
    matches = [m for m in METRICS if phrase in m.phrases]
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]
    if _bowling_context(text):
        for candidate in matches:
            if candidate.side == "bowling":
                return candidate
    return matches[0]


def _all_phrases() -> list[tuple[str, Metric]]:
    """Every metric phrase, longest first so specific names win."""
    pairs = [(phrase, metric) for metric in METRICS for phrase in metric.phrases]
    return sorted(pairs, key=lambda p: len(p[0]), reverse=True)


def parse_query(query: str, known_names: list[str] | None = None) -> ParsedQuery:
    """Recover structure from a plain-English question. Never raises."""
    text = query.lower().strip()
    parsed = ParsedQuery()

    # --- role / cap / nationality ---
    for role, words in ROLES.items():
        if any(re.search(rf"\b{re.escape(w)}\b", text) for w in words):
            parsed.role = role
            break

    if re.search(r"\buncapped\b", text):
        parsed.cap_status = "UNCAPPED"
    elif re.search(r"\bcapped\b", text):
        parsed.cap_status = "CAPPED"

    if re.search(r"\b(overseas|foreign|international)\b", text):
        parsed.overseas = 1
    elif re.search(r"\b(indian|india|domestic|local)\b", text):
        parsed.overseas = 0

    if re.search(r"\bno (ipl )?(record|experience|matches)\b|\bnever played\b|\bdebutant", text):
        parsed.no_record = True

    # --- numeric constraints ---
    operator_alternation = "|".join(re.escape(word) for word, _ in OPERATORS)
    operator_lookup = dict(OPERATORS)

    for phrase, _ in _all_phrases():
        escaped = re.escape(phrase)
        # "strike rate above 150" and "above 150 strike rate" both occur.
        forward = rf"{escaped}\s*(?:of|is|at)?\s*({operator_alternation})\s*(\d+(?:\.\d+)?)"
        backward = rf"({operator_alternation})\s*(\d+(?:\.\d+)?)\s*(?:runs?\s+)?{escaped}"

        for pattern in (forward, backward):
            match = re.search(pattern, text)
            if not match:
                continue
            metric = _resolve_metric(phrase, text)
            if metric is None:
                continue
            if any(c.metric.column == metric.column for c in parsed.constraints):
                continue  # already constrained by a more specific phrase
            operator = operator_lookup[match.group(1)]
            parsed.constraints.append(Constraint(metric, operator, float(match.group(2))))
            break

    # --- ordering ---
    for phrase, _ in _all_phrases():
        escaped = re.escape(phrase)
        high = rf"\b({'|'.join(SUPERLATIVE_HIGH)})\s+(?:\d+\s+)?{escaped}"
        low = rf"\b({'|'.join(SUPERLATIVE_LOW)})\s+(?:\d+\s+)?{escaped}"
        metric = _resolve_metric(phrase, text)
        if metric is None:
            continue
        if re.search(high, text):
            parsed.sort_column = metric.column
            # "best economy" means the lowest number, not the highest.
            parsed.sort_desc = metric.higher_is_better
            parsed.sort_label = metric.label
            break
        if re.search(low, text):
            parsed.sort_column = metric.column
            parsed.sort_desc = not metric.higher_is_better
            parsed.sort_label = metric.label
            break

    # A constraint implies what to rank by, when nothing else said so.
    if parsed.sort_column is None and parsed.constraints:
        lead = parsed.constraints[0]
        parsed.sort_column = lead.metric.column
        parsed.sort_desc = lead.operator in (">", ">=")
        parsed.sort_label = lead.metric.label

    # --- limit ---
    limit_match = re.search(r"\b(?:top|best|first)\s+(\d{1,2})\b", text)
    if limit_match:
        parsed.limit = max(1, min(MAX_LIMIT, int(limit_match.group(1))))

    # --- named players ---
    if known_names:
        for name in known_names:
            if name.lower() in text:
                parsed.named_players.append(name)

    return parsed


# ---------------------------------------------------------------------------
# SQL generation
# ---------------------------------------------------------------------------


def build_sql(query: str, known_names: list[str] | None = None) -> dict[str, Any]:
    """
    Deterministic text-to-SQL. Same contract as `text_to_sql.execute_sql_query`.

    Returns {"sql", "results", "error"}. Values are bound as parameters rather
    than interpolated, and column names come only from `ALLOWED_COLUMNS`, so a
    hostile query cannot reach the database as SQL.
    """
    parsed = parse_query(query, known_names)

    if parsed.is_empty:
        return {
            "sql": None,
            "results": [],
            "error": None,
            "parsed": parsed,
        }

    where: list[str] = []
    params: list[Any] = []

    for constraint in parsed.constraints:
        column = constraint.metric.column
        if column not in ALLOWED_COLUMNS:
            continue
        where.append(f"{column} {constraint.operator} ?")
        params.append(constraint.value)

    if parsed.role:
        where.append("role = ?")
        params.append(parsed.role)
    if parsed.cap_status:
        where.append("cap_status = ?")
        params.append(parsed.cap_status)
    if parsed.overseas is not None:
        where.append("overseas = ?")
        params.append(parsed.overseas)
    if parsed.no_record:
        where.append("(matches IS NULL OR matches = 0)")
    if parsed.named_players:
        placeholders = ",".join("?" for _ in parsed.named_players)
        where.append(f"player_name IN ({placeholders})")
        params.extend(parsed.named_players)

    columns = _projection(parsed)
    sql = f"SELECT {', '.join(columns)} FROM players"
    if where:
        sql += " WHERE " + " AND ".join(where)

    if parsed.sort_column and parsed.sort_column in ALLOWED_COLUMNS:
        direction = "DESC" if parsed.sort_desc else "ASC"
        # A NULL is "not recorded", never a best or worst value, so absent
        # figures sort last in both directions.
        sql += (
            f" ORDER BY CASE WHEN {parsed.sort_column} IS NULL THEN 1 ELSE 0 END, "
            f"{parsed.sort_column} {direction}"
        )
    else:
        sql += " ORDER BY player_name ASC"

    sql += " LIMIT ?"
    params.append(parsed.limit)

    try:
        rows = SQLiteManager().execute_query(sql, tuple(params))
    except Exception as exc:  # noqa: BLE001 — surfaced to the caller, not raised
        logger.error("Deterministic SQL failed: %s", exc, exc_info=True)
        return {"sql": sql, "results": [], "error": str(exc), "parsed": parsed}

    return {"sql": sql, "results": rows, "error": None, "parsed": parsed}


def _projection(parsed: ParsedQuery) -> list[str]:
    """
    Choose the columns worth returning.

    Selecting * would hand back the eleven columns that are null for this role,
    so the projection follows the role and whatever the query actually asked
    about.
    """
    columns = ["id", "player_name", "role", "country", "cap_status", "overseas", "base_price", "rating"]

    bowling = parsed.role == "Bowler" or any(
        c.metric.side == "bowling" for c in parsed.constraints
    )
    if bowling:
        columns += ["matches", "wickets", "economy", "bowl_avg", "bowl_sr", "econ_vs_lhb", "econ_vs_rhb"]
    else:
        columns += ["matches", "total_runs", "bat_avg", "bat_sr", "sr_vs_spin", "sr_vs_fast"]

    for constraint in parsed.constraints:
        if constraint.metric.column not in columns:
            columns.append(constraint.metric.column)
    if parsed.sort_column and parsed.sort_column not in columns:
        columns.append(parsed.sort_column)

    return [c for c in columns if c in ALLOWED_COLUMNS]


# ---------------------------------------------------------------------------
# Retrieval fallback
# ---------------------------------------------------------------------------

STOPWORDS = {
    "a", "an", "the", "who", "what", "which", "with", "and", "or", "for", "of",
    "to", "in", "on", "is", "are", "can", "me", "find", "show", "give", "best",
    "good", "player", "players", "someone", "any", "that", "has", "have", "at",
}


def keyword_search(query: str, top_k: int = 8) -> list[dict[str, Any]]:
    """
    Rank players by term overlap against their profile text.

    This is the fallback for when the vector store is unavailable. It is a
    genuinely weaker instrument than embedding search — it matches words, not
    meaning, so "explosive finisher" finds players whose profile happens to use
    those words rather than players who bat like that. It is labelled as such
    everywhere it is used, so a caller never mistakes it for semantic retrieval.
    """
    terms = [
        t for t in re.findall(r"[a-z]{3,}", query.lower()) if t not in STOPWORDS
    ]
    if not terms:
        return []

    try:
        rows = SQLiteManager().execute_query(
            "SELECT id, player_name, role, country, cap_status, overseas, "
            "matches, total_runs, bat_avg, bat_sr, wickets, economy "
            "FROM players"
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("Keyword search failed: %s", exc, exc_info=True)
        return []

    scored: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        haystack = " ".join(
            str(row.get(field_name) or "").lower()
            for field_name in ("player_name", "role", "country", "cap_status")
        )
        hits = sum(1 for term in terms if term in haystack)
        if hits:
            scored.append((hits / len(terms), row))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [
        {**row, "_match_score": round(score, 3)} for score, row in scored[:top_k]
    ]


# ---------------------------------------------------------------------------
# Answer composition
# ---------------------------------------------------------------------------


def _fmt(value: Any, digits: int = 2) -> str:
    """Format a figure, or say plainly that it is absent."""
    if value is None:
        return "not recorded"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    return str(int(round(number))) if digits == 0 else f"{number:.{digits}f}"


def percentile_within_role(column: str, value: float, role: str) -> int | None:
    """
    Where a figure stands among players of the same role, 0-100.

    Comparing a bowler's economy against batters would be meaningless, so the
    peer group is always the role. Returns None when there are too few rated
    peers for a percentile to mean anything.
    """
    if column not in ALLOWED_COLUMNS:
        return None
    try:
        rows = SQLiteManager().execute_query(
            f"SELECT {column} AS v FROM players WHERE role = ? AND {column} IS NOT NULL",
            (role,),
        )
    except Exception:  # noqa: BLE001
        return None

    peers = [float(r["v"]) for r in rows if r["v"] is not None]
    if len(peers) < 8:
        return None

    below = sum(1 for p in peers if p < value)
    return int(round(100 * below / len(peers)))


def compose(
    query: str,
    sql_result: dict[str, Any],
    documents: list[Any] | None = None,
    keyword_rows: list[dict[str, Any]] | None = None,
) -> str:
    """
    Write the answer from the data, with no language model.

    Structure mirrors what an analyst would actually say: what was matched, who
    leads and by how much, then the standing of the top name among its peers.
    """
    parsed: ParsedQuery | None = sql_result.get("parsed")
    rows = sql_result.get("results") or []
    lines: list[str] = []

    # --- what the question was read as ---
    if parsed and not parsed.is_empty:
        criteria: list[str] = []
        if parsed.role:
            criteria.append(parsed.role)
        if parsed.cap_status:
            criteria.append(parsed.cap_status.lower())
        if parsed.overseas is not None:
            criteria.append("overseas" if parsed.overseas else "Indian")
        criteria += [c.describe() for c in parsed.constraints]
        if parsed.no_record:
            criteria.append("no IPL record")
        if criteria:
            lines.append(f"**Read as:** {', '.join(criteria)}.")

    # --- the matched rows ---
    if rows:
        noun = "player" if len(rows) == 1 else "players"
        headline = f"**{len(rows)} {noun}** matched"
        if parsed and parsed.sort_label:
            order = "highest" if parsed.sort_desc else "lowest"
            headline += f", ranked by {order} {parsed.sort_label}"
        lines.append(headline + ".")
        lines.append("")

        for index, row in enumerate(rows, 1):
            lines.append(f"{index}. {_describe_row(row)}")

        leader = rows[0]
        lines.append("")
        lines.append(_standing(leader, parsed))

    elif sql_result.get("error"):
        lines.append(f"The query could not be run: {sql_result['error']}")

    elif parsed and not parsed.is_empty:
        lines.append(
            "**No players match those criteria.** Every filter was applied "
            "against the full pool, so this is a real absence rather than a "
            "retrieval miss — try relaxing the tightest constraint."
        )

    # --- semantic matches, when the vector store answered ---
    if documents:
        lines.append("")
        lines.append(f"**Closest profiles by semantic search** ({len(documents)}):")
        for index, doc in enumerate(documents[:5], 1):
            name = doc.metadata.get("player_name", "Unknown")
            role = doc.metadata.get("role", "")
            score = (
                f" · relevance {doc.rerank_score:.3f}"
                if getattr(doc, "rerank_score", None) is not None
                else ""
            )
            lines.append(f"{index}. **{name}** — {role}{score}")

    elif keyword_rows:
        lines.append("")
        lines.append(
            f"**Closest profiles by keyword match** ({len(keyword_rows)}) — "
            "the vector store is unavailable, so these are term overlaps, not "
            "semantic matches:"
        )
        for index, row in enumerate(keyword_rows[:5], 1):
            lines.append(
                f"{index}. **{row['player_name']}** — {row.get('role', '')}"
            )

    if not lines:
        return (
            "That question could not be turned into a database query, and no "
            "language model is configured to interpret it. Try naming a metric "
            "and a threshold — for example *bowlers with an economy under 8*, "
            "or *uncapped batters with a strike rate above 150*."
        )

    return "\n".join(lines)


def _describe_row(row: dict[str, Any]) -> str:
    """One player, as a line of real figures."""
    name = row.get("player_name", "Unknown")
    bits: list[str] = []

    role = row.get("role")
    if role:
        bits.append(str(role))
    if row.get("cap_status"):
        bits.append(str(row["cap_status"]).lower())
    country = row.get("country")
    if country and country != "Overseas":
        bits.append(str(country))
    elif row.get("overseas"):
        bits.append("overseas")

    stats: list[str] = []
    if row.get("matches") is not None:
        stats.append(f"{_fmt(row['matches'], 0)} matches")

    if role == "Bowler":
        if row.get("wickets") is not None:
            stats.append(f"{_fmt(row['wickets'], 0)} wickets")
        if row.get("economy") is not None:
            stats.append(f"economy {_fmt(row['economy'])}")
        if row.get("bowl_avg") is not None:
            stats.append(f"average {_fmt(row['bowl_avg'])}")
    else:
        if row.get("total_runs") is not None:
            stats.append(f"{_fmt(row['total_runs'], 0)} runs")
        if row.get("bat_avg") is not None:
            stats.append(f"average {_fmt(row['bat_avg'])}")
        if row.get("bat_sr") is not None:
            stats.append(f"strike rate {_fmt(row['bat_sr'])}")

    if row.get("base_price") is not None:
        stats.append(f"base ₹{_fmt(row['base_price'], 0)} L")

    head = f"**{name}**"
    if bits:
        head += f" ({', '.join(bits)})"
    return f"{head} — {', '.join(stats)}" if stats else f"{head} — no figures recorded"


def _standing(row: dict[str, Any], parsed: ParsedQuery | None) -> str:
    """Where the leading player sits among peers in the same role."""
    role = row.get("role")
    name = row.get("player_name", "The leader")
    if not role or not parsed or not parsed.sort_column:
        return ""

    value = row.get(parsed.sort_column)
    if value is None:
        return ""

    rank = percentile_within_role(parsed.sort_column, float(value), str(role))
    if rank is None:
        return (
            f"**{name}** leads on {parsed.sort_label}, though there are too few "
            f"{role.lower()}s with that figure recorded to rank it meaningfully."
        )

    metric = next((m for m in METRICS if m.column == parsed.sort_column), None)
    if metric and not metric.higher_is_better:
        # For economy and averages a low number is good, so the useful phrasing
        # is how many peers they are better than.
        rank = 100 - rank

    return (
        f"**{name}** sits in the **{_ordinal(rank)} percentile** for "
        f"{parsed.sort_label} among {role.lower()}s in this pool."
    )


def known_player_names() -> list[str]:
    """Every name in the pool, for detecting mentions in a question."""
    try:
        rows = SQLiteManager().execute_query("SELECT player_name FROM players")
    except Exception:  # noqa: BLE001
        return []
    return [r["player_name"] for r in rows]
