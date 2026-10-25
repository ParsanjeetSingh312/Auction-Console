# AUCTONIQ — Data Interface, About, Live Bidding and the next auction

**Date:** 2026-10-25
**Order:** backend first (room lifecycle), then frontend, one file at a time.
**Loop:** after each change, check it in the browser. If it looks right, move
on; if not, rewrite the instruction for that step and fix it before going on.

---

## 1. Data Interface — no "Put on the block"

The player card (`components/Console/PlayerCard.tsx`) is shared by the Data
Interface and the auctioneer's console. The Data Interface is read-only, so the
button is removed there only; the auctioneer still needs it to run lots.

| File | Change |
|---|---|
| `components/Console/PlayerCard.tsx` | New `canPutOnBlock` prop, default on. |
| `components/Console/DataDashboard.tsx` | Passes `canPutOnBlock={false}`. |

## 2. About — disclaimer at the top

| File | Change |
|---|---|
| `pages/About.tsx` | The "For the love of the game. Not for gambling." block moves from the bottom to directly under the hero. Its markup and classes move unchanged, so the font, colours and backdrop are the same. |

## 3. Live Bidding — no SCOUT

The floating SCOUT logo, its drawer and its keyboard shortcut are mounted
app-wide in `App.tsx` (`GlobalScout`). They are left out on the Live Bidding
routes (`/auction`, `/auction/live`, `/auction/demo`), so nobody in an auction
room can consult the assistant mid-lot. Every other page — Home, Data
Interface, AUCTEAM, About — keeps SCOUT.

| File | Change |
|---|---|
| `App.tsx` | `GlobalScout` keeps the drawer, launcher and hotkey off the Live Bidding routes. |

## 4. The next auction — a fresh room code

**Today:** when an auction finishes, "Leave seat" reloads into the same room's
seat picker ("The chair is taken"), and the only way to run another auction is
to reset the old room or leave and create one by hand.

**After:** the auctioneer gets **Start a new auction** on the report. It
generates a fresh room code, closes the finished room, and opens the new one,
so the auctioneer lands in a new lobby with the new code to share. Everyone
else in the old room is told the auction has closed and sent to the room-code
entry, with the new code filled in. "Leave" after an auction goes to the
room-code entry, not to the finished room's seats.

Backend:

| File | Change |
|---|---|
| `auction/schemas.py` | `NewAuction` client message: `{type: "new_auction", next_room: <code>}`. |
| `auction/rooms.py` | `RoomRegistry.close(code)`: removes a room (never MAIN) and runs the close hooks. |
| `auction/ws.py` | Auctioneer only, finished rooms only: tells everyone `room_closed` with the next code, closes their sockets, closes the room. MAIN is reset instead, because it is never closed. |
| `tests/test_auction_rooms.py` | Start a new auction: the room closes, franchises get the code, others are refused. |

Frontend:

| File | Change |
|---|---|
| `hooks/useAuctionSocket.ts` | `startNewAuction()`, and the `room_closed` message. |
| `pages/LiveAuction.tsx` | On `room_closed`: the auctioneer is taken into the new room; everyone else goes to the room-code entry with the new code filled in. Leaving a finished room goes to the entry. |
| `components/Auction/PostAuctionReport.tsx` | A "Start a new auction" button for the auctioneer. |
| `components/Auction/RoomGate.tsx` | Shows the new code that was handed over. |

## 5. Verification

* Backend: the auction room test suites, plus the new tests.
* Browser: the Data Interface card, the About page, a Live Bidding page with no
  SCOUT, and a full finish → new auction cycle.
* Commit and push once everything above checks out.
