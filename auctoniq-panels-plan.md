# AUCTONIQ — Admin panel, Auctioneer panel, Waiting room, 3D passes

Implementation plan. Each step lists the files it creates or changes, in the
order they are built, so a failure can be traced to one file.

Decisions already made:

- **Calendar:** AUCTONIQ keeps each auctioneer's schedule itself (always
  works). A *Connect Google Calendar* button signs the auctioneer in with
  Google and copies every scheduled auction into their Google Calendar. The
  Google half switches on when `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are
  set on Railway; until then the button explains what is missing.
- **Start gate:** passes sent from a room's waiting room are tied to that
  room. The auctioneer cannot start until every invitee has claimed the pass,
  taken a seat and acknowledged the rules.
- **Admin panel:** inside the Account page, shown to administrators only.

---

## Step 0 — Storage (backend)

| File | Change |
| --- | --- |
| `ipl_auction_rag_backend/accounts/store.py` | New tables: `auction_log` (room opened / started / finished), `room_invites` (who was invited to which room), `auction_schedule` (an auctioneer's upcoming auctions), `google_links` (an account's Google Calendar connection). |

## Step 1 — Admin panel

| File | Change |
| --- | --- |
| `accounts/activity.py` *(new)* | Writes `auction_log` rows; reads auctions per day. |
| `auction/ws.py` | Logs a room being opened, started and finished. |
| `accounts/admin_stats.py` *(new)* | One overview: accounts by tier; passes generated / sent / claimed / spent / expired by kind (window and all time); passes the admin personally gave; pending gifts; auctions per day; rooms open right now; most active auctioneers; recent pass activity. |
| `api/routes_ecosystem.py` | `GET /api/v1/admin/overview?days=7` (admins only). |
| `console/adminApi.ts` *(new)* | Typed client for the overview. |
| `components/Account/AdminPanel.tsx` *(new)* | Stat tiles, auctions-per-day chart, pass flow table, top auctioneers, recent activity, day-range switch. |
| `pages/Account.tsx` | Mounts the admin panel for administrators. |

## Step 2 — Auctioneer panel + Google Calendar

| File | Change |
| --- | --- |
| `accounts/schedule.py` *(new)* | Create / list / update / delete scheduled auctions. |
| `accounts/google_calendar.py` *(new)* | Google OAuth (connect, callback, disconnect, token refresh) and event insert / update / delete. |
| `api/routes_schedule.py` *(new)* | `/api/v1/schedule` CRUD, `/api/v1/schedule/google/*`, and `GET /api/v1/auctioneer/overview` (Delegate passes generated, sent, claimed, pending, and to whom). |
| `api/main.py` | Registers the schedule router. |
| `config/settings.py` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URL`. |
| `console/scheduleApi.ts` *(new)* | Typed client. |
| `components/UI/UpcomingAuctionsCard.tsx` | Reads the real schedule instead of its two hard-coded fixtures. |
| `components/Account/SchedulePanel.tsx` *(new)* | Month view, *Schedule an auction* form, Google connect / sync state. |
| `components/Account/AuctioneerPanel.tsx` *(new)* | Delegate-pass figures and recipients, plus the schedule. |
| `pages/Account.tsx` | Mounts the auctioneer panel for auctioneers (and admins). |

## Step 3 — Waiting room in *Send passes*

| File | Change |
| --- | --- |
| `accounts/invites.py` *(new)* | Records invites when passes are sent for a room; reports each invitee's state. |
| `api/routes_ecosystem.py` | `send` accepts `room_code`; `GET /api/v1/rooms/{code}/waiting`. |
| `auction/room.py` | `start_auction` refuses while any invitee is not seated and briefed (a gate the WebSocket layer supplies). Franchises cannot leave a running auction. |
| `auction/ws.py` | Supplies the gate; tags the claim notification with a link into the room. |
| `console/ecosystemStore.ts` | `openSendPasses({ roomCode })`, `sendPasses(..., roomCode)`. |
| `components/Ecosystem/WaitingRoomSection.tsx` *(new)* | Invitee list: pass sent → claimed → seated → acknowledged; the start button's reason. |
| `components/Ecosystem/SendPassesDialog.tsx` | Shows the waiting room section when opened for a room. |
| `components/Auction/RoomCodeBadge.tsx` | Opens the dialog for its room. |
| `components/Auction/SocketBlock.tsx`, `pages/LiveAuction.tsx` | No *Leave seat* for franchises while live; a warning before closing the tab. |

## Step 4 — 3D pass cards with powers

| File | Change |
| --- | --- |
| `components/Passes/passPowers.ts` *(new)* | What each pass can do, per viewer tier. |
| `components/Passes/FlipPass.tsx` *(new)* | Front = the existing `AuctionPass`; back = its powers. Framer Motion: click to flip, drag to spin through 360°. GSAP: a full 360° showcase turn on first view, edge thickness and the foil glint while turning. |
| `components/Passes/passes.css` | Back face, card edge, perspective. |
| `components/Ecosystem/WalletPanel.tsx` | Uses `FlipPass`, so both the Admin and Auctioneer views get it. |

## Step 5 — Verify

- Backend tests for: admin overview, schedule CRUD, invites and the start gate, no leaving a live auction.
- `tsc -b`, then the browser: Account page as admin and as auctioneer, the waiting room flow end to end, the card flip.

## What you need to do for Google Calendar

1. Google Cloud Console → create a project → enable **Google Calendar API**.
2. OAuth consent screen → External → add the scope `.../auth/calendar.events`.
3. Credentials → OAuth client ID → Web application → Authorized redirect URI:
   `https://<your-domain>/api/v1/schedule/google/callback`
4. On Railway set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
   `GOOGLE_REDIRECT_URL` (the same URI as step 3).
