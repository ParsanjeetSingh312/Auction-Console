# Deploying AUCTONIQ to Railway

Railway builds the repository-root `Dockerfile` automatically. The image is the
same one Render and Hugging Face Spaces use; the Railway-specific parts are:

- `deploy/docker-entrypoint.sh` makes Railway's root-owned volume writable by the
  app's UID 1000, and points the model cache, Chroma index, SQLite file and SCOUT
  checkpoints at the volume unless you set those paths yourself.
- `api/main.py` reads `RAILWAY_PUBLIC_DOMAIN` (alongside Render's
  `RENDER_EXTERNAL_URL`) for its CORS origin and the optional keep-alive.

There is deliberately no `railway.json`: Railway deprecated Config as Code
(files stop being read on 2026-12-01). The few settings below go in the
dashboard instead.

## 1. Create the service

New Project → Deploy from GitHub repo → this repository, branch `main`.
Railway detects the `Dockerfile`. The first build takes roughly 10–15 minutes
(torch, Chromium).

## 2. Attach a volume

Service → right-click / **+ New** → **Volume**, mount path **`/data`**, 5 GB.
Nothing else is needed; the entrypoint redirects all state there.

## 3. Variables (Service → Variables)

| Variable | Value |
| --- | --- |
| `RERANKER_MODEL_NAME` | `BAAI/bge-reranker-base` (the code default is the 2 GB `large`) |
| `RERANKER_ENABLED` | `false` on the trial plan (~1 GB memory cap): skips the ~1 GB cross-encoder, results keep vector-search order. Remove it on Hobby or above |
| `AUCTIONEER_PASSWORD` | your choice: blank keeps the auctioneer chair locked |
| `ADMIN_API_KEY` | a long random string: blank leaves `/ingest` open to anyone |
| `DATABASE_URL` | Supabase **session pooler** string, if you use Supabase. Omit to use SQLite on the volume |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | if you use Supabase |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `HUGGINGFACE_API_KEY` | whichever you use |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | `900` (first boot downloads the models before it answers) |
| `AUCTION_MAX_ROOMS` | optional, default `24`: auction rooms open at once (each is one auction, up to 12 franchises) |
| `AUCTION_MAX_CONNECTIONS` | optional, default `600`: live-bidding sockets across every room |

Do **not** set `PORT` (Railway sets it), `PLAYWRIGHT_BROWSERS_PATH`, or `HF_HOME`.

## 4. Settings (Service → Settings)

- **Networking → Generate Domain.** If it asks for a port, use the one in the
  deploy logs line `Starting uvicorn directly on 0.0.0.0:<port>`.
- **Deploy → Healthcheck Path:** `/api/v1/ping`.
- **Deploy → Replicas:** 1, and no autoscaling. Auction rooms are in-process
  state; a second replica would hold a second, separate set of rooms, and
  people with the same room code could land on different ones.
- **Resources:** at least 4 GB memory. Startup is ~2 GB resident.

## Auction rooms and load

Live Bidding runs one auction per room: the auctioneer creates a room (its code
shows on their control panel) and franchise owners join with that code. All
rooms live in the one server process.

- **Capacity.** Measured with `ipl_auction_rag_backend/security/loadtest_auction.py`
  on a desktop: 6 simultaneous auctions (74 people) used ~8% of one CPU core
  with bids reaching the whole room in under 20 ms; 48 auctions (592 people)
  still ran cleanly at ~35%. Railway's vCPUs are slower, so plan for 20-30
  auctions at once; the default caps (24 rooms, 600 sockets) sit there. Check
  `GET /api/v1/auction/rooms/stats` for rooms and sockets in use.
- **Do not redeploy during an auction.** Rooms are in memory: a deploy or a
  restart ends every running auction. Deploy between auctions.
- **Egress.** Updates are compressed (permessage-deflate): roughly 0.5 GB an
  hour with six auctions bidding at once.

## 5. First deploy, then load the player pool

The first boot downloads ~1.2 GB of models onto the volume (a few minutes).
Later boots load them from disk. Once the deploy is healthy, build the player
pool and search index once:

```bash
curl -X POST https://YOUR-DOMAIN.up.railway.app/api/v1/ingest -H "X-Admin-Key: YOUR_ADMIN_API_KEY"
```

The auction room picks the pool up immediately; no restart needed. Check
everything at `https://YOUR-DOMAIN.up.railway.app/api/v1/health`.
