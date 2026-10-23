"""
player_styles.py
Who bowls pace and who bowls spin; who bats left-handed and who bats right.

**Why this file exists.** Cricsheet's ball-by-ball archive says who bowled each
delivery and who faced it, but not what *kind* of bowler or batter they were.
Strike rate against spin, and economy against left-handers, both need that one
extra fact about the *other* player on every ball.

**Where the facts come from, in order of trust.**

1. `OVERRIDES` below -- hand-checked, and they always win.
2. `data/player_styles.json` -- every answer already obtained, keyed by
   Cricsheet's registry id so two "R Sharma"s never share an entry.
3. The player's own profile on ESPNcricinfo or Cricbuzz, found through the
   search API (which has licensed access to both; neither will serve an
   identified crawler, see `config/sources.yaml`). Both profiles print a fixed
   "Batting Style ... Bowling Style ..." block, so the answer is *parsed* from
   the reference sites' own text rather than inferred.

**Why not a language model.** That was the first version, and on 2026-10-23 it
classified Mustafizur Rahman as a spinner, Karn Sharma as a seamer and nearly
every left-hander as right-handed. A split is only as credible as these labels,
so they come from the references people check a figure against.

**What a lookup must prove before it counts.** A result about someone else is
rejected by name -- searching "Mustafizur Rahman" returns Ziaur Rahman's page
too -- and a vague "Right arm" with no type of delivery decides nothing. A
player neither profile settles stays "unknown", and deliveries involving him are
left out of the split rather than guessed into one. Lookups are spent on the
opponents who faced or bowled the most balls first and capped per run, so the
first refresh covers the bulk of every split and later quarters top up the rest.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Literal

from config.settings import get_settings

logger = logging.getLogger(__name__)

Bowling = Literal["pace", "spin", "none", "unknown"]
Batting = Literal["left", "right", "unknown"]

#: The reference sites a style is read from, in order of preference.
STYLE_DOMAINS = ["espncricinfo.com", "cricbuzz.com"]

#: Lookups in flight at once. Polite to the search API and quick enough that a
#: first run of a few hundred finishes in minutes.
CONCURRENCY = 4

#: Hand-checked corrections, keyed by the Cricsheet scorecard name. These win
#: over the cache and over a lookup.
OVERRIDES: dict[str, dict[str, str]] = {
    "V Kohli": {"bowl": "pace", "bat": "right"},
    "RG Sharma": {"bowl": "spin", "bat": "right"},
    "JJ Bumrah": {"bowl": "pace", "bat": "right"},
    "RA Jadeja": {"bowl": "spin", "bat": "left"},
    "YS Chahal": {"bowl": "spin", "bat": "right"},
    "Rashid Khan": {"bowl": "spin", "bat": "right"},
    "SP Narine": {"bowl": "spin", "bat": "left"},
    "B Kumar": {"bowl": "pace", "bat": "right"},
    "MA Starc": {"bowl": "pace", "bat": "left"},
    "DA Warner": {"bowl": "spin", "bat": "left"},
    "S Dhawan": {"bowl": "spin", "bat": "left"},
    "RR Pant": {"bowl": "none", "bat": "left"},
    "MS Dhoni": {"bowl": "pace", "bat": "right"},
    "AD Russell": {"bowl": "pace", "bat": "right"},
    "KH Pandya": {"bowl": "spin", "bat": "left"},
    "HH Pandya": {"bowl": "pace", "bat": "right"},
    "Kuldeep Yadav": {"bowl": "spin", "bat": "left"},
    "AR Patel": {"bowl": "spin", "bat": "left"},
    "TA Boult": {"bowl": "pace", "bat": "right"},
    "Arshdeep Singh": {"bowl": "pace", "bat": "left"},
}

_SPIN = re.compile(r"break|spin|orthodox|googly|chinaman|wrist|slow left", re.I)
_PACE = re.compile(r"fast|medium|seam", re.I)
_BAT = re.compile(r"batting style\W*(left|right)", re.I)
_BOWL = re.compile(r"bowling style\W*(.{0,40})", re.I)


class SearchUnavailable(RuntimeError):
    """The search API refused or failed -- a quota, a key, the network.

    Distinct from "searched and found no profile": that answer is cached, this
    one is not, so a player is never parked as unknown for a quarter because
    the search plan ran out halfway through a run.
    """


@dataclass(frozen=True)
class Style:
    bowl: Bowling = "unknown"
    bat: Batting = "unknown"


@dataclass(frozen=True)
class Person:
    """One identity from the archive, with enough context to find its profile."""

    key: str
    """Cricsheet registry id, or the scorecard name when the match had none."""
    name: str
    """The scorecard name, e.g. "RE van der Merwe"."""
    full_name: str | None = None
    """The pool's full name when this identity is a pool player."""
    teams: tuple[str, ...] = ()
    weight: int = 0
    """Deliveries this person contributes to pool players' splits."""


_lock = threading.Lock()


def cache_path() -> Path:
    return Path(get_settings().PROJECT_ROOT) / "data" / "player_styles.json"


def _load_cache() -> dict[str, dict[str, Any]]:
    path = cache_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("people", {}) if isinstance(data, dict) else {}
    except Exception as exc:  # noqa: BLE001 - a corrupt cache is rebuilt, not fatal
        logger.warning("player_styles.json unreadable (%s); starting empty", exc)
        return {}


def _save_cache(people: dict[str, dict[str, Any]]) -> None:
    path = cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "description": (
            "Bowling type and batting hand per Cricsheet identity, read from "
            "ESPNcricinfo / Cricbuzz profiles. Used for the pace/spin and LHB/RHB "
            "splits. Written by scout/tools/player_styles.py."
        ),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "people": people,
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=1, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _norm(text: str) -> list[str]:
    decomposed = unicodedata.normalize("NFKD", text or "")
    plain = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"[^a-z ]+", " ", plain.casefold()).split()


def same_person(scorecard: str, title: str) -> bool:
    """
    Whether a profile page's title is about this scorecard name.

    The surname must appear in the title's name, and the scorecard's first
    initial must start one of the title's names. "RE van der Merwe" accepts
    "Roelof van der Merwe" and refuses "Stuart van der Merwe"; "CV Varun"
    accepts "Varun Chakaravarthy"; "Mustafizur Rahman" refuses "Ziaur Rahman".
    """
    name_part = re.split(r"\s+(?:profile|-|\|)", title or "", maxsplit=1, flags=re.I)[0]
    have = _norm(name_part)
    want = _norm(scorecard)
    if not have or not want:
        return False
    if have == want:
        return True
    return want[-1] in have and want[0][0] in {token[0] for token in have}


def parse_profile(text: str) -> Style:
    """Bowling type and batting hand from a profile's style block."""
    flat = " ".join((text or "").split())
    bat: Batting = "unknown"
    bowl: Bowling = "unknown"
    found = _BAT.search(flat)
    if found:
        bat = "left" if found.group(1).lower() == "left" else "right"
    found = _BOWL.search(flat)
    if found:
        kind = found.group(1)
        # Spin is checked first: "slow left-arm orthodox" must not read as pace
        # because a later word on the page happens to be "medium".
        if _SPIN.search(kind):
            bowl = "spin"
        elif _PACE.search(kind):
            bowl = "pace"
    return Style(bowl=bowl, bat=bat)


async def lookup(person: Person) -> tuple[Style, str | None]:
    """One search, every matching profile read, the first decisive answer per field."""
    from scout.tools.search_engine import web_search

    name = person.full_name or person.name
    team = person.teams[0] if person.teams else "IPL"
    refs, notes = await web_search(
        f"{name} {team} cricketer profile batting style bowling style",
        max_results=4,
        include_domains=STYLE_DOMAINS,
    )
    if not refs and any("returned" in n or "failed" in n or "unavailable" in n for n in notes):
        raise SearchUnavailable("; ".join(notes)[:200])
    bowl: Bowling = "unknown"
    bat: Batting = "unknown"
    source = None
    for ref in refs:
        title = ref.player_name or ""
        if not (same_person(person.name, title) or (person.full_name and same_person(person.full_name, title))):
            continue
        style = parse_profile(ref.text or "")
        if bowl == "unknown" and style.bowl != "unknown":
            bowl, source = style.bowl, source or title
        if bat == "unknown" and style.bat != "unknown":
            bat, source = style.bat, source or title
        if bowl != "unknown" and bat != "unknown":
            break
    return Style(bowl=bowl, bat=bat), source


def resolve_styles(
    people: Iterable[Person], *, look_up: bool = True, limit: int | None = None
) -> tuple[dict[str, Style], list[str], int]:
    """
    A style for every person: overrides, then cache, then the reference sites.

    Returns styles keyed by `Person.key`, notes for the refresh report, and how
    many people are still waiting for a lookup (cap reached or search refused).
    Never raises: a search that is down leaves the unlooked-up as "unknown",
    which narrows the splits rather than stopping the refresh. Synchronous, and
    meant to run on a worker thread -- it drives its own event loop for the
    lookups.
    """
    from scout.tools.search_engine import search_available

    notes: list[str] = []
    people = list(people)
    settings = get_settings()
    limit = settings.STATS_STYLE_LOOKUPS_PER_RUN if limit is None else limit
    retry_after = timedelta(days=settings.STATS_REFRESH_DAYS * 0.9)
    now = datetime.now(timezone.utc)
    with _lock:
        cache = _load_cache()

    styles: dict[str, Style] = {}
    missing: list[Person] = []
    for person in people:
        override = OVERRIDES.get(person.name)
        if override:
            styles[person.key] = Style(override["bowl"], override["bat"])  # type: ignore[arg-type]
            continue
        cached = cache.get(person.key)
        if cached:
            style = Style(cached.get("bowl", "unknown"), cached.get("bat", "unknown"))
            styles[person.key] = style
            # An inconclusive lookup is tried again once it is a quarter old;
            # a profile may have filled in, or a better page may now rank.
            stale = False
            if style.bowl == "unknown" or style.bat == "unknown":
                try:
                    stale = now - datetime.fromisoformat(cached.get("checked_at", "")) > retry_after
                except ValueError:
                    stale = True
            if not stale:
                continue
        missing.append(person)

    if missing and look_up:
        if not search_available():
            notes.append(
                f"{len(missing)} player(s) have no known bowling type or batting hand "
                "and web search is not configured; their deliveries are left out of "
                "the pace/spin and LHB/RHB splits."
            )
        else:
            missing.sort(key=lambda p: p.weight, reverse=True)
            batch = missing[:limit]

            refused: list[str] = []

            async def run_all() -> list[tuple[Person, Style, str | None]]:
                gate = asyncio.Semaphore(CONCURRENCY)
                stop = asyncio.Event()

                async def one(person: Person) -> tuple[Person, Style, str | None] | None:
                    async with gate:
                        if stop.is_set():
                            return None
                        try:
                            style, source = await lookup(person)
                        except SearchUnavailable as exc:
                            # Out of search, not out of luck: stop spending,
                            # and cache nothing for this person.
                            stop.set()
                            refused.append(str(exc))
                            return None
                        except Exception as exc:  # noqa: BLE001 - one failed lookup
                            logger.debug("style lookup failed for %s: %s", person.name, exc)
                            return None
                        return person, style, source

                done = await asyncio.gather(*(one(p) for p in batch))
                return [r for r in done if r is not None]

            results = asyncio.run(run_all())
            stamp = now.isoformat()
            settled = 0
            for person, style, source in results:
                styles[person.key] = style
                cache[person.key] = {
                    "name": person.name,
                    "full_name": person.full_name,
                    "bowl": style.bowl,
                    "bat": style.bat,
                    "source": source,
                    "checked_at": stamp,
                }
                settled += style.bowl != "unknown" or style.bat != "unknown"
            with _lock:
                _save_cache(cache)
            notes.append(
                f"Read playing styles from ESPNcricinfo / Cricbuzz profiles for "
                f"{settled} of {len(results)} player(s) looked up."
            )
            if refused:
                notes.append(
                    f"Web search stopped after {len(results)} lookup(s): {refused[0]}. "
                    f"The other {len(missing) - len(results)} player(s) will be looked "
                    "up on the next refresh."
                )
            elif len(missing) > len(batch):
                notes.append(
                    f"{len(missing) - len(batch)} lower-volume player(s) left for the "
                    "next refresh (lookup cap per run)."
                )

    looked_up = {person.key for person in people if person.key in cache or person.name in OVERRIDES}
    pending = sum(1 for person in people if person.key not in looked_up)
    for person in people:
        styles.setdefault(person.key, Style())
    return styles, notes, pending
