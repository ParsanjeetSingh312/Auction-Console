# AUCTIQ security suite

An "attack-your-own-app" DAST and red-team suite for the AUCTIQ backend, written
against what the code **actually** does, not the aspirational architecture. It
runs entirely on the Python toolchain already in `.venv` — `pytest`,
`pytest-asyncio`, `httpx`, and Playwright — so it starts the way everything else
in this project starts, with no Node, Docker, or extra installs.

## How to run it

One terminal, from the **repository root** with the venv active (your usual
`(.venv) PS C:\...\Auction-console>` prompt):

```powershell
python -m pytest ipl_auction_rag_backend\security -v
```

You do **not** need the server running — the suite builds its own throwaway app
in-process. It never touches `data/database/ipl_auction.db`: every test seeds a
temporary database with five fake players and points the app at that instead.

Run one phase at a time by marker:

```powershell
python -m pytest ipl_auction_rag_backend\security -v -m concurrency
python -m pytest ipl_auction_rag_backend\security -v -m access_control
python -m pytest ipl_auction_rag_backend\security -v -m redteam
python -m pytest ipl_auction_rag_backend\security -v -m dast
```

Tests marked `live` reach a real LLM or the network and are skipped by default;
opt in with `-m live` only when a key is set in `.env`.

## What each phase attacks (and how the brief was re-scoped)

The original brief targeted mechanisms this codebase does not have. The suite
tests the boundaries that are really there:

| Phase | Brief said | What the suite actually attacks |
|------|------------|---------------------------------|
| 1 — Concurrency | "Break SQLite `EXCLUSIVE` locks with 10k bids" | Bidding is in-memory. Races `room.bid()`'s single `asyncio.Lock` + optimistic `lot.version` guard to prove no double-sell, no torn price, no over-budget win. |
| 2 — Access control | "JWT token swapping & RBAC" | There is no JWT — identity is the WebSocket you hold. Asserts seat RBAC (only the auctioneer runs privileged actions), one-franchise-one-client, that the market-data column mask is client-side only, and flags wide-open CORS + unauthenticated endpoints. |
| 3 — LLM red-team | "Inject jailbreaks & tool leaks into SCOUT" | Fires prompt-injection / system-prompt-leak / tool-abuse payloads and asserts the invariants that must hold regardless: the `max_bid` clamp in `cricket_advisor`, and the `validate_select_only` SQL guard. |
| 4 — DAST | "OWASP ZAP active spidering & fuzzing" | Spiders the routes from `openapi.json`, fuzzes malformed/oversized WebSocket frames and REST payloads, and runs a static scan for unparameterized SQL and hard-coded secrets — excluding the destructive `/api/v1/ingest` endpoint. |

## Layout

```
security/
├── conftest.py                    # sys.path + shared fixtures (room, staging_client)
├── harness/
│   ├── staging.py                 # seeded pool, temp DB, settings redirect
│   └── payloads.py                # attack corpora (added in Phase 3/4)
├── test_smoke.py                  # harness self-check — run this first if red
├── test_phase1_concurrency.py
├── test_phase2_access_control.py
├── test_phase3_llm_redteam.py
└── test_phase4_dast_fuzzing.py
```
