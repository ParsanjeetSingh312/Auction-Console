"""
news.py
The player-news ledger: trades, retentions, releases, injuries, withdrawals --
the things a stats table cannot know.

**Why a ledger and not a web search.** SCOUT no longer searches the web while
answering. Its knowledge comes from what the site ingests, and news is ingested
the same way as everything else: as records. Each record is one event about one
player, and every record carries the credible source it came from
(ESPNcricinfo, Cricbuzz, iplt20.com, BCCI), so SCOUT can cite where a trade or
an injury was reported rather than asserting it from a model's memory.

**Where records come from.**

  1. `data/player_news.json`, the curated file, checked in with the code.
  2. A "News" sheet in the ingest workbook, read on every ingest
     (`load_workbook_sheet`), so whoever runs the ingest can add the week's
     trades in the same spreadsheet as the stats.
  3. `POST /api/v1/scout/news`, for an admin adding one record by hand.

All three end up in the JSON file, which `scout.knowledge.train` embeds into
SCOUT's knowledge collection alongside the IPL statistics.

**A question nobody has a record for gets that answer.** "I have no recorded
trade for Arshdeep Singh" is the honest reply; a model filling the gap from
memory is exactly what the credible-sources rule forbids.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from config.settings import get_settings

logger = logging.getLogger(__name__)

NewsKind = Literal[
    "trade",        # moved between franchises in the trade window
    "retained",     # kept by a franchise before an auction
    "released",     # let go by a franchise
    "signed",       # bought at an auction or signed as a free pick
    "replacement",  # brought in for someone unavailable
    "injury",       # injured; availability doubtful
    "ruled_out",    # confirmed out of a season or part of one
    "withdrawn",    # pulled out himself (national duty, personal reasons)
    "unavailable",  # any other confirmed absence
    "suspension",
    "returned",     # back from injury or absence
    "other",
]

#: Sources the product treats as credible for news (see the project's
#: credible-sources rule). A record from elsewhere is accepted and flagged, not
#: refused -- a franchise's own announcement is credible too.
CREDIBLE_DOMAINS = ("espncricinfo.com", "cricbuzz.com", "iplt20.com", "bcci.tv")

#: Questions about news rather than statistics.
_NEWS_QUESTION = re.compile(
    r"\b(trade[ds]?|trading|traded|transfer(?:red)?|swap(?:ped)?|moved? to|move from|"
    r"join(?:ed|s)?|sign(?:ed|s|ing)?|bought by|sold to|retain(?:ed|s)?|retention|"
    r"releas(?:ed|e)|let go|which (?:team|franchise)|what (?:team|franchise)|"
    r"injur(?:y|ed|ies)|ruled out|miss(?:ed|es|ing)?|absent|absence|unavailab\w*|"
    r"availab\w*|withdr[ae]w\w*|pulled out|replace(?:d|ment)|suspend\w*|ban(?:ned)?|"
    r"fit(?:ness)?|comeback|return(?:ed|s)? from|news|update[ds]?)\b",
    re.IGNORECASE,
)


class NewsItem(BaseModel):
    """One event about one player, with where it was reported."""

    id: str = Field(default="", max_length=80)
    player_name: str = Field(min_length=2, max_length=120)
    #: The pool id when the player is in the auction pool; None when not --
    #: plenty of news is about players who are not in this pool.
    player_id: int | None = Field(default=None, ge=1)
    kind: NewsKind
    #: The IPL season the event affects ("traded before IPL 2027" -> 2027).
    season: int | None = Field(default=None, ge=2008, le=2100)
    from_team: str | None = Field(default=None, max_length=60)
    to_team: str | None = Field(default=None, max_length=60)
    summary: str = Field(min_length=10, max_length=600)
    reported_on: date | None = None
    source_name: str = Field(default="", max_length=80)
    source_url: str = Field(min_length=8, max_length=400)
    added_at: datetime | None = None

    @field_validator("source_url")
    @classmethod
    def _http(cls, value: str) -> str:
        if not re.match(r"https?://", value.strip()):
            raise ValueError("source_url must be an http(s) link to where this was reported")
        return value.strip()

    @property
    def credible(self) -> bool:
        return any(domain in self.source_url for domain in CREDIBLE_DOMAINS)

    def headline(self) -> str:
        """One line a prompt or a card can carry."""
        season = f"IPL {self.season}" if self.season else "IPL"
        if self.kind == "trade" and (self.from_team or self.to_team):
            what = f"traded from {self.from_team or '?'} to {self.to_team or '?'} ahead of {season}"
        elif self.kind in ("retained", "released") and (self.from_team or self.to_team):
            what = f"{self.kind} by {self.from_team or self.to_team} ahead of {season}"
        elif self.kind == "signed" and self.to_team:
            what = f"signed by {self.to_team} for {season}"
        else:
            what = f"{self.kind.replace('_', ' ')} ({season})"
        when = f", reported {self.reported_on:%d %b %Y}" if self.reported_on else ""
        source = self.source_name or _domain(self.source_url)
        return f"{self.player_name}: {what}. {self.summary} [source: {source}{when}]"


def _domain(url: str) -> str:
    match = re.match(r"https?://(?:www\.)?([^/]+)", url or "")
    return match.group(1) if match else "source"


def _key(name: str) -> str:
    return re.sub(r"[^a-z]", "", (name or "").lower())


def _item_id(item: NewsItem) -> str:
    import hashlib

    raw = f"{_key(item.player_name)}|{item.kind}|{item.season}|{item.to_team}|{item.source_url}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# The ledger file
# ---------------------------------------------------------------------------

_lock = threading.Lock()


def news_path() -> Path:
    return Path(get_settings().SCOUT_NEWS_PATH)


def load_news() -> list[NewsItem]:
    """Every record in the ledger. Bad records are skipped and logged."""
    path = news_path()
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - an unreadable ledger reads as empty
        logger.warning("player_news.json unreadable: %s", exc)
        return []
    entries = raw.get("items", []) if isinstance(raw, dict) else raw
    items: list[NewsItem] = []
    for entry in entries or []:
        try:
            items.append(NewsItem.model_validate(entry))
        except Exception as exc:  # noqa: BLE001
            logger.warning("skipped a news record: %s", str(exc)[:160])
    return items


def _save(items: list[NewsItem]) -> None:
    path = news_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "about": (
            "SCOUT's player-news ledger: trades, retentions, releases, injuries and "
            "availability. One record per event, each with the credible source it "
            "was reported in. Read by scout/news.py and embedded by scout/knowledge.py. "
            "Add records with POST /api/v1/scout/news, a 'News' sheet in the ingest "
            "workbook, or by editing this file. Fields: player_name, kind (trade|"
            "retained|released|signed|replacement|injury|ruled_out|withdrawn|"
            "unavailable|suspension|returned|other), season, from_team, to_team, "
            "summary, reported_on (YYYY-MM-DD), source_name, source_url."
        ),
        "items": [item.model_dump(mode="json", exclude_none=True) for item in items],
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _resolve_pool_id(name: str) -> int | None:
    try:
        from db import get_player_db
        from scout.tools.rag_pipeline import MATCH_THRESHOLD, resolve_player

        pool = get_player_db().get_all_players(limit=10_000, offset=0)
        match = resolve_player(name, pool)
        if match.player_id is not None and match.confidence >= MATCH_THRESHOLD:
            return int(match.player_id)
    except Exception as exc:  # noqa: BLE001 - no pool, no id
        logger.debug("pool lookup for %s failed: %s", name, exc)
    return None


def upsert(new: list[NewsItem]) -> tuple[int, int]:
    """Add records, replacing any with the same id. Returns (added, updated)."""
    added = updated = 0
    with _lock:
        items = {item.id or _item_id(item): item for item in load_news()}
        for item in new:
            item = item.model_copy(update={
                "id": item.id or _item_id(item),
                "player_id": item.player_id or _resolve_pool_id(item.player_name),
                "added_at": item.added_at or datetime.now(timezone.utc),
            })
            if item.id in items:
                updated += 1
            else:
                added += 1
            items[item.id] = item
        ordered = sorted(
            items.values(),
            key=lambda i: (i.reported_on or date.min, i.player_name),
            reverse=True,
        )
        _save(ordered)
    return added, updated


def delete(item_id: str) -> bool:
    with _lock:
        items = load_news()
        kept = [i for i in items if i.id != item_id]
        if len(kept) == len(items):
            return False
        _save(kept)
    return True


# ---------------------------------------------------------------------------
# The ingest workbook's News sheet
# ---------------------------------------------------------------------------

#: Column headers accepted for each field, lowercased with spaces stripped.
_COLUMNS: dict[str, tuple[str, ...]] = {
    "player_name": ("player", "playername", "name"),
    "kind": ("kind", "type", "event", "category"),
    "season": ("season", "ipl", "iplseason", "year"),
    "from_team": ("from", "fromteam", "oldteam", "previousteam"),
    "to_team": ("to", "toteam", "newteam", "team"),
    "summary": ("summary", "details", "detail", "description", "note", "notes"),
    "reported_on": ("date", "reportedon", "reported", "datereported"),
    "source_name": ("source", "sourcename", "publisher"),
    "source_url": ("url", "link", "sourceurl", "sourcelink"),
}

_KIND_WORDS = {
    "trade": "trade", "traded": "trade", "transfer": "trade",
    "retain": "retained", "retained": "retained", "retention": "retained",
    "release": "released", "released": "released",
    "sign": "signed", "signed": "signed", "bought": "signed", "auction": "signed",
    "replacement": "replacement", "injury": "injury", "injured": "injury",
    "ruledout": "ruled_out", "out": "ruled_out", "withdrawn": "withdrawn",
    "withdrew": "withdrawn", "unavailable": "unavailable", "suspension": "suspension",
    "suspended": "suspension", "returned": "returned", "return": "returned",
}


def load_workbook_sheet(excel_path: str | None = None) -> tuple[list[NewsItem], list[str]]:
    """
    Records from a sheet named like "News", "Trades" or "Player Updates" in the
    ingest workbook. A workbook without one is the normal case, not an error.
    """
    import pandas as pd

    path = Path(excel_path or get_settings().EXCEL_FILE_PATH)
    notes: list[str] = []
    if not path.exists():
        return [], notes
    try:
        sheets = pd.ExcelFile(path).sheet_names
    except Exception as exc:  # noqa: BLE001
        return [], [f"Could not open the workbook for news: {type(exc).__name__}"]
    wanted = [s for s in sheets if re.search(r"news|trade|update|availability|injur", s, re.I)]
    if not wanted:
        return [], notes

    items: list[NewsItem] = []
    for sheet in wanted:
        frame = pd.read_excel(path, sheet_name=sheet)
        headers = {re.sub(r"[^a-z]", "", str(c).lower()): c for c in frame.columns}
        mapping = {
            field: next((headers[h] for h in options if h in headers), None)
            for field, options in _COLUMNS.items()
        }
        skipped = 0
        for _, row in frame.iterrows():
            record: dict[str, Any] = {}
            for field, column in mapping.items():
                if column is None:
                    continue
                value = row[column]
                if value is None or (isinstance(value, float) and pd.isna(value)):
                    continue
                record[field] = value
            kind = _KIND_WORDS.get(re.sub(r"[^a-z]", "", str(record.get("kind", "")).lower()), "other")
            record["kind"] = kind
            if "season" in record:
                digits = re.search(r"(20\d\d)", str(record["season"]))
                record["season"] = int(digits.group(1)) if digits else None
            if "reported_on" in record:
                try:
                    record["reported_on"] = pd.to_datetime(record["reported_on"]).date()
                except Exception:  # noqa: BLE001
                    record.pop("reported_on")
            for text_field in ("player_name", "summary", "from_team", "to_team", "source_name", "source_url"):
                if text_field in record:
                    record[text_field] = str(record[text_field]).strip()
            try:
                items.append(NewsItem.model_validate(record))
            except Exception:  # noqa: BLE001 - a row without a source is not news
                skipped += 1
        notes.append(f"News sheet '{sheet}': {len(items)} record(s) read, {skipped} skipped "
                     "(each needs a player, a summary and a source link).")
    return items, notes


# ---------------------------------------------------------------------------
# Answering
# ---------------------------------------------------------------------------


def is_news_question(question: str) -> bool:
    """True when the question is about a trade, a move or a player's availability."""
    return bool(_NEWS_QUESTION.search(question or ""))


def season_in(question: str) -> int | None:
    match = re.search(r"\b(?:ipl\s*)?(20[0-9]{2})\b", question or "", re.IGNORECASE)
    return int(match.group(1)) if match else None


def items_for(names: list[str], ids: list[int], items: list[NewsItem] | None = None) -> list[NewsItem]:
    """Records about any of these players, newest first."""
    items = load_news() if items is None else items
    keys = {_key(n) for n in names if n}
    found = [
        item for item in items
        if (item.player_id is not None and item.player_id in ids) or _key(item.player_name) in keys
    ]
    return sorted(found, key=lambda i: (i.season or 0, i.reported_on or date.min), reverse=True)


def names_in_question(question: str, items: list[NewsItem] | None = None) -> list[str]:
    """
    Players the ledger knows who are named in the question -- including players
    outside the auction pool, which the pool's own name matcher cannot see.
    """
    items = load_news() if items is None else items
    text = (question or "").lower()
    found: list[str] = []
    surnames: dict[str, set[str]] = {}
    for item in items:
        name = item.player_name
        parts = name.split()
        if len(parts) > 1 and len(parts[-1]) >= 4:
            surnames.setdefault(parts[-1].lower(), set()).add(name)
        if re.search(rf"\b{re.escape(name.lower())}\b", text) and name not in found:
            found.append(name)
    if not found:
        for surname, owners in surnames.items():
            if len(owners) == 1 and re.search(rf"\b{re.escape(surname)}\b", text):
                found.extend(owners)
    return found
