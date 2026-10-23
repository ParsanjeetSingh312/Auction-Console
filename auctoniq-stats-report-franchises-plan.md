# AUCTONIQ — Live stats, franchise reports, fictional franchises

**Date:** 2026-10-23
**Order of work:** backend first (A → D), then frontend (E), then verification (F).
**Rule:** one file at a time; each file is finished and checked before the next.

---

## Why the numbers were wrong

The `players` table was loaded once from `IPL AUCTION DATA.xlsx` and never
refreshed. Virat Kohli reads **206 matches / 7,697 runs** everywhere because
that is what the spreadsheet said. The Cricsheet researcher that already exists
only counted the **last three seasons** and never wrote `matches`, the pace /
spin strike rates or the LHB / RHB economies. Five frontend files also carry
hard-coded copies of the spreadsheet figures.

Measured 2026-10-23: Cricsheet's `ipl_male_json.zip` holds 1,243 matches,
2008 → 2026-05-31 (the full IPL 2026 season). Kohli's career from it:
**282 matches, 9,346 runs** — the figure the site should show.

There are two SCOUT paths, and only one of them searched the web:

| Path | Used by | Web search before |
|---|---|---|
| `/api/v1/scout/advise/stream` (LangGraph) | Scout drawer | yes (Tavily, 3 angles) |
| `/api/v1/chat` (RAG chain) | Data room chat | **no** |

Both answered from the stale table, and neither prompt said what today's date
or the data's freshness was.

---

## A. Career-stats refresh (backend)

| # | File | What |
|---|---|---|
| A1 | `scout/tools/player_styles.py` **NEW** | Who bowls pace or spin and who bats left or right. Cached in `data/player_styles.json`, keyed by Cricsheet's registry id. Names it does not know yet are classified in batches by the configured LLM and cached, so each name is asked once. A manual-overrides block wins over the LLM. Coverage is reported, never hidden. |
| A2 | `scout/agents/career_stats.py` **NEW** | Full-career aggregation from the ball-by-ball archive. Batters: matches, runs, average, SR, SR vs pace, SR vs spin, boundary % vs pace and spin. Bowlers: matches, wickets, economy, average, SR, economy vs LHB, economy vs RHB. All-rounders get both. Resolved to the pool by registry id; when two scorecard identities match one pool name, the more recently active one wins. A split needs ≥ 30 classified balls or it is left alone rather than invented. |
| A3 | `scout/stats_refresh.py` **NEW** | Orchestrator: download → aggregate → write through the existing ledger (`rag_pipeline.record`, so a re-ingest replays it) → re-embed the pool in Chroma so SCOUT's semantic search reads the new numbers → refresh every auction room's pool → write `data/stats_status.json` (refreshed at, season through, players updated, split coverage, next due). Refuses to write mid-auction. |
| A4 | `config/settings.py` | `STATS_REFRESH_ENABLED` (on), `STATS_REFRESH_DAYS` (90), `STATS_REFRESH_CHECK_HOURS` (6). |
| A5 | `api/main.py` | Quarterly scheduler in the lifespan: checks every 6 h and runs the refresh when it is 90+ days old and no auction is live. Also runs on first boot when there has never been a refresh. |
| A6 | `api/routes_stats.py` **NEW** + `api/schemas.py` | `GET /api/v1/stats/status` (public) and `POST /api/v1/stats/refresh` (admin). `/players` responses carry `stats_as_of` and `season_through`. |
| A7 | `ingestion/data_loader.py` | `reembed_pool()`, which rebuilds the vector summaries from the live table rather than the spreadsheet. |

## B. SCOUT answers from current data

| # | File | What |
|---|---|---|
| B1 | `rag/rag_chain.py` | The prompt is built per request: today's date, "statistics are IPL career figures through IPL {season}, refreshed {date}", and a rule never to quote older totals from memory. Chat questions about form, injuries, news, 2026 or a named player get live web context (the same `live_context.gather` the drawer uses), time-boxed. The reply's notes say whether the web was actually searched. |
| B2 | `scout/agents/cricket_advisor.py` | The same freshness line goes into the advisor's context block. |

## C. Fictional franchises (no limit)

| # | File | What |
|---|---|---|
| C1 | `auction/room.py` | Kochi and Pune are removed. The auctioneer can `add_franchise(name, code, colour)` and `remove_franchise(id)` (fictional ones only) while the room is in the lobby or waiting phase. There is no cap. `max_teams` follows the team count. Names and codes must be unique. |
| C2 | `auction/rules.py` | A mini auction opens with the ten IPL sides; extra seats come from fictional franchises the host adds. |
| C3 | `auction/ws.py` | `add_franchise` / `remove_franchise` messages. |

## D. Per-franchise auction report (one PDF per franchise)

Shared sections, the same in every franchise's PDF: **Top bids, Moments,
Ten most expensive signings, Awards nobody asked for** (with Comeback kings).
Every other figure is that franchise's own.

| Page | Contents (from the FCL book, adapted to AUCTONIQ data) |
|---|---|
| 1 Cover | Franchise name and colours. The franchises in the room (names only). Teams · Squad players (own) · Top bid (shared) · Total spend (own). "Organised by AUCTONIQ". No title sponsor. |
| 2 The day in numbers | Players bought · Auction length · % of purse spent · Price bands · Average cost by role · Purse spent vs purse left (own). |
| 3 Moments | First buy, record bid, frenzy quarter-hour, richest quarter-hour, longest silence, unsold round reopens, first full squad, final hammer. **No purse burn-down graph.** |
| 4 Ten most expensive signings | Shared top 10 (no ranks 11–25, no "priciest per year of age"), plus own spend concentration and own most expensive by role. |
| 5 Role mix | Own squad by role. |
| 6 Value for money | All of it, own squad: price-vs-impact scatter, steals (impact per lakh), paid for potential, career leaders, "does experience get paid". |
| 7 Career record | Combined impact points, batting depth, bowling depth (own squad, per player). |
| 8 Awards nobody asked for | Shared. Adapted where AUCTONIQ has no matching data: no age → "most experienced squad" by career matches; no localities → road-warrior awards dropped; "debutant" → uncapped. |
| 9 AUCTONIQ verdict | The existing rating, redrawn in the new style so the document reads as one piece. |

| # | File | What |
|---|---|---|
| D1 | `auction/room.py` | `Record.ts` and `Record.unsold_count`; `started_at` on the room. These are needed for auction length, moments and comebacks, and undo restores them. |
| D2 | `auction/auction_book.py` **NEW** | The analysis. No drawing, so it is testable. |
| D3 | `auction/auction_book_pdf.py` **NEW** | Dark, broadcast-style A4 pages drawn on the reportlab canvas. |
| D4 | `auction/ws.py` | `/report/{team_id}/pdf` returns the new report. |

## E. Frontend (GSAP + Framer Motion)

| # | File | What |
|---|---|---|
| E1 | `console/statsApi.ts` **NEW** | Status fetch, the admin refresh call, and a name → live-stats lookup. |
| E2 | `components/UI/StatsFreshness.tsx` **NEW** | The "IPL career stats through 2026 · refreshed 23 Oct" badge (GSAP pulse on update). Shown in the data room, the Scout drawer and the live block. |
| E3 | `marqueePlayers.ts`, `playerStats.ts`, `players.ts` and their consumers | Hard-coded spreadsheet figures are overlaid with live pool values. |
| E4 | `components/Account/AdminPanel.tsx` | "Refresh player stats now", with status. |
| E5 | `components/Auction/hybrid/…` / `WaitingRoom.tsx` | The auctioneer's "Add fictional franchise" panel (name, code, colour; Framer Motion layout and presence, GSAP entrance). Team colours fall back cleanly for unknown codes. |
| E6 | `components/Auction/PostAuctionReport.tsx` | A "Download your auction report" button per franchise. |

## F. Verification

* Backend tests: the existing suite, plus new tests for the career aggregation, franchise add/remove, and the report analysis.
* A real refresh run: Kohli reads 282 matches / 9,346 runs in `/players`, in SCOUT, and in the room.
* A simulated auction renders a PDF per franchise. The pages are checked by eye.
* Browser check of the badge, the franchise panel and the report download.
