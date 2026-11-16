"""
knowledge.py
How SCOUT is trained: every data ingest becomes knowledge SCOUT retrieves from
and a training brief SCOUT reads before it answers.

**"Training" here means retrieval plus a brief, not new model weights.** The
language model behind SCOUT is a hosted one; what changes after each ingest is
what it is given. Two things are produced, both from IPL statistics only:

  1. **The knowledge collection** -- a Chroma collection (`scout_knowledge`)
     rebuilt in full on every training run, holding:
       * each pool player's IPL record season by season, and the franchises
         they played for, computed from Cricsheet's ball-by-ball IPL archive;
       * each season's champion and its leading run-scorers and wicket-takers;
       * the dataset's own patterns -- what a good strike rate or economy is in
         THIS pool, by role, and who leads each measure;
       * every record in the player-news ledger (scout/news.py);
       * franchise moves and missed seasons the archive itself shows.
     The advisor's semantic search reads it alongside the pool, and the
     researcher node reads the per-player parts of it exactly, by id.

  2. **The training brief** -- a few hundred words that tell the model how this
     dataset works (units, which roles carry which figures, how current it is)
     and what its numbers mean (the bands above). It goes into the advisor's
     system prompt, so a strike rate of 150 is read against this pool's batters
     rather than against the model's memory of some other league.

**When it runs.** After every `POST /api/v1/ingest`, after every career-stats
refresh, on demand from `POST /api/v1/scout/train`, and once at startup when no
knowledge exists yet. Always in the background: it embeds a few hundred
documents on the CPU, which takes tens of seconds, and nobody should wait on it.

**IPL only.** The archive is Cricsheet's `ipl_male_json.zip` and the pool is
the auction pool; nothing from any other competition enters the collection.
"""
from __future__ import annotations

import asyncio
import json
import logging
import statistics
import threading
import time
import zipfile
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config.settings import get_settings

logger = logging.getLogger(__name__)

#: Seasons of per-season detail kept per player. Older seasons survive in the
#: franchise history and in the career totals the pool already holds.
SEASON_LINES = 6

#: How many leaders a season summary names in each category.
LEADERS = 5

#: Below these a percentile band is not worth stating -- a band drawn from
#: three bowlers describes nothing.
MIN_BAND_SAMPLE = 8

_lock = threading.Lock()
_task: asyncio.Task[Any] | None = None
_cache: dict[str, Any] | None = None
_cache_mtime: float = 0.0


def knowledge_path() -> Path:
    return Path(get_settings().SCOUT_KNOWLEDGE_PATH)


def archive_path() -> Path:
    return Path(get_settings().PROJECT_ROOT) / "data" / "raw" / "cricsheet" / "ipl_male_json.zip"


# ---------------------------------------------------------------------------
# Season-by-season figures from the ball-by-ball archive
# ---------------------------------------------------------------------------


def _season_year(info: dict[str, Any]) -> int:
    """
    The IPL season a match belongs to, by the year it was played.

    Not Cricsheet's `season` field: that writes the first IPL as "2007/08" and
    the 2010 season as "2009/10", so reading its first four digits files Kohli's
    debut under a 2007 IPL that never happened.
    """
    dates = info.get("dates") or []
    text = str(dates[0]) if dates else str(info.get("season") or "")
    return int(text[:4]) if text[:4].isdigit() else 0


#: Franchises that changed name, not hands. A player who stayed at Punjab
#: through the 2021 rename did not move, so names are read as today's.
FRANCHISE_RENAMES = {
    "Kings XI Punjab": "Punjab Kings",
    "Delhi Daredevils": "Delhi Capitals",
    "Royal Challengers Bangalore": "Royal Challengers Bengaluru",
    "Rising Pune Supergiants": "Rising Pune Supergiant",
}


def franchise(name: str | None) -> str:
    return FRANCHISE_RENAMES.get(name or "", name or "")


@dataclass
class SeasonLine:
    """One identity in one IPL season."""

    teams: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    matches: int = 0
    runs: int = 0
    balls: int = 0
    outs: int = 0
    fours: int = 0
    sixes: int = 0
    fifties: int = 0
    hundreds: int = 0
    highest: int = 0
    highest_not_out: bool = False
    bowled: int = 0
    conceded: int = 0
    wickets: int = 0
    best_wkts: int = 0
    best_runs: int = 0

    @property
    def team(self) -> str:
        return max(self.teams.items(), key=lambda t: t[1])[0] if self.teams else "?"

    def describe(self, season: int) -> str:
        parts = [f"IPL {season} ({self.team}): {self.matches} match{'es' if self.matches != 1 else ''}"]
        if self.balls:
            sr = self.runs / self.balls * 100
            bat = f"{self.runs} runs off {self.balls} balls, SR {sr:.1f}"
            if self.outs:
                bat += f", avg {self.runs / self.outs:.1f}"
            hs = f"{self.highest}{'*' if self.highest_not_out else ''}"
            bat += f", HS {hs}"
            if self.hundreds or self.fifties:
                bat += f", {self.hundreds}x100 {self.fifties}x50"
            bat += f", {self.fours} fours {self.sixes} sixes"
            parts.append(bat)
        if self.bowled >= 6:
            econ = self.conceded / (self.bowled / 6)
            bowl = f"{self.wickets} wkts in {self.bowled // 6}.{self.bowled % 6} overs, econ {econ:.2f}"
            if self.wickets:
                bowl += f", avg {self.conceded / self.wickets:.1f}, best {self.best_wkts}/{self.best_runs}"
            parts.append(bowl)
        return "; ".join(parts) + "."


@dataclass
class ArchiveRead:
    lines: dict[str, dict[int, SeasonLine]]
    names: dict[str, str]
    champions: dict[int, dict[str, str]]
    newest: int
    last_date: str
    matches: int


_NOT_FACED = ("wides",)
_NOT_BOWLED = ("wides", "noballs")
_NOT_BOWLER_FAULT = ("byes", "legbyes")
_NOT_BOWLER_WICKET = {"run out", "retired hurt", "retired not out", "obstructing the field"}
_NOT_A_DISMISSAL = {"retired hurt", "retired not out"}


def read_archive(archive: Path) -> ArchiveRead:
    """Every identity's IPL figures per season, keyed by Cricsheet registry id."""
    lines: dict[str, dict[int, SeasonLine]] = defaultdict(dict)
    names: dict[str, str] = {}
    name_season: dict[str, int] = {}
    champions: dict[int, dict[str, str]] = {}
    newest, last_date, read = 0, "", 0

    with zipfile.ZipFile(archive) as zf:
        for entry in zf.namelist():
            if not entry.endswith(".json"):
                continue
            try:
                match = json.loads(zf.read(entry))
            except Exception:  # noqa: BLE001 - one bad file is skipped
                continue
            info = match.get("info") or {}
            registry = (info.get("registry") or {}).get("people") or {}
            season = _season_year(info)
            if not season:
                continue
            newest = max(newest, season)
            dates = info.get("dates") or []
            if dates:
                last_date = max(last_date, str(dates[-1]))
            read += 1

            event = info.get("event") or {}
            if str(event.get("stage", "")).lower() == "final":
                winner = franchise((info.get("outcome") or {}).get("winner"))
                teams = [franchise(t) for t in info.get("teams") or []]
                if winner:
                    runner_up = next((t for t in teams if t != winner), "")
                    champions[season] = {"winner": winner, "runner_up": runner_up,
                                         "date": str(dates[-1]) if dates else ""}

            def key_of(name: str) -> str:
                return str(registry.get(name) or name)

            def line(name: str) -> SeasonLine:
                key = key_of(name)
                if season >= name_season.get(key, 0):
                    names[key], name_season[key] = name, season
                held = lines[key].get(season)
                if held is None:
                    held = lines[key][season] = SeasonLine()
                return held

            for team, players in (info.get("players") or {}).items():
                for name in players:
                    entry_line = line(name)
                    entry_line.matches += 1
                    entry_line.teams[franchise(team)] += 1

            innings_runs: dict[str, int] = defaultdict(int)
            innings_out: set[str] = set()
            bowling: dict[str, list[int]] = defaultdict(lambda: [0, 0])  # wkts, runs
            for innings in match.get("innings") or []:
                if innings.get("super_over"):
                    continue
                for over in innings.get("overs") or []:
                    for ball in over.get("deliveries") or []:
                        extras = ball.get("extras") or {}
                        runs = ball.get("runs") or {}
                        batter, bowler = ball.get("batter"), ball.get("bowler")
                        if not batter or not bowler:
                            continue
                        off_bat = int(runs.get("batter", 0) or 0)
                        bat = line(batter)
                        bat.runs += off_bat
                        innings_runs[key_of(batter)] += off_bat
                        if not any(k in extras for k in _NOT_FACED):
                            bat.balls += 1
                        if not runs.get("non_boundary"):
                            bat.fours += off_bat == 4
                            bat.sixes += off_bat == 6
                        bowl = line(bowler)
                        if not any(k in extras for k in _NOT_BOWLED):
                            bowl.bowled += 1
                        conceded = int(runs.get("total", 0) or 0) - sum(
                            int(extras.get(k, 0) or 0) for k in _NOT_BOWLER_FAULT
                        )
                        bowl.conceded += conceded
                        bowling[key_of(bowler)][1] += conceded
                        for wicket in ball.get("wickets") or []:
                            kind = wicket.get("kind", "")
                            out = wicket.get("player_out")
                            if out and kind not in _NOT_A_DISMISSAL:
                                line(out).outs += 1
                                innings_out.add(key_of(out))
                            if kind not in _NOT_BOWLER_WICKET:
                                bowl.wickets += 1
                                bowling[key_of(bowler)][0] += 1

            for key, scored in innings_runs.items():
                held = lines[key][season]
                held.fifties += 50 <= scored < 100
                held.hundreds += scored >= 100
                not_out = key not in innings_out
                if scored > held.highest or (scored == held.highest and not_out):
                    held.highest, held.highest_not_out = scored, not_out
            for key, (wkts, runs_given) in bowling.items():
                held = lines[key][season]
                if (wkts, -runs_given) > (held.best_wkts, -held.best_runs):
                    held.best_wkts, held.best_runs = wkts, runs_given

    return ArchiveRead(dict(lines), names, champions, newest, last_date, read)


def _map_pool(read: ArchiveRead, pool: list[dict[str, Any]]) -> dict[int, str]:
    """Pool id -> registry key, with the same resolver and aliases the refresh uses."""
    from scout.agents.career_stats import Career, _map_to_pool

    careers: dict[str, Career] = {}
    for key, seasons in read.lines.items():
        career = Career(key=key, name=read.names.get(key, key))
        career.matches = sum(s.matches for s in seasons.values())
        career.seasons = set(seasons)
        careers[key] = career
    mapped, _ = _map_to_pool(careers, pool, read.newest)
    return {pid: career.key for pid, career in mapped.items()}


def _season_leaders(read: ArchiveRead, season: int, display: dict[str, str]) -> dict[str, list[str]]:
    rows = [(key, seasons[season]) for key, seasons in read.lines.items() if season in seasons]

    def who(key: str) -> str:
        return display.get(key) or read.names.get(key, key)

    runs = sorted(rows, key=lambda r: (r[1].runs, -r[1].balls), reverse=True)[:LEADERS]
    wkts = sorted(
        [r for r in rows if r[1].bowled],
        key=lambda r: (r[1].wickets, -r[1].conceded), reverse=True,
    )[:LEADERS]
    return {
        "runs": [
            f"{who(k)} ({s.team}) {s.runs} runs, SR {s.runs / s.balls * 100:.1f}" for k, s in runs if s.balls
        ],
        "wickets": [
            f"{who(k)} ({s.team}) {s.wickets} wkts, econ {s.conceded / (s.bowled / 6):.2f}" for k, s in wkts
        ],
    }


# ---------------------------------------------------------------------------
# The dataset's own patterns
# ---------------------------------------------------------------------------

#: (column, label, higher is better, roles it applies to)
_BENCHMARKS: tuple[tuple[str, str, bool, tuple[str, ...]], ...] = (
    ("bat_sr", "career strike rate", True, ("Batter", "Wicket Keeper", "All-Rounder")),
    ("bat_avg", "career batting average", True, ("Batter", "Wicket Keeper", "All-Rounder")),
    ("sr_vs_fast", "strike rate vs pace", True, ("Batter", "Wicket Keeper", "All-Rounder")),
    ("sr_vs_spin", "strike rate vs spin", True, ("Batter", "Wicket Keeper", "All-Rounder")),
    ("economy", "career economy", False, ("Bowler", "All-Rounder")),
    ("bowl_avg", "bowling average", False, ("Bowler", "All-Rounder")),
    ("wickets", "career wickets", True, ("Bowler", "All-Rounder")),
)


def _num(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return None if number != number else number  # NaN check


def dataset_profile(pool: list[dict[str, Any]]) -> dict[str, Any]:
    """What this pool looks like, in numbers the brief can quote."""
    by_role: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for player in pool:
        by_role[str(player.get("role") or "Unknown")].append(player)

    bands: list[dict[str, Any]] = []
    leaders: list[dict[str, Any]] = []
    for column, label, higher, roles in _BENCHMARKS:
        for role in roles:
            rows = [
                (p, _num(p.get(column))) for p in by_role.get(role, [])
                if _num(p.get(column)) is not None and (_num(p.get("matches")) or 0) >= 10
            ]
            values = [v for _, v in rows if v and v > 0]
            if len(values) < MIN_BAND_SAMPLE:
                continue
            q = statistics.quantiles(values, n=4)
            bands.append({
                "role": role, "column": column, "label": label, "higher_is_better": higher,
                "sample": len(values), "p25": round(q[0], 2), "median": round(q[1], 2),
                "p75": round(q[2], 2),
            })
            ranked = sorted([r for r in rows if r[1]], key=lambda r: r[1], reverse=higher)[:LEADERS]
            leaders.append({
                "role": role, "column": column, "label": label,
                "players": [f"{p['player_name']} {v:g}" for p, v in ranked],
            })

    prices = [_num(p.get("base_price")) for p in pool if _num(p.get("base_price"))]
    return {
        "players": len(pool),
        "roles": {role: len(rows) for role, rows in sorted(by_role.items())},
        "overseas": sum(1 for p in pool if int(p.get("overseas") or 0) == 1),
        "uncapped": sum(1 for p in pool if str(p.get("cap_status")) == "UNCAPPED"),
        "with_ipl_record": sum(1 for p in pool if (_num(p.get("matches")) or 0) > 0),
        "base_price_lakh": (
            {"min": min(prices), "median": statistics.median(prices), "max": max(prices)} if prices else None
        ),
        "bands": bands,
        "leaders": leaders,
    }


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------


@dataclass
class Document:
    id: str
    text: str
    meta: dict[str, Any]


def _player_documents(
    pid: int, name: str, seasons: dict[int, SeasonLine], newest: int
) -> tuple[list[Document], dict[str, Any]]:
    """One player's season lines, franchise history and archive-derived events."""
    ordered = sorted(seasons.items(), reverse=True)
    recent = ordered[:SEASON_LINES]
    season_lines = [line.describe(year) for year, line in recent]

    # Franchise history: consecutive seasons at one team collapse to a span.
    spans: list[list[Any]] = []
    for year, line in sorted(seasons.items()):
        if spans and spans[-1][0] == line.team and spans[-1][2] == year - 1:
            spans[-1][2] = year
        else:
            spans.append([line.team, year, year])
    history = [f"{team} {a}" + (f"-{b}" if b != a else "") for team, a, b in spans]

    events: list[str] = []
    played = sorted(seasons)
    for before, after in zip(played, played[1:]):
        if seasons[before].team != seasons[after].team:
            events.append(
                f"{name} moved franchise: {seasons[before].team} in IPL {before}, "
                f"{seasons[after].team} in IPL {after} (archive shows the change; "
                "whether by trade or auction is not recorded in match data)."
            )
        if after - before > 1:
            missed = (f"IPL {before + 1}" if after - before == 2
                      else f"IPL {before + 1}-{after - 1}")
            events.append(
                f"{name} made no appearance in {missed} in the ball-by-ball archive "
                f"(played {before} and {after}); the reason is not in match data."
            )
    if played and played[-1] == newest - 1:
        events.append(
            f"{name} played IPL {newest - 1} but has no IPL {newest} appearance in the "
            "archive; the reason is not in match data."
        )

    docs = [
        Document(
            id=f"player:{pid}:seasons",
            text=f"{name} - IPL season by season (Cricsheet ball-by-ball): " + " ".join(season_lines),
            meta={"player_id": pid, "player_name": name, "kind": "season", "season": recent[0][0] if recent else 0},
        ),
        Document(
            id=f"player:{pid}:franchises",
            text=f"{name} - IPL franchise history: " + "; ".join(history) + ".",
            meta={"player_id": pid, "player_name": name, "kind": "franchise", "season": played[-1] if played else 0},
        ),
    ]
    for index, event in enumerate(events[-4:]):
        docs.append(Document(
            id=f"player:{pid}:event:{index}", text=event,
            meta={"player_id": pid, "player_name": name, "kind": "event", "season": 0},
        ))
    record = {
        "name": name,
        "seasons": season_lines,
        "franchises": history,
        "events": events[-4:],
        "last_season": played[-1] if played else None,
        "last_team": seasons[played[-1]].team if played else None,
    }
    return docs, record


def _brief(profile: dict[str, Any], seasons: dict[str, Any], trained_at: str,
           season_through: int | None, news_count: int) -> str:
    """The training brief: how this dataset works and what its numbers mean."""
    roles = ", ".join(f"{n} {r}s" for r, n in profile.get("roles", {}).items())
    lines = [
        f"SCOUT TRAINING BRIEF - learned from the ingested IPL data (trained {trained_at[:10]}"
        + (f", match data through IPL {season_through}" if season_through else "") + ").",
        "HOW THE DATASET WORKS:",
        f"- Auction pool: {profile.get('players', 0)} players ({roles}); "
        f"{profile.get('overseas', 0)} overseas, {profile.get('uncapped', 0)} uncapped, "
        f"{profile.get('with_ipl_record', 0)} with an IPL record.",
        "- Money is in lakh (100 lakh = 1 crore). Base prices and ratings come from the auction sheet.",
        "- Career figures (runs, SR, average, economy, wickets, pace/spin and left/right-hander splits) "
        "are complete IPL careers from Cricsheet ball-by-ball data. Season lines are per IPL season.",
        "- Bowlers carry bowling figures only; batters and keepers carry batting figures; "
        "all-rounders may carry both. A missing figure means the dataset has none - say so.",
        "- Everything here is IPL only. Never mix in international or other-league numbers.",
        "WHAT GOOD LOOKS LIKE IN THIS POOL (25th / median / 75th percentile, players with 10+ matches):",
    ]
    by_role: dict[str, list[str]] = defaultdict(list)
    for band in profile.get("bands", []):
        arrow = "" if band["higher_is_better"] else ", lower is better"
        by_role[band["role"]].append(
            f"{band['label']} {band['p25']:.4g}/{band['median']:.4g}/{band['p75']:.4g}{arrow}"
        )
    for role, parts in by_role.items():
        lines.append(f"- {role}s: " + "; ".join(parts))
    recent = sorted(seasons.items(), key=lambda kv: int(kv[0]), reverse=True)[:3]
    if recent:
        lines.append("RECENT SEASONS:")
        for year, summary in recent:
            champ = summary.get("champion")
            runs = (summary.get("leaders", {}).get("runs") or ["?"])[0]
            wkts = (summary.get("leaders", {}).get("wickets") or ["?"])[0]
            lines.append(
                f"- IPL {year}: " + (f"champion {champ}; " if champ else "")
                + f"most runs {runs}; most wickets {wkts}."
            )
    lines += [
        f"- Player-news ledger: {news_count} sourced record(s) of trades, retentions, injuries and availability.",
        "HOW TO ANSWER: quote only figures you are given; say whether a figure is a career or a "
        "season figure; judge a number against the bands above; when the data does not hold "
        "something, say that plainly instead of filling it in.",
    ]
    return "\n".join(lines)


def train_sync(*, reason: str = "manual", excel_path: str | None = None) -> dict[str, Any]:
    """One full training run. Blocking: call through `train` or a thread."""
    from db import get_player_db
    from scout import news as news_ledger

    started = time.perf_counter()
    notes: list[str] = []
    settings = get_settings()

    # --- news first: an ingest workbook may carry a News sheet --------------
    sheet_items, sheet_notes = news_ledger.load_workbook_sheet(excel_path)
    notes.extend(sheet_notes)
    if sheet_items:
        added, updated = news_ledger.upsert(sheet_items)
        notes.append(f"News ledger: {added} added, {updated} updated from the workbook.")
    news_items = news_ledger.load_news()

    pool = get_player_db().get_all_players(limit=10_000, offset=0)
    profile = dataset_profile(pool)

    documents: list[Document] = []
    players: dict[str, Any] = {}
    seasons: dict[str, Any] = {}
    season_through: int | None = None
    last_match: str | None = None

    archive = archive_path()
    if archive.exists():
        read = read_archive(archive)
        season_through, last_match = read.newest, read.last_date
        mapping = _map_pool(read, pool)
        names = {int(p["id"]): str(p["player_name"]) for p in pool}
        display = {key: names[pid] for pid, key in mapping.items() if pid in names}
        for pid, key in mapping.items():
            if pid not in names or key not in read.lines:
                continue
            docs, record = _player_documents(pid, names[pid], read.lines[key], read.newest)
            documents.extend(docs)
            players[str(pid)] = record
        for year in sorted({y for s in read.lines.values() for y in s}):
            leaders = _season_leaders(read, year, display)
            champ = read.champions.get(year, {})
            seasons[str(year)] = {
                "champion": champ.get("winner"), "runner_up": champ.get("runner_up"),
                "leaders": leaders,
            }
            text = (
                f"IPL {year} season summary: "
                + (f"champion {champ['winner']} (beat {champ.get('runner_up') or '?'} in the final). "
                   if champ.get("winner") else "")
                + "Most runs: " + "; ".join(leaders["runs"]) + ". "
                + "Most wickets: " + "; ".join(leaders["wickets"]) + "."
            )
            documents.append(Document(f"season:{year}", text, {
                "player_id": -1, "player_name": f"IPL {year}", "kind": "season_summary", "season": year,
            }))
        notes.append(
            f"Read {read.matches} IPL matches through {read.newest}; "
            f"{len(players)} of {len(pool)} pool players have season lines."
        )
    else:
        notes.append("No Cricsheet archive on disk yet; trained on the pool and the news ledger only. "
                     "The next stats refresh downloads it.")

    for band in profile["bands"]:
        documents.append(Document(
            f"insight:band:{band['role']}:{band['column']}",
            f"In this IPL auction pool, {band['role']}s' {band['label']} runs "
            f"{band['p25']:g} (25th pct), {band['median']:g} (median), {band['p75']:g} (75th pct) "
            f"across {band['sample']} players with 10+ matches; "
            + ("higher is better." if band["higher_is_better"] else "lower is better."),
            {"player_id": -1, "player_name": "Pool benchmark", "kind": "insight", "season": 0},
        ))
    for lead in profile["leaders"]:
        documents.append(Document(
            f"insight:lead:{lead['role']}:{lead['column']}",
            f"Best {lead['label']} among {lead['role']}s in the pool (10+ matches): "
            + ", ".join(lead["players"]) + ".",
            {"player_id": -1, "player_name": "Pool leaders", "kind": "insight", "season": 0},
        ))
    for item in news_items:
        documents.append(Document(
            f"news:{item.id}", item.headline(),
            {"player_id": item.player_id or -1, "player_name": item.player_name, "kind": "news",
             "season": item.season or 0, "source_url": item.source_url},
        ))

    trained_at = datetime.now(timezone.utc).isoformat()
    brief = _brief(profile, seasons, trained_at, season_through, len(news_items))

    embedded = 0
    try:
        embedded = _embed(documents)
        notes.append(f"Embedded {embedded} knowledge document(s) into "
                     f"'{settings.SCOUT_KNOWLEDGE_COLLECTION}'.")
    except Exception as exc:  # noqa: BLE001 - exact lookups still work from the file
        logger.warning("Knowledge embedding failed: %s", exc)
        notes.append(f"Embedding failed ({type(exc).__name__}); exact lookups still work.")

    knowledge = {
        "trained_at": trained_at,
        "reason": reason,
        "season_through": season_through,
        "last_match_date": last_match,
        "seconds": round(time.perf_counter() - started, 1),
        "documents": len(documents),
        "embedded": embedded,
        "news_items": len(news_items),
        "brief": brief,
        "profile": profile,
        "seasons": seasons,
        "players": players,
        "notes": notes,
    }
    path = knowledge_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(knowledge, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    logger.info("SCOUT trained (%s): %d documents in %.1fs", reason, len(documents), knowledge["seconds"])
    return status()


def _embed(documents: list[Document]) -> int:
    """Rebuild the knowledge collection from scratch."""
    if not documents:
        return 0
    from db.chroma_manager import ChromaManager

    name = get_settings().SCOUT_KNOWLEDGE_COLLECTION
    manager = ChromaManager()
    try:
        manager._client.delete_collection(name)  # noqa: SLF001
    except Exception:  # noqa: BLE001 - absent on the first run
        pass
    collection = manager._client.get_or_create_collection(  # noqa: SLF001
        name=name, metadata={"hnsw:space": "cosine"}
    )
    batch = 128
    for start in range(0, len(documents), batch):
        chunk = documents[start : start + batch]
        texts = [d.text for d in chunk]
        embeddings = manager._embedding_model.embed_documents(texts)  # noqa: SLF001
        collection.upsert(
            ids=[d.id for d in chunk], embeddings=embeddings, documents=texts,
            metadatas=[{k: v for k, v in d.meta.items() if v is not None} for d in chunk],
        )
    return len(documents)


async def train(*, reason: str = "manual", excel_path: str | None = None) -> dict[str, Any]:
    """Train without blocking the event loop. One run at a time."""
    if not _lock.acquire(blocking=False):
        return {**status(), "state": "running"}
    try:
        return await asyncio.to_thread(train_sync, reason=reason, excel_path=excel_path)
    finally:
        _lock.release()


def start_training(reason: str, *, excel_path: str | None = None) -> bool:
    """Train in the background. False when a run is already going."""
    global _task
    if _lock.locked() or (_task is not None and not _task.done()):
        return False
    _task = asyncio.create_task(train(reason=reason, excel_path=excel_path), name="scout-train")
    return True


# ---------------------------------------------------------------------------
# Reading what was learned
# ---------------------------------------------------------------------------


def load() -> dict[str, Any]:
    """The last training run's output, cached until the file changes."""
    global _cache, _cache_mtime
    path = knowledge_path()
    if not path.exists():
        return {}
    mtime = path.stat().st_mtime
    if _cache is None or mtime != _cache_mtime:
        try:
            _cache = json.loads(path.read_text(encoding="utf-8"))
            _cache_mtime = mtime
        except Exception as exc:  # noqa: BLE001
            logger.warning("scout_knowledge.json unreadable: %s", exc)
            return {}
    return _cache or {}


def status() -> dict[str, Any]:
    data = load()
    return {
        "trained": bool(data),
        "running": _lock.locked(),
        **{k: data.get(k) for k in (
            "trained_at", "reason", "season_through", "last_match_date", "seconds",
            "documents", "embedded", "news_items", "notes",
        )},
        "players_with_seasons": len(data.get("players") or {}),
    }


def training_brief() -> str:
    """The brief for the system prompt. Empty before the first training run."""
    return str(load().get("brief") or "")


def player_record(player_id: int) -> dict[str, Any] | None:
    return (load().get("players") or {}).get(str(player_id))


def season_summary(year: int) -> dict[str, Any] | None:
    return (load().get("seasons") or {}).get(str(year))


def semantic(question: str, *, n_results: int = 6) -> list[tuple[str, dict[str, Any], float]]:
    """Nearest knowledge documents to a question: (text, metadata, similarity)."""
    from db.chroma_manager import ChromaManager

    manager = ChromaManager()
    try:
        collection = manager._client.get_collection(get_settings().SCOUT_KNOWLEDGE_COLLECTION)  # noqa: SLF001
    except Exception:  # noqa: BLE001 - not trained yet
        return []
    count = collection.count()
    if not count:
        return []
    embedding = manager._embedding_model.embed_query(question)  # noqa: SLF001
    result = collection.query(query_embeddings=[embedding], n_results=min(n_results, count))
    out = []
    for i, doc_id in enumerate((result.get("ids") or [[]])[0]):
        meta = (result.get("metadatas") or [[{}]])[0][i] or {}
        distance = (result.get("distances") or [[1.0]])[0][i]
        out.append(((result.get("documents") or [[""]])[0][i] or "", meta, round(1.0 - float(distance), 4)))
    return out


# ---------------------------------------------------------------------------
# CLI
#
#   python -m scout.knowledge          train now and print the brief
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(name)-24s | %(message)s")
    result = train_sync(reason="cli")
    print(json.dumps({k: v for k, v in result.items() if k != "notes"}, indent=2, default=str))
    for note in result.get("notes") or []:
        print("  -", note)
    print()
    print(training_brief())
