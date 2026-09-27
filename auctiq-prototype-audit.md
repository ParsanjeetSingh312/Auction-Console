# AUCTIQ — Prototype Audit

**What `AUCTIQ-frontend/` actually contains, and what porting it costs.**
Date: 2026-09-21

---

## The headline

The brief describes the prototype as a reference for "the mathematical/logic structure of the 3D animations". It is not that. It is a **near-complete implementation of the entire hero prompt** — 33 components, five feature screens, a mock backend with 300 seeded players and ten franchises, and an auction simulation in which nine AI franchises genuinely evaluate and bid.

Its own note on that simulation:

> *"This is not a scripted animation — the nine AI franchises actually evaluate each player against their purse, squad gaps and overseas slots, and drop out when the price passes what the player is worth to them... The Auction Intelligence layer is computed from the resulting state, so its insights ('pace bowlers are going 18% above base') are genuinely derived rather than hardcoded strings."*

That is hero prompt §12 — working, not mocked.

---

## Full inventory

### 3D and motion — **ported**

| File | Lines | Status |
|---|---|---|
| `three/objects/Stadium.tsx` | 198 | ported → `Turf.tsx` + `FloodlightBank.tsx` |
| `three/objects/Trophy.tsx` | 130 | ported → `ChaliceTrophy.tsx` (handles rebuilt) |
| `three/rig/CameraRig.tsx` | 121 | ported → `rig/CameraRig.tsx` (waypoints dropped) |
| `motion/useJourney.ts` | 111 | ported → `hooks/useJourney.ts` (Lenis dropped) |
| `lib/quality.ts` | 91 | ported → `rig/quality.ts` (reduced-motion split out) |
| `three/Scene3D.tsx` | 83 | ported → `StadiumScene.tsx` |
| `three/Effects.tsx` | 25 | **not ported** — needs `@react-three/postprocessing@2.x` |
| `three/Stage.tsx` | 32 | not needed — tier gate lives in `StadiumBackdrop` |
| `motion/gsap.ts` | 45 | not ported — would duplicate `console/motion.ts` |

### Auction floor — **not ported** (steps 7–10)

| File | Lines | What it is |
|---|---|---|
| `auction/SoldOverlay.tsx` | 136 | hammer → SOLD → team → price |
| `auction/BidBoard.tsx` | 132 | the number the room watches |
| `auction/Walkout.tsx` | 121 | lights down → spotlight → name → number → base price |
| `auction/PurseMeter.tsx` | 83 | purse, squad, overseas slots |
| `auction/Hammer.tsx` | 71 | the recurring mark |
| `auction/TeamLadder.tsx` | 68 | who is in the fight for this lot |
| `auction/LotIdentity.tsx` | 50 | who is on the block |
| `auction/BidHistory.tsx` | 47 | running log, newest first |

### Analytics — **not ported** (step 9)

| File | Lines | What it is |
|---|---|---|
| `features/Analyst.tsx` | 225 | the Auctioneer Analyst command centre |
| `analytics/Charts.tsx` | 151 | **hand-built SVG on d3 scales, no charting library** |
| `analytics/InsightRail.tsx` | 70 | the intelligence rail |
| `lib/engine.ts` | 208 | auction intelligence — derives every insight |
| `lib/analytics.ts` | 152 | derived metrics, pure functions |

### Players — **not ported** (step 10)

| File | Lines | What it is |
|---|---|---|
| `features/PlayerPool.tsx` | 224 | 300-player pool: search, facets, grid |
| `player/PlayerDetail.tsx` | 172 | the CARD → PLAYER cinematic |
| `player/PlayerCard.tsx` | 106 | **jersey number as hero, no rating** |
| `player/PlayerSilhouette.tsx` | 32 | role-specific silhouettes, no photography |

### Identity and chrome — **not ported**

| File | Lines | What it is |
|---|---|---|
| `mascot/Mascot.tsx` | 162 | DUKE — hero prompt §9 |
| `nav/FloodlightNav.tsx` | 111 | floodlight navigation — hero prompt §3 |
| `EasterEggs.tsx` | 167 | A/H/S shortcuts, logo confetti, cursor ball — §15 |
| `primitives/NumberRoll.tsx` | 66 | numbers that count rather than snap |
| `primitives/Panel.tsx` | 47 | the surface every console module sits on |
| `primitives/TeamMark.tsx` | 37 | crests drawn from colour + short name |

### Data layer — **the part that does not port**

| File | Lines | What it is |
|---|---|---|
| `mocks/players.seed.ts` | 334 | 300 players + 10 franchises, deterministic |
| `mocks/auctionSim.ts` | 262 | nine AI franchises that really bid |
| `mocks/mockServer.ts` | 169 | in-process mock server (replaced MSW) |
| `mocks/store.ts` | 128 | single in-memory source of truth |
| `api/realtime.ts` | 190 | "the auction is changing underneath us" |
| `api/adapters.ts` | 180 | raw response → app shape |
| `api/queries.ts` | 123 | every server read, via TanStack Query |
| `api/types.ts` | 120 | app-shaped domain types |
| `lib/money.ts` | 61 | integer lakhs — **same convention as your backend** |
| `stores/auctionStore.ts` | 103 | live lot state from realtime events |
| `stores/sceneStore.ts` | 76 | camera navigation, no router |

---

## The three things that block a straight port

### 1. The endpoints do not match

| Prototype expects | Your backend has |
|---|---|
| `/api/players` | `/api/v1/players` |
| `/api/teams` | — |
| `/api/auction/state` | **WebSocket**, `auction/ws.py` |
| `/api/auction/bid` | **WebSocket** |
| `/api/auction/analytics` | — |
| — | `/api/v1/search`, `/api/v1/chat` |
| — | `/api/v1/scout/advise`, `/api/v1/scout/research` |

The prototype has a live mode (`API_MODE`, `VITE_API_BASE_URL`), so it is not hardwired to mocks. But its auction is REST-polled where yours is a socket, and it has no concept of SCOUT. Its own note says it *"emits exactly the AuctionEvent shapes the real WebSocket is expected to send"* — written against an expectation, never tested against the real one.

### 2. The auction is simulated, not authoritative

`auctionSim.ts` decides bids in the browser. Your `auction/room.py` decides them on the server, on purpose — `useAuctionSocket`'s own header says a client that computes them *"is a client that can disagree with the room, and ten clients disagreeing with the room is the bug this whole phase exists to prevent."*

So the simulation is a **demo asset**, not a foundation. It is exactly right for the War Room demo (step 8) and exactly wrong for the live room.

### 3. Navigation is a camera move, not a router

`sceneStore.ts`: *"There is no react-router here on purpose. Navigation in AUCTIQ is a camera move."* Your app is routed. Every prototype screen assumes it is mounted inside one continuous WebGL world that never unmounts. Porting a screen means separating its content from that assumption.

---

## What this means for the plan

The plan so far treats the prototype as a source of 3D logic and the main site as the product. That was the right call given the brief, and the 3D half is done on it.

But the remaining steps — 7 through 10 — are not small ports. They are **roughly 1,900 lines** of auction floor, analytics and player UI, each written against a different data layer, a different navigation model and a different state library.

Three honest options:

**A. Continue porting into the main site.** Keeps the brief exactly. Every component is rewritten against `useAuctionSocket` and react-router as it lands. Highest fidelity to "don't change the main page", highest total effort, and the auction simulation is left behind except for the demo.

**B. Port the presentation, keep your data layer.** Take each prototype component's markup and motion, drop its TanStack Query hooks, and feed it from `useAuctionSocket`. This is option A done deliberately rather than file-by-file — same destination, but the adapter shape is decided once instead of eight times. **My recommendation.**

**C. Make the prototype the product.** Move your backend wiring into it rather than its UI into yours. It is closer to the hero prompt than the main site is, and it already has the analytics, the pool, the walkout and the mascot. The cost is that your live auction room, SCOUT panel, console and Data Interface all move — and your brief explicitly rules this out.

I am proceeding on **B** unless told otherwise, because it reaches the same place as A with fewer decisions taken twice, and it does not touch anything you have asked to leave alone.

---

## Not yet ported, ranked by what it gives you

1. **`Effects.tsx`** — bloom. One dependency, ~25 lines, and it is the difference between floodlights that glow and floodlights that are bright rectangles.
2. **`Hammer.tsx` + `SoldOverlay.tsx`** — step 7, the punctuation mark of the whole product.
3. **`PlayerCard.tsx`** — jersey number as hero. Blocked on the `jersey_number` data, which is now a column.
4. **`NumberRoll.tsx`** — 66 lines, and every changing figure in the product benefits.
5. **`Charts.tsx` + `engine.ts`** — the Analyst. The largest single piece, and hero prompt §11 and §12 together.
6. **`Mascot.tsx`, `FloodlightNav.tsx`, `EasterEggs.tsx`** — identity. Real work, no functional dependency.
