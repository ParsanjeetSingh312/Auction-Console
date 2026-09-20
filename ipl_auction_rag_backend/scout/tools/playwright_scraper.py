"""
playwright_scraper.py
Fetching, for the Data Researcher. Nothing else in SCOUT touches the network
for content.

It reads `config/sources.yaml` and will fetch nothing that is not listed and
enabled there. There are no URLs in this file.

**It reports refusals rather than working around them.** A 403, a Cloudflare
interstitial, a CAPTCHA frame and a robots.txt that disallows the path all end
the same way: a typed `ScrapeOutcome` naming what happened, which the graph
turns into a search fallback. Nothing here rotates a user agent, solves a
challenge, or retries a block from a different angle. That is the project's
stated guardrail, and it is also the only reading of a 403 that is honest.

One consequence, recorded because it looks like a bug otherwise: **a site whose
own robots.txt refuses us is treated as disallowing everything.** ESPNcricinfo,
Cricbuzz and HowSTAT all return 403 for `/robots.txt` itself. We cannot read
their rules, so we cannot claim permission, so we do not fetch. That is stricter
than ignoring an unreadable robots.txt, and it is the only defensible default
when the alternative is deciding for them.

**Two transports, chosen by `kind` in sources.yaml.** Playwright drives a real
browser for `kind: html`, which is what a page needs when its content arrives by
script. A `kind: dataset` is a file -- Cricsheet publishes IPL match data as a
5 MB zip -- and a browser is the wrong tool for a download, so those stream
through httpx. The module is named for the interesting half.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
import urllib.robotparser
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
import yaml

from config.settings import get_settings

logger = logging.getLogger(__name__)


class Refusal(str, Enum):
    """Why a fetch produced nothing. Every one of these is a normal outcome."""

    DISABLED = "disabled"
    ROBOTS = "robots_disallowed"
    #: robots.txt itself could not be read, so permission cannot be established.
    ROBOTS_UNREADABLE = "robots_unreadable"
    #: 403, or a challenge page served with a 200.
    BLOCKED = "blocked"
    TIMEOUT = "timeout"
    HTTP_ERROR = "http_error"
    UNREACHABLE = "unreachable"
    #: Fetched fine and contained nothing worth keeping.
    EMPTY = "empty"
    TOO_LARGE = "too_large"


#: Markers that mean "a challenge, not the page you asked for". Matched against
#: lowercased HTML. Detecting these is the point at which we stop, not the point
#: at which we try something cleverer.
_CHALLENGE_MARKERS = (
    "cf-browser-verification",
    "challenge-platform",
    "just a moment...",
    "attention required!",
    "access denied",
    "please enable javascript and cookies",
    "g-recaptcha",
    "h-captcha",
    "cf-turnstile",
    "captcha-delivery",
    "incapsula",
    "are you a robot",
)

#: Hard ceiling on a downloaded file, whatever sources.yaml says. A dataset that
#: has grown by an order of magnitude is a surprise worth stopping for.
_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024


@dataclass
class ScrapeOutcome:
    """
    One fetch attempt. Always returned; never raised.

    A scraper that raises makes every caller write the same try/except, and the
    graph needs the failure as data anyway -- it is what it puts in `notes` and
    what it routes on. So a refusal is a value.
    """

    source_id: str
    url: str
    ok: bool
    fetched_at: datetime
    elapsed_seconds: float

    refusal: Refusal | None = None
    detail: str = ""

    #: Extracted prose, boilerplate removed. Empty for a dataset.
    text: str = ""
    #: Tables as row dicts, in document order. Empty for a dataset.
    tables: list[list[dict[str, Any]]] = field(default_factory=list)
    #: Where a `kind: dataset` fetch landed on disk.
    path: Path | None = None
    bytes_read: int = 0

    def summary(self) -> str:
        if self.ok:
            what = (
                f"{self.bytes_read:,} bytes -> {self.path.name}"
                if self.path
                else f"{len(self.text):,} chars, {len(self.tables)} table(s)"
            )
            return f"{self.source_id}: ok in {self.elapsed_seconds:.1f}s, {what}"
        return f"{self.source_id}: {self.refusal.value} - {self.detail}"


# ---------------------------------------------------------------------------
# sources.yaml
# ---------------------------------------------------------------------------


def load_sources(path: str | Path | None = None) -> dict[str, Any]:
    """The sources file as written. Raises only if it is unreadable."""
    p = Path(path or get_settings().SCOUT_SOURCES_PATH)
    with p.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def enabled_sources(config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Only the entries this scraper may touch."""
    cfg = config if config is not None else load_sources()
    return [s for s in (cfg.get("sources") or []) if isinstance(s, dict) and s.get("enabled")]


def _setting(source: dict[str, Any], config: dict[str, Any], key: str, fallback: Any) -> Any:
    """A source's own value, else the file default, else the code default."""
    if key in source:
        return source[key]
    return (config.get("defaults") or {}).get(key, fallback)


# ---------------------------------------------------------------------------
# Politeness
# ---------------------------------------------------------------------------

#: Last request time per host, so the delay is per-site rather than global --
#: two different sources should not queue behind each other.
_last_request: dict[str, float] = {}
_delay_lock = asyncio.Lock()


async def _wait_turn(host: str, delay: float) -> None:
    """Hold until `delay` seconds have passed since the last hit on `host`."""
    async with _delay_lock:
        gap = time.monotonic() - _last_request.get(host, 0.0)
        if gap < delay:
            await asyncio.sleep(delay - gap)
        _last_request[host] = time.monotonic()


#: robots.txt per host, parsed once. None means "asked and could not read it".
_robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}


async def _robots_allows(url: str, user_agent: str, timeout: float) -> tuple[bool, str]:
    """
    Whether robots.txt permits `url`.

    An unreadable robots.txt returns False. That is deliberate and is the
    opposite of the usual convention: three of the four candidate sources answer
    403 to their own robots.txt, and treating "they would not tell us" as "they
    said yes" is not a reading anyone would defend out loud.
    """
    parsed = urlparse(url)
    host = f"{parsed.scheme}://{parsed.netloc}"

    if host not in _robots:
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                response = await client.get(f"{host}/robots.txt", headers={"User-Agent": user_agent})
            if response.status_code == 200:
                parser = urllib.robotparser.RobotFileParser()
                parser.parse(response.text.splitlines())
                _robots[host] = parser
            else:
                logger.info("%s/robots.txt returned %s", host, response.status_code)
                _robots[host] = None
        except Exception as exc:  # noqa: BLE001
            logger.info("%s/robots.txt unreachable: %s", host, exc)
            _robots[host] = None

    parser = _robots[host]
    if parser is None:
        return False, "robots.txt could not be read, so permission is not established"
    if not parser.can_fetch(user_agent, url):
        return False, f"robots.txt disallows {urlparse(url).path or '/'} for {user_agent}"
    return True, ""


def looks_like_a_challenge(html: str) -> str | None:
    """The marker that matched, or None. Lowercased substring match, no regex."""
    lowered = html[:20_000].lower()
    for marker in _CHALLENGE_MARKERS:
        if marker in lowered:
            return marker
    return None


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def extract(html: str, url: str) -> tuple[str, list[list[dict[str, Any]]]]:
    """
    Turn markup into prose and tables.

    Both libraries are imported here rather than at module scope: trafilatura
    pulls ten packages and lxml is a compiled extension, and nothing that merely
    reads `ScrapeOutcome` should pay for either.
    """
    text = ""
    try:
        import trafilatura

        text = trafilatura.extract(html, url=url, include_tables=False,
                                   include_comments=False) or ""
    except Exception as exc:  # noqa: BLE001 - extraction is best-effort
        logger.warning("trafilatura failed on %s: %s", url, exc)

    tables: list[list[dict[str, Any]]] = []
    try:
        import pandas as pd
        from io import StringIO

        # `flavor="lxml"` is pinned rather than left to pandas' default. The
        # default tries lxml and then silently retries with bs4 + html5lib,
        # neither of which is a dependency here -- so a genuine lxml parse
        # failure surfaced as "Import html5lib failed", which points at the
        # wrong problem entirely. Pinned, the real error is the one reported.
        for frame in pd.read_html(StringIO(html), flavor="lxml"):
            frame = frame.dropna(how="all").dropna(axis=1, how="all")
            if not frame.empty:
                # Column names arrive as ints or tuples from multi-level headers;
                # the extractor downstream wants strings it can match on.
                frame.columns = [" ".join(map(str, c)).strip() if isinstance(c, tuple)
                                 else str(c) for c in frame.columns]
                tables.append(frame.to_dict(orient="records"))
    except ValueError:
        pass  # pandas raises this when a page simply has no tables
    except Exception as exc:  # noqa: BLE001
        logger.warning("table extraction failed on %s: %s", url, exc)

    return text.strip(), tables


# ---------------------------------------------------------------------------
# The two transports
# ---------------------------------------------------------------------------


def fetch_pages_sync(
    urls: list[str],
    *,
    source_id: str,
    timeout: float,
    user_agent: str,
    headless: bool,
) -> list[ScrapeOutcome]:
    """
    Fetch several pages through one browser. **Synchronous, and deliberately so.**

    Playwright's async API launches its driver with
    `asyncio.create_subprocess_exec`, and on Windows that raises
    NotImplementedError on a SelectorEventLoop -- which is the loop uvicorn runs.
    So the async API works perfectly from a CLI (`asyncio.run` gives you a
    Proactor loop) and fails every time from inside the server, with a traceback
    that points at Playwright rather than at the loop policy. Measured, not
    guessed: `POST /api/v1/scout/research` returned 500 on exactly this.

    The sync API drives its own thread and asks the event loop for nothing, so
    the caller runs this whole function in a worker thread instead. One browser
    for the batch, because launching chromium costs about a second.
    """
    from playwright.sync_api import sync_playwright

    outcomes: list[ScrapeOutcome] = []
    now = datetime.now(timezone.utc)

    def fail(url: str, started: float, refusal: Refusal, detail: str) -> ScrapeOutcome:
        return ScrapeOutcome(source_id=source_id, url=url, ok=False, fetched_at=now,
                             elapsed_seconds=time.perf_counter() - started,
                             refusal=refusal, detail=detail)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=headless)
        try:
            for url in urls:
                started = time.perf_counter()
                try:
                    context = browser.new_context(user_agent=user_agent)
                    page = context.new_page()
                    try:
                        response = page.goto(url, timeout=timeout * 1000,
                                             wait_until="domcontentloaded")
                        status = response.status if response else 0
                        html = page.content()
                    finally:
                        context.close()

                    if status in (401, 403, 429):
                        outcomes.append(fail(url, started, Refusal.BLOCKED,
                                             f"HTTP {status} - the site refused this crawler"))
                        continue
                    if status >= 400:
                        outcomes.append(fail(url, started, Refusal.HTTP_ERROR, f"HTTP {status}"))
                        continue

                    marker = looks_like_a_challenge(html)
                    if marker:
                        # Served with a 200 and still not the page. Reported, not solved.
                        outcomes.append(fail(url, started, Refusal.BLOCKED,
                                             f"anti-bot challenge (matched {marker!r})"))
                        continue

                    text, tables = extract(html, url)
                    if not text and not tables:
                        outcomes.append(fail(url, started, Refusal.EMPTY,
                                             "fetched, but no prose or tables were found"))
                        continue

                    outcomes.append(ScrapeOutcome(
                        source_id=source_id, url=url, ok=True, fetched_at=now,
                        elapsed_seconds=time.perf_counter() - started,
                        text=text, tables=tables, bytes_read=len(html)))

                except Exception as exc:  # noqa: BLE001 - playwright raises a family
                    name = type(exc).__name__
                    if "Timeout" in name:
                        outcomes.append(fail(url, started, Refusal.TIMEOUT,
                                             f"no response within {timeout}s"))
                    else:
                        outcomes.append(fail(url, started, Refusal.UNREACHABLE,
                                             f"{name}: {str(exc).splitlines()[0][:160]}"))
        finally:
            browser.close()

    return outcomes


async def fetch_dataset(
    url: str,
    *,
    source_id: str,
    timeout: float,
    user_agent: str,
    dest_dir: Path,
    max_bytes: int = _MAX_DOWNLOAD_BYTES,
) -> ScrapeOutcome:
    """
    One file, streamed to disk.

    Streamed rather than held in memory because these are archives, and checked
    against `max_bytes` while it streams rather than afterwards -- a cap that
    only applies once the file has landed is not a cap.
    """
    started = time.perf_counter()
    now = datetime.now(timezone.utc)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / Path(urlparse(url).path).name

    def fail(refusal: Refusal, detail: str) -> ScrapeOutcome:
        return ScrapeOutcome(source_id=source_id, url=url, ok=False, fetched_at=now,
                             elapsed_seconds=time.perf_counter() - started,
                             refusal=refusal, detail=detail)

    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            async with client.stream("GET", url, headers={"User-Agent": user_agent}) as response:
                if response.status_code in (401, 403, 429):
                    return fail(Refusal.BLOCKED,
                                f"HTTP {response.status_code} - the site refused this crawler")
                if response.status_code >= 400:
                    return fail(Refusal.HTTP_ERROR, f"HTTP {response.status_code}")

                total = 0
                partial = dest.with_suffix(dest.suffix + ".part")
                with partial.open("wb") as fh:
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > max_bytes:
                            fh.close()
                            partial.unlink(missing_ok=True)
                            return fail(Refusal.TOO_LARGE,
                                        f"exceeded {max_bytes:,} bytes while downloading")
                        fh.write(chunk)
                # Renamed only once complete, so an interrupted download can
                # never be mistaken for a usable archive on the next run.
                partial.replace(dest)

        return ScrapeOutcome(source_id=source_id, url=url, ok=True, fetched_at=now,
                             elapsed_seconds=time.perf_counter() - started,
                             path=dest, bytes_read=total)

    except httpx.TimeoutException:
        return fail(Refusal.TIMEOUT, f"no response within {timeout}s")
    except Exception as exc:  # noqa: BLE001
        return fail(Refusal.UNREACHABLE, f"{type(exc).__name__}: {str(exc)[:160]}")


# ---------------------------------------------------------------------------
# The entry point the Researcher node calls
# ---------------------------------------------------------------------------


async def scrape_source(source_id: str, config: dict[str, Any] | None = None) -> list[ScrapeOutcome]:
    """
    Everything one source offers, obeying its own settings.

    Returns one outcome per URL attempted, successes and refusals together. An
    empty list means the source is not enabled -- which is not an error, and is
    the state three of the four entries are in.
    """
    settings = get_settings()
    cfg = config if config is not None else load_sources()

    source = next((s for s in (cfg.get("sources") or [])
                   if isinstance(s, dict) and s.get("id") == source_id), None)
    if source is None:
        raise KeyError(f"no source {source_id!r} in {settings.SCOUT_SOURCES_PATH}")

    now = datetime.now(timezone.utc)
    if not source.get("enabled"):
        reason = source.get("blocked_measurement") or "disabled in sources.yaml"
        return [ScrapeOutcome(source_id=source_id, url=source.get("base_url", ""), ok=False,
                              fetched_at=now, elapsed_seconds=0.0,
                              refusal=Refusal.DISABLED, detail=reason)]

    timeout = float(_setting(source, cfg, "timeout_seconds", settings.SCOUT_SCRAPE_TIMEOUT))
    # A source may be more polite than the global setting, never less.
    delay = max(float(_setting(source, cfg, "request_delay_seconds", settings.SCOUT_REQUEST_DELAY)),
                settings.SCOUT_REQUEST_DELAY)
    respect_robots = bool(_setting(source, cfg, "respect_robots", settings.SCOUT_RESPECT_ROBOTS))
    max_pages = int(_setting(source, cfg, "max_pages_per_run", 25))
    agent = settings.SCOUT_USER_AGENT

    urls: list[str] = list(source.get("entry_points") or [])
    dataset_url = source.get("dataset_url")
    outcomes: list[ScrapeOutcome] = []

    async def permitted(url: str) -> ScrapeOutcome | None:
        if not respect_robots:
            return None
        allowed, why = await _robots_allows(url, agent, timeout)
        if allowed:
            return None
        refusal = (Refusal.ROBOTS if "disallows" in why else Refusal.ROBOTS_UNREADABLE)
        return ScrapeOutcome(source_id=source_id, url=url, ok=False,
                             fetched_at=datetime.now(timezone.utc),
                             elapsed_seconds=0.0, refusal=refusal, detail=why)

    if dataset_url:
        blocked = await permitted(dataset_url)
        if blocked:
            outcomes.append(blocked)
        else:
            await _wait_turn(urlparse(dataset_url).netloc, delay)
            outcomes.append(await fetch_dataset(
                dataset_url, source_id=source_id, timeout=max(timeout, 120.0),
                user_agent=agent,
                dest_dir=Path(settings.PROJECT_ROOT) / "data" / "raw" / source_id))

    if urls:
        allowed: list[str] = []
        for url in urls[:max_pages]:
            blocked = await permitted(url)
            if blocked:
                outcomes.append(blocked)
                continue
            await _wait_turn(urlparse(url).netloc, delay)
            allowed.append(url)

        if allowed:
            # In a thread, for the loop-policy reason in fetch_pages_sync --
            # and because driving a browser is blocking work either way, and
            # this loop also runs the auction's bid timers.
            outcomes.extend(await asyncio.to_thread(
                fetch_pages_sync, allowed, source_id=source_id, timeout=timeout,
                user_agent=agent, headless=settings.PLAYWRIGHT_HEADLESS))

    return outcomes


async def scrape_all() -> list[ScrapeOutcome]:
    """Every enabled source, one after another rather than in parallel."""
    cfg = load_sources()
    outcomes: list[ScrapeOutcome] = []
    for source in enabled_sources(cfg):
        outcomes.extend(await scrape_source(str(source["id"]), cfg))
    return outcomes


# ---------------------------------------------------------------------------
# CLI
#
#   python -m scout.tools.playwright_scraper              list what is configured
#   python -m scout.tools.playwright_scraper cricsheet    fetch one source
#   python -m scout.tools.playwright_scraper --all        fetch every enabled one
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO, format="%(name)-28s | %(message)s")
    argv = sys.argv[1:]
    settings_ = get_settings()
    cfg_ = load_sources()

    if not argv:
        print(f"sources file: {settings_.SCOUT_SOURCES_PATH}\n")
        for s in cfg_.get("sources") or []:
            mark = "ON " if s.get("enabled") else "off"
            why = s.get("blocked_measurement", "")
            print(f"  [{mark}] {s['id']:<16} {s.get('kind',''):<9} {why[:58]}")
        search = (cfg_.get("search_fallback") or {})
        print(f"\n  search fallback: {'on' if search.get('enabled') else 'off'} "
              f"({search.get('provider', '?')}), "
              f"key {'set' if settings_.TAVILY_API_KEY else 'NOT set'}")
        print("\nusage: python -m scout.tools.playwright_scraper <source_id> | --all")
        raise SystemExit(0)

    results = asyncio.run(scrape_all() if argv[0] == "--all" else scrape_source(argv[0], cfg_))
    print()
    for outcome in results:
        print(" ", outcome.summary())
        if outcome.ok and outcome.text:
            head = " ".join(outcome.text.split())[:220]
            print(f"      text : {head}...")
        if outcome.ok and outcome.tables:
            first = outcome.tables[0]
            print(f"      table: {len(first)} rows, columns {list(first[0])[:6] if first else []}")
    raise SystemExit(0 if any(o.ok for o in results) else 1)
