# IPL Auction Console

A unified auction dashboard: the `auction-console.html` prototype rebuilt in
React/TypeScript, hydrated from the Phase 2 RAG backend, with the Scout search
engine as a first-class view rather than a separate page.

`App.tsx` renders one component — `components/Console/AuctionConsole.tsx`.

## Running it

One process, one port. The backend serves both the API and the built console.

```bash
npm install && npm run build
```

```bash
cd ipl_auction_rag_backend
uvicorn api.main:app --reload --port 8001
```

On Windows PowerShell 5.1 these must be two lines, or joined with `;` — `&&`
is a parser error there, not a chain operator.

Then open **http://127.0.0.1:8001**.

| Path | Serves |
| --- | --- |
| `/` | the console |
| `/api/v1/*` | players, search, chat, health |
| `/docs` | the OpenAPI schema |

Rebuild with `npm run build` after any frontend change — the backend serves
`dist/`, not your source. Set `GROQ_API_KEY` in `ipl_auction_rag_backend/.env`
to enable written synthesis, query routing and text-to-SQL; without it retrieval
still runs and the console says so instead of showing an empty answer.

The first `/search` or `/chat` call loads a local embedding model and a
cross-encoder reranker and can take a minute or two. `/players` is a plain
SQLite read and answers immediately, so the pool appears at once.

### Working on the frontend

For hot reload, run Vite alongside the backend — this is the only case that uses
two ports, and the only reason `VITE_RAG_API_BASE` exists:

```bash
npm run dev
```

The dev server is on :5173 and calls the API on :8001. A production build is
same-origin and needs no such configuration.

## Phase 3 — the war-room lot view

A second, standalone view built for the moment of bidding rather than for
browsing the pool. It runs on its own mock feed, so it needs no backend:

| URL | Shows |
| --- | --- |
| `/?view=block` | the lot view on a simulated auction |
| `/?view=block&purse=60` | a purse too small to counter — the blocked state and refusal shake |
| `/?view=block&team=CHE` | bid as a different franchise |

It also runs on the **real** auction, as a fifth tab in the console — nothing
from Phase 2 was removed to make room for it. Three files, one view:

```
components/Auction/
├── blockTypes.ts      # the vocabulary both drivers speak
├── BlockView.tsx      # the view + every GSAP animation. Fully controlled,
│                      # holds no auction state, so both drivers share one
│                      # implementation of the layout and the motion
├── AuctionBlock.tsx   # driver A: a socket (mock by default) — the demo
└── LiveBlock.tsx      # driver B: the Phase 2 engine — the Block tab
```

The **Block** tab renders `LiveBlock`, which adapts `useAuctionEngine` into the
view. Nothing about the auction moves there: the engine stays the single source
of truth for the block, the purse and the ledger, and every bid goes back
through `engine.bidFor`, so the same legality rules govern both views. Bid in
the war room and the console's ledger shows it, and vice versa.

One real modelling difference between them. The console proper is the
*auctioneer's* — it bids on behalf of any of the ten franchises. The block view
is a *bidder's station*: it speaks for one franchise, which is what makes "you
are winning" and "your purse" mean anything. A selector in the top-left chooses
which.

Three UX rules drive it. The button states the exact figure it will commit to,
so nobody does ladder arithmetic under time pressure. The frame edge carries
status in colour before text does — steady green when you hold the bid, a
pulsing amber summons when you have been outbid and can answer, hard red when
the purse cannot cover the next rung. And the centre of the screen carries only
the lot, the price and the button; budget and history sit in the bottom corners
at a size meant for peripheral vision.

Data flows one way: socket → React state → GSAP. Animations only react to
committed state, never drive it, so a killed tween can never desynchronise the
display from the auction.

**A note on debugging GSAP.** Everything is driven by `requestAnimationFrame`,
so in any context where the page is not painting — a hidden tab, a backgrounded
window, a headless harness — tweens sit frozen at their start values and look
broken when they are merely unticked. In dev builds `window.gsap` is exposed for
exactly this: `gsap.globalTimeline.time(t)` advances the timeline by hand so you
can confirm the interpolation is real. It is stripped from production.

## The white theme

The console runs on a professional off-white ground (`#F8F9FA` with a faint
20px dot grid) and stark white cards lifted by a single diffused shadow
(`0 4px 20px rgba(0,0,0,.04)`). Three type families, each with one job:

| Family | Used for |
| --- | --- |
| Rajdhani | every figure — bids, purses, ratings. Athletic and tabular |
| Outfit | player names and headings. Geometric, so it does not fight the numerals |
| Inter | tables and labels. Built for 10px |

Franchise colour appears only as a dot, a left rail, or a figure — never as a
fill. A dashboard filled with team colour becomes a kit, and the point of a
white theme is that the numbers are the loudest thing on screen.

The palette lives in `console/console.css` as custom properties under the
original token names, so retheming is one edit rather than a rewrite.

### The purse grid

`components/Console/TeamBudgetGrid.tsx` replaced the stacked bar charts and
slot tallies in the side rail. Those answered "how has this team spent?", which
is a question for after the auction. Mid-lot there is only one question — *who
can still outbid me* — and a bar chart answers it slowly: you read ten bars,
estimate ten lengths, then rank them yourself.

So the grid does the ranking. Richest franchise top-left, and when a sale
changes the order the chips animate to their new positions rather than
snapping, because watching a rival drop two places *is* the information.
Chips warm amber below 35% of purse and red below 15%.

Money keeps the console's own `₹120.00 Cr` format. One figure format across
every view is what lets a number be compared at a glance — which is why the
chip is a stack rather than a row: that string will not sit beside a team code
at two columns in a 250px rail.

### Motion

Framer Motion, with the vocabulary in `console/motion.ts` so every panel enters
the same way and every control answers the pointer with the same weight.
Durations sit at 0.16–0.34s: an instrument someone operates under time pressure
should feel answered, not performed.

- **Tab changes** — a keyed `motion.div`, fade-and-slide from `y: 10`.
  Deliberately without `AnimatePresence`: no exit is wanted, and holding the
  outgoing view alive left a stale panel in the DOM whenever Scout — which
  stays permanently mounted so a long RAG answer survives a tab glance — was
  open.
- **Bid figures** — `BidTicker.tsx` counts up on a `MotionValue` rather than
  React state, so a settling spring writes one text node instead of pushing
  twenty renders of the panel through the reconciler. Only a raise gets the
  scale punch; a correction downward is a different event.
- **Controls** — `whileHover: 1.02` / `whileTap: 0.98`. Small on purpose:
  anything larger visibly shifts the label the user is reading.

`useReducedMotion` is honoured throughout; the Block view keeps its GSAP, since
re-animating a working view buys nothing.

**Debugging note.** Framer Motion and GSAP both run on `requestAnimationFrame`,
so anywhere the page is not painting — a hidden tab, a headless harness —
animations sit frozen at their `initial` values and look broken when they are
merely unticked. Measure `requestAnimationFrame` before concluding anything is
wrong.

## Layout

```
console/                        # logic, no JSX
├── types.ts                    # ConsolePlayer and the auction-side state
├── format.ts                   # money, stats, role glyphs, band colours, answer parsing
├── ragClient.ts                # the only place the three endpoints are described
├── search.ts                   # local fuzzy + operator search over the roster
├── useAuctionEngine.ts         # roster hydration, bidding, legality, ledger, undo
├── useScout.ts                 # RAG search + chat, with on-block context injection
└── console.css                 # the prototype's stylesheet

ipl_auction_rag_backend/
├── config/env_check.py         # startup validation: what is present, missing, malformed
├── models/hf_runtime.py        # offline model loading; no Hub round trips when cached
└── rag/local_analyst.py        # the no-LLM path: NL -> SQL, and answers from the rows

components/Console/
├── AuctionConsole.tsx          # the dashboard: masthead, tabs, split body, shared state
├── CommandSearch.tsx           # masthead palette — local matching, one-key hand-off to RAG
├── PoolTable.tsx               # filter strip + the pool sheet
├── BlockPanel.tsx              # the block card, bidding ladder, team buttons, gavel
├── LedgerPanel.tsx             # the tally
├── TeamsView.tsx               # purse, slots, role balance, squads
├── ResultsView.tsx             # headline figures and spend breakdowns
├── ScoutView.tsx               # assistant, hybrid search, on-block briefing
└── PlayerCard.tsx              # full player record + auction setup dialog
```

## How state flows

Two owners, deliberately separated.

**The RAG backend owns player identity and the 17 scouting attributes.**
`GET /api/v1/players` is fetched once on mount and normalised into
`ConsolePlayer`. It is read-only. Because the console and the vector index read
the same table, a player the Scout recommends is guaranteed to exist in the pool
table — the hand-off between the two halves can never dangle.

**The console owns the auction.** Who is on the block, the standing bid, what
each team has spent, and the ledger have no representation in the RAG schema and
should not acquire one. That state lives in `useAuctionEngine` and is
checkpointed to `localStorage`, so a refresh mid-auction is survivable.

The two halves are wired together in `AuctionConsole.tsx`, which holds both
hooks:

- **Auction → Scout.** `useScout.ask()` takes the on-block player and prefixes
  the question with a factual brief drawn from that roster row, budgeted to the
  endpoint's 500-character limit. So "is he worth it?" resolves against the
  right profile without anyone naming a player. The Scout view also shows that
  player's full attribute breakdown and what each team could still pay.
- **Scout → auction.** Every player the backend returns carries a *Put up*
  button that sends them straight to the block, matched to a roster row by
  normalised name (`SourceDocument` carries no id).

## Two search systems, on purpose

The masthead search matches locally and answers in under a millisecond, because
on auction day its job is to get a named player onto the block before the
auctioneer finishes saying the name. It handles substrings, initials (`vk` →
Virat Kohli), typos (`klasen` → Klaasen), and operators over the real stat
columns (`role:bowl econ:<7.5`, `cap:uncapped sr:>150`).

Natural-language scouting goes to `POST /api/v1/search`, which routes to SQL,
vector retrieval, or both. The search dropdown's last row hands whatever is
typed to it, so the two are one keystroke apart.

## The Scout Agent: two answer modes

The agent answers in one of two modes and always says which. `/api/v1/health`
reports the current one as `answer_mode`; every `/search` and `/chat` response
carries `mode` plus a `notes` list naming each fallback that fired, and the
console renders both as a badge on the answer.

| Mode | When | What you get |
| --- | --- | --- |
| `llm` | a provider key is configured and working | Written analysis, LLM query routing, LLM text-to-SQL |
| `local_analyst` | no key, a malformed one, or a provider that fails mid-request | Rankings, percentile standing within role, and the parsed criteria — composed from the player table by rule |

A key that is well-formed but rejected at request time (expired, revoked,
rate-limited) falls back to the analyst rather than surfacing an error: the
retrieval already succeeded, so there is a real answer to give. The failure is
named in `notes`, so the downgrade stays visible.

`rag/local_analyst.py` supplies the no-LLM path. It parses metric constraints
out of plain English (`bowlers with an economy under 8`, `uncapped batters with
a strike rate above 150`, `top 5 wicket takers`) into a parameterised SELECT,
then writes the answer from the rows: who leads, on what figure, and where they
sit among their role.

Its governing rule is that every sentence traces to a number that came out of
the database. It does not estimate, and it does not fill a gap with plausible
prose — an absent statistic is reported as absent. That is what makes it a
usable substitute rather than a convincing one: it says less than a language
model, but nothing it says is invented.

Two things it genuinely cannot do, both surfaced in `notes` rather than hidden:
it answers each question on its own, so conversational follow-ups like "and
cheaper?" will not resolve; and it matches vocabulary, not intent, so a purely
qualitative question falls through to semantic retrieval alone.

Retrieval degrades separately. If the vector store is unreachable, the agent
falls back to keyword overlap over the same rows and labels the results as term
matches rather than semantic ones.

## Checking the environment

```bash
cd ipl_auction_rag_backend
python -m config.env_check
```

Reports every setting as OK / DEGRADED / INVALID / BLOCKING with a specific
remedy, and exits non-zero only for genuinely blocking problems. The same check
runs on startup and prints to the server log.

Almost nothing is blocking by design: a missing key costs a capability, not the
service. The check distinguishes *missing* from *malformed* because a key that
is present but wrong — an OpenAI key in `GROQ_API_KEY`, or a leftover
placeholder — otherwise surfaces as an opaque 401 mid-query, which reads like a
bug in the agent rather than a configuration problem.

## Choosing an LLM provider

Two providers are supported, and either one alone is enough. Add a key to
`ipl_auction_rag_backend/.env` and restart — no code change.

**Google Gemini** (default when both are set) — key from
https://aistudio.google.com/apikey, begins `AIza`:

```
GEMINI_API_KEY=AIza_your_real_key_here
GEMINI_MODEL=gemini-2.5-flash
```

**Groq** — key from https://console.groq.com/keys, begins `gsk_`:

```
GROQ_API_KEY=gsk_your_real_key_here
```

`LLM_PROVIDER` pins the choice when both keys are present: `auto` (default,
prefers Gemini), `gemini`, or `groq`.

The Gemini free tier is rate-limited per minute. Over that limit a request comes
back 429 and the agent answers that turn with the deterministic analyst instead,
noting the reason — so rapid questioning intermittently shows a **Rule-based**
badge rather than **LLM**. That is the fallback working, not a fault.

`ipl_auction_rag_backend/.env.example` is the annotated template; copy it to
`.env` to start.

`rag/llm_provider.py` is the single place either provider is called. Gemini goes
over its REST API with `httpx` rather than the `google-generativeai` SDK —
httpx is already a dependency, the request is about fifteen lines, and it keeps
the install surface unchanged.

One Gemini-specific detail worth knowing: 2.5 Flash reasons before answering by
default, and those tokens come out of `maxOutputTokens`. On the 24-token router
call that would consume the whole budget and return an empty candidate, so
`thinkingBudget` is set to 0 — these are extraction and summarisation tasks over
data already retrieved, not problems that need deliberation.

The startup check validates each key's format and reports which provider will
actually serve a request, so pasting a Groq key into `GEMINI_API_KEY` is caught
at startup rather than as a 400 mid-query.

## Model loading

Both local models are cached under `~/.cache/huggingface/hub` (~2.4 GB). Once
they are there, `models/hf_runtime.py` switches the Hub client to offline mode,
so startup neither waits on nor depends on huggingface.co. Set `HF_FORCE_ONLINE=1`
to re-enable network mode when you want to download or update a model.

Models load lazily on the first query that needs them, not at startup — the
embedding model takes ~40 s cold and the reranker longer, and an agent serving
only the roster should never pay for either.

## Known data gaps

These are properties of the dataset, surfaced rather than papered over.

- **The pool holds 284 rows, not 296.** The console reports whatever `total` the
  endpoint returns.
- **191 of the 284 rows have no `base_price` and no `rating`.** Bidding needs a
  starting number, so a missing base price falls back to the ₹30 L floor and the
  cell is marked with `*`. A missing rating is treated as *unknown*, never as
  zero — it neither sorts to the top nor gets excluded by the rating filter.
- **`PlayerResponse` has no `set_code`,** so the sheet's auction sets (M1, M2,
  BA1 …) cannot be served. The console derives a band from role × cap status and
  labels it *derived* in the player card. It stops short of guessing at the
  marquee sets or the pace/spin split, which the dataset does not record: capped
  bowlers land in one `BO1` band rather than being split across `FA1`/`SP1` on no
  evidence. If the backend later returns `set_code`, that value is used
  automatically and the derivation is skipped.
- **`/api/v1/health` blocks the server's event loop on a cold start** — it builds
  a `ChromaManager`, which loads the embedding model, in a synchronous route. The
  console therefore probes it only after the roster has loaded, so the first
  paint never waits on a model load it does not need.
