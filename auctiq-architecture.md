# AUCTIQ — Frontend Architecture

**Phase:** 3D scroll, War Room, block animations, split-screen dashboard, player cards
**Status:** architecture only — no UI code written yet
**Date:** 2026-09-21

---

## 0. The two codebases

There are two projects on this machine and they are not what the brief assumes.

| | `Auction-console/` | `AUCTIQ-frontend/` |
|---|---|---|
| Role | **the main website** — ships, wired to the backend | **the prototype** |
| Git | tracked, `feat/auctiq-landing` | **not a git repo** |
| React | 18.3 | 19.2 |
| R3F | 8.18 | 9.7 |
| three | 0.169 | 0.186 |
| Motion | framer-motion (24 files), GSAP (1 file) | GSAP + Lenis throughout |
| Data | react-router, direct fetch | zustand + TanStack Query |

The prototype is **not a reference sketch**. It is a more advanced application that already implements, in some form, features 3, 4 and 5 of this brief and much of the hero prompt: `three/objects/Stadium.tsx`, `three/rig/CameraRig.tsx`, `motion/useJourney.ts`, `auction/Hammer.tsx`, `auction/SoldOverlay.tsx`, `auction/BidHistory.tsx`, `auction/TeamLadder.tsx`, `analytics/Charts.tsx`, `analytics/InsightRail.tsx`, `auction/LotIdentity.tsx`.

**Direction of travel is fixed by the brief:** the main site's look and functionality win. The prototype contributes *the mathematics and choreography of the 3D scroll* and nothing else. No prototype CSS, no prototype layout, no prototype component wholesale.

### The one piece of genuinely good news

The prototype's stadium is **entirely procedural primitive geometry**. There is no `.glb`, no `.hdr`, no `.gltf` anywhere in the project. Its own header says why:

> *"A night stadium is mostly darkness, haze and a handful of very bright sources, so detail in the stands buys almost nothing visually while costing draw calls on every frame."*

There is no asset pipeline to build, no model licensing, no download budget. The stadium ports as **code**, which is the cheapest possible form of this feature.

---

## 1. Decisions taken

### 1.1 React 18 stays. The 3D layer is rewritten, not copied.

R3F 9 requires React 19. Upgrading the main site would touch every one of its 39 components including `BlockView`, `useAuctionSocket` and the live bidding path.

**Decision: rewrite the ~950-line scroll rig against R3F 8.** The auction wiring is never opened. The cost is mine to absorb — behavioural drift from the prototype is a risk I own, not a risk the live auction takes.

#### One dependency this requires

The prototype's `three/Effects.tsx` runs `Bloom` and `Vignette` from `@react-three/postprocessing`, which the main site does not have. This is not optional garnish — without it the floodlights render as flat bright quads, and the prototype's own comment is exact about why:

> *"Only the floodlight faces and the neon rings exceed the luminance threshold, so bloom stays confined to actual light sources instead of washing the whole frame — which is the difference between 'cinematic' and 'cheap glow filter'."*

`@react-three/postprocessing@2.x` is the R3F 8-compatible line — same `Bloom` and `Vignette`, same props as the `3.x` the prototype uses. **This is the only new runtime dependency this phase adds.**

Verified as already present in the main site's `drei@9.122`, so nothing else is needed: `Environment`, `Lightformer`, `Canvas`, `useFrame`.

#### What "the same animations" does and does not mean

The animation maths is three.js inside `useFrame`, driven by a scroll scalar. R3F is a reconciler — it builds the scene graph and leaves the render loop alone — so the React major version does not reach the motion. With bloom restored, the visual result should match.

The honest residual risk is not the version gap. It is that **~950 lines are being rewritten by hand**, and hand-rewritten choreography drifts. That is why steps 3, 4 and 5 of the build order are gated on side-by-side comparison against the running prototype rather than on my judgement alone.

#### Correction, after running the prototype: Lenis is not optional

An earlier draft of this document listed Lenis among the dependencies this phase would not introduce. Running the prototype proved that wrong, and the reason is structural rather than aesthetic.

`journey.progress` is not derived from `window.scrollY`. It is `lenis.scroll / lenis.limit` — measured live at 0.1878 against a Lenis scroll of 540.8 and a limit of 2880. Lenis owns the scroll position; ScrollTrigger reads Lenis. Driving `window.scrollTo` directly desynchronises the two, which is observable: seeking to native 1382px rendered a black frame while 1920px rendered the pitch, a non-monotonic result that only makes sense once you know Lenis is the source of truth.

There is also the feel, which the prototype is explicit about:

> *"Long, shallow curve: the scroll keeps gliding after the wheel stops, which is what makes a camera move read as a camera move."*

Lenis is framework-agnostic and has no React or R3F coupling, so it carries no version risk. **Revised dependency list for this phase: `@react-three/postprocessing@2.x` and `lenis`.** Two additions, both small, both load-bearing.

### 1.1b The measured journey — reference for the port

Captured from the running prototype at tier 3 (16 cores, DPR 1.25, `prefers-reduced-motion: false`), so these frames are full quality: bloom on, shadows on, six floodlights.

| Progress | Beat | What is on screen |
|---|---|---|
| `0.00` | HERO start | Wide arena, dark. AUCTIQ wordmark, neon boundary ring, trophy small on the pitch. |
| `0.15` | `heroEnd` | Floodlights ramped in. Spotlight lands on the pitch strip; trophy lit. |
| `0.32` | `trophyEnd` | Camera has descended and orbited. Trophy fills frame with a bloom highlight. **"THE NEXT CHAMPION IS BUILT HERE."** |
| `0.48` | `pitchEnd` | Turf level. Trophy moved aside to frame-right, cricket ball visible mid-air. **"THE ROOM IS SET."** with `300 / 10 / ₹1200`. |
| `0.48 – 1.00` | HANDOFF | The 3D journey is over. Routes take over. |

**The entire 3D sequence occupies the first 48% of scroll** — roughly 1,382px of a 2,880px range at a 900px viewport. The remaining half is route content, not camera work. Any port that spreads the journey across the full scroll range will feel half as fast as the original.

#### Reproducing a frame exactly

Vite serves source modules in dev, so the journey can be driven directly rather than approximated. The browser pane must be **fronted** — a hidden pane suspends `requestAnimationFrame`, which stops the R3F render loop and Lenis's ticker.

```js
const m = await import('/src/motion/useJourney.ts')
const l = m.getLenis()
l.scrollTo(0.32 * l.limit, { immediate: true, force: true })
// then read m.journey.progress to confirm you are where you think you are
```

This is the comparison harness for build steps 3, 4 and 5: seek both apps to the same progress value and diff the frames, rather than scrolling by hand and trusting memory.

### 1.2 framer-motion stays the UI motion language. GSAP is scoped to the scroll rig.

`console/motion.ts` is an established vocabulary with a stated rationale:

> *"Motion that differs slightly from view to view reads as jitter... Durations are deliberately short. A dashboard someone operates under time pressure should feel answered, not performed: 0.18–0.32s."*

That is correct and it is already applied across 24 files. Porting the prototype's GSAP-everywhere approach would rewrite the entire motion language of a working product to gain nothing.

| Concern | Library | Why |
|---|---|---|
| Scroll-linked 3D camera, floodlight ramp, ball flight | **GSAP ScrollTrigger** | `scrub` binds progress to scrollbar position; framer-motion has no equivalent |
| Panel enter/exit, buttons, hover, layout | **framer-motion** | already the house language; `motion.ts` variants apply unchanged |
| Hammer, coins, alarm | **framer-motion** | discrete event-driven, not scroll-linked |

Two libraries in one app is a cost. It is justified here only because the two concerns are genuinely different: one is a continuous function of scroll position, the other is a set of discrete state transitions.

### 1.3 Jersey numbers get a real backend column.

The `players` table has 23 columns and none is a jersey number. The prototype's `api/adapters.ts:110` already probes four spellings (`jerseyNumber`, `jersey_number`, `jersey`, `shirtNumber`) and falls back — defensive code written for a field that was never there.

**Decision: add `jersey_number` to `players` and to `data/pool_metadata.json`,** seeded with the five from the hero prompt and filled from public record where known. Nothing is fabricated. Cards fall back to the role badge where the number is genuinely unknown.

This is backend work and it blocks feature 5. It is sequenced first for that reason.

---

## 2. Component tree

New files are marked **NEW**. Everything unmarked is untouched.

```
components/
├── 3D/
│   ├── TrophyCanvas.tsx            existing — trophy keeps its place (hero prompt §2)
│   ├── RevolvingTrophy.tsx         existing
│   ├── StadiumScene.tsx            NEW  R3F 8 root; mounts the arena, owns the canvas
│   ├── stadium/
│   │   ├── Turf.tsx                NEW  ground plane + pitch strip
│   │   ├── Bowl.tsx                NEW  stands, procedural
│   │   ├── FloodlightBank.tsx      NEW  6 towers, staggered ramp-on
│   │   └── Haze.tsx                NEW  atmospheric fog volume
│   ├── CricketBall.tsx             NEW  the scroll-linked ball (feature 1)
│   └── rig/
│       ├── CameraRig.tsx           NEW  scroll progress → camera transform
│       └── quality.ts              NEW  device tier → draw-call budget
│
├── Sections/
│   ├── StadiumBackdrop.tsx         MODIFIED  photo becomes the opening frame, hands off to 3D
│   ├── BroadcastHero.tsx           MODIFIED  one import swap (LiveBiddingCard → WarRoomTrigger)
│   ├── HeroSection.tsx             existing
│   └── PlayerShowcase.tsx          existing
│
├── WarRoom/                        NEW  (feature 2)
│   ├── WarRoomTrigger.tsx          NEW  supersedes LiveBiddingCard in the hero's right slot
│   ├── WarRoomOverlay.tsx          NEW  full-bleed overlay, focus-trapped
│   └── useSimulatedAuction.ts      NEW  scripted lot sequence, no socket, no backend
│
├── Auction/
│   ├── BlockView.tsx               MODIFIED  mounts the three animation layers; bid path untouched
│   ├── TimerDisplay.tsx            MODIFIED  alarm threshold (see §5.3)
│   ├── AuctionBlock.tsx            existing — transport only
│   ├── SocketBlock.tsx             existing
│   ├── AdminSplitScreen.tsx        MODIFIED  hosts the new dashboard panels
│   └── fx/                         NEW  (feature 3)
│       ├── HammerDrop.tsx          NEW  on kind === "sold"
│       ├── CoinDrop.tsx            NEW  on kind === "bid"; cascades on a jump bid
│       └── AlarmPulse.tsx          NEW  on clock urgent && !userIsBidding
│
├── Console/
│   ├── LedgerPanel.tsx             MODIFIED  "Tally" superseded in place by BiddingHistoryGrid
│   ├── BiddingHistoryGrid.tsx      NEW  (feature 4) virtualised datagrid
│   ├── TeamLeaderboard.tsx         NEW  (feature 4) live standings
│   ├── AuctionIntelligence.tsx     NEW  (feature 4) insight panel
│   ├── DataDashboard.tsx           existing
│   └── PlayerCard.tsx              MODIFIED  jersey number + live bid tracking (feature 5)
│
└── UI/
    ├── PlayerCard.tsx              MODIFIED  same treatment — see the note below
    └── LiveBiddingCard.tsx         RETAINED  no longer mounted; kept, not deleted (§6)
```

**Note — there are two `PlayerCard.tsx` files.** `UI/PlayerCard.tsx` (landing) and `Console/PlayerCard.tsx` (operator). They are different components serving different surfaces and both need the jersey number. They are *not* being merged in this phase; that is a refactor with its own risk and it is not what was asked for. Both get the same jersey treatment via a shared `usePlayerIdentity` hook so the two cannot drift.

---

## 3. State management

Three stores already exist in the main site and **no new global store is introduced**.

| State | Lives in | Read by |
|---|---|---|
| Room, lot, teams, log | `hooks/useAuctionSocket.ts` (existing) | BlockView, AdminSplitScreen, the new panels |
| Scroll progress `0→1` | **NEW** `hooks/useJourney.ts` — a ref, not React state | CameraRig, FloodlightBank, CricketBall |
| War Room simulation | **NEW** `useSimulatedAuction.ts` — local to the overlay | WarRoomOverlay only |

**Scroll progress is a `useRef`, never `useState`.** A scroll-linked camera updates every frame; routing that through React state would re-render the tree at 60fps. The rig reads `journey.current` inside `useFrame` and React never learns about it. This mirrors the prototype's `journey.progress` and is the single most important performance decision in this phase.

The War Room simulation is deliberately **isolated from `useAuctionSocket`**. It is a demo. It must not be able to emit a bid, hold a seat, or touch a live room. Sharing the socket hook would make that possible by accident.

---

## 4. 3D asset handling

**No external assets.** All geometry is procedural.

### Quality tiers

`rig/quality.ts` resolves a tier once on mount from `navigator.hardwareConcurrency`, `devicePixelRatio` and a `matchMedia('(prefers-reduced-motion: reduce)')` check.

| Tier | Floodlight cones | Shadows | DPR cap | Haze |
|---|---|---|---|---|
| `high` | 6 | on | 2 | on |
| `medium` | 3 | off | 1.5 | on |
| `low` | 0 | off | 1 | off |
| `reduced-motion` | static final frame, no `useFrame` subscription | — | 1 | off |

Hero prompt §16 asks for this explicitly: *"Heavy 3D effects should be reduced or disabled on lower-powered devices."*

### Disposal

Three.js never releases GPU memory on its own. Every mesh removed from the scene disposes its geometry, its material, and every texture map on that material. The stadium mounts once and lives for the session, so the real exposure is the War Room overlay and route changes — `StadiumScene` unmounts on navigation away from `/`, and that path gets an explicit disposal pass rather than relying on R3F's cleanup.

### Particle budget

Haze and the coin cascade are the only particle systems. Both start at **3,000 particles** and are profiled on real mobile hardware before that number moves. Desktop-to-mobile GPU ratios run as high as 10:1, so a count that holds 60fps on this machine proves nothing about a mid-range Android.

---

## 5. Event mapping — where each animation actually hooks in

This is the part the brief asked for explicitly. **Every trigger below already exists in the codebase.** Nothing here invents an event.

### 5.1 Hammer Drop → `LogItem.kind === "sold"`

`components/Auction/blockTypes.ts:28` defines `kind: "bid" | "sold" | "unsold" | "lot" | "note" | "timeout" | "withdraw"`. `HammerDrop` subscribes to the log tail and fires on a new `sold` entry. It renders in a portal above `BlockView`, is `pointer-events: none` throughout, and never gates the UI — the next lot can load while the hammer is still falling.

### 5.2 Coin Drop → `LogItem.kind === "bid"`, cascading on a jump bid

Jump bids are already a first-class concept. `hooks/useAuctionSocket.ts:199`:

> *"`amount` omitted bids the standard increment; supplied, it is a jumpbid."*

So the cascade condition is not a guess. `CoinDrop` compares the bid delta against `incrementFor(previousBid)` (`blockTypes.ts:37`); a delta of one increment drops one coin, a delta of *n* increments drops *n* coins, capped at 8 so a 20-increment jump does not become a coin fountain.

### 5.3 Alarm Pulse → the existing `urgent` state

`components/Auction/TimerDisplay.tsx:188` already computes:

```ts
const urgent = clock.kind === "closing" && left <= URGENT_AT;
```

**But `URGENT_AT = 3`, and the brief asks for 5.** These are two different thresholds for two different jobs: the existing one turns the timer red, the new one raises an alarm. Changing the constant would alter established visual behaviour for everyone. So `TimerDisplay` exports a second threshold `ALARM_AT = 5` and keeps `URGENT_AT` at 3. The timer still goes red at 3; the alarm raises at 5.

The brief's *"and the user isn't bidding"* condition maps to: the viewer holds a franchise seat, that seat is not the current top bidder, and the lot is live. A spectator gets no alarm — there is nothing they can do about it.

### 5.4 Feature → DOM location

| Feature | Mounts inside | File |
|---|---|---|
| 3D stadium + ball | the landing's backdrop layer, behind all content | `Sections/StadiumBackdrop.tsx` |
| War Room trigger | the hero's right-hand card slot | `Sections/BroadcastHero.tsx:128` |
| War Room overlay | portal at document root, above everything | `WarRoom/WarRoomOverlay.tsx` |
| Hammer / Coins / Alarm | portal above the block, `pointer-events: none` | `Auction/BlockView.tsx` |
| Leaderboard, History, Intelligence | the auctioneer's split panes | `Auction/AdminSplitScreen.tsx` |
| Jersey number + live bid tracking | both player cards | `UI/` and `Console/PlayerCard.tsx` |

---

## 6. What is superseded, and what is deleted

**Nothing is deleted in this phase.**

The brief says "replace entirely" of the Place Bid card and "replace" of the Tally section. Both are superseded *in place* — the slot renders the new component, the old file stays on disk and unmounted. Two reasons: a standing instruction on this project that UI work is additive, and the fact that `LiveBiddingCard` and `LedgerPanel` are working components whose removal is not required for anything new to land.

If you want them gone, that is one line each and a separate commit that is trivial to revert. Say so and I will do it.

**`components/Auction/BlockView.tsx:425` — the functional `placeBid` button — is not touched.** The brief's "Place Bid section on the right corner of the main page" is `UI/LiveBiddingCard.tsx:97`, a decorative CTA in the landing hero. These are different things and confusing them would break live bidding.

---

## 7. Build order

Sequenced so every checkpoint is something you can open in a browser and use. Each step is one file at a time, presented for review before the next.

| # | Step | Gated on |
|---|---|---|
| **0** | `jersey_number` column + `pool_metadata.json` + ingestion | — |
| **1** | `rig/quality.ts`, `hooks/useJourney.ts` | — |
| **2** | `StadiumScene` + `Turf` — visible, scrollable, no floodlights yet | 1 |
| **3** | `FloodlightBank` + `Haze` — the arena wakes up | 2 |
| **4** | `CameraRig` — scroll moves the camera to the pitch | 2 |
| **5** | `CricketBall` — the scroll-linked ball | 4 |
| **6** | `StadiumBackdrop` handoff — photo → 3D | 3, 4 |
| **7** | `fx/HammerDrop`, `fx/CoinDrop`, `fx/AlarmPulse` | — |
| **8** | `WarRoomTrigger` + `WarRoomOverlay` + `useSimulatedAuction` | 7 |
| **9** | `BiddingHistoryGrid`, `TeamLeaderboard`, `AuctionIntelligence` | — |
| **10** | Player cards — jersey number + live bid tracking | 0 |

Steps 7, 9 and 10 have no 3D dependency and can move earlier if you would rather see auction-floor polish before the stadium.

---

## 8. Open risks

| Risk | Handling |
|---|---|
| **Screenshots not yet supplied.** The brief says to build to the main site's screenshots; none have arrived. | Steps 9 and 10 are layout-sensitive and will wait for them. Steps 1–8 are not. |
| **R3F 8 rewrite drifts from the prototype's feel.** | Side-by-side comparison at steps 3, 4, 5. The prototype stays runnable as the reference. |
| **Pinned ScrollTrigger sections fight native scroll on mobile.** | At most one pinned section on the landing. Profiled on a real device, not a desktop throttle. |
| **Two motion libraries.** | Hard boundary: GSAP never animates a DOM node the UI owns; framer-motion never drives the camera. |
| **`prefers-reduced-motion`.** | Not a late pass. The rig renders its final frame and skips the `useFrame` subscription entirely. |
| **Jersey numbers are partly unknowable.** | Real numbers or a role badge. No generated numbers. |

---

## 9. What this phase does not do

- Does not upgrade React, R3F or three on the main site
- Does not introduce zustand or TanStack Query
- Adds exactly two runtime dependencies, both load-bearing: `@react-three/postprocessing@2.x` and `lenis` (see §1.1)
- Does not port any prototype CSS, layout or component wholesale
- Does not merge the two `PlayerCard` components
- Does not touch `useAuctionSocket`, `AuctionBlock`, `SocketBlock` or the `placeBid` path
- Does not delete any existing component
