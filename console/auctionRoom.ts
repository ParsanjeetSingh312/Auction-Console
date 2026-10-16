/**
 * auctionRoom.ts
 * Which auction room this tab is in.
 *
 * The server runs several auctions at once, each under a room code
 * (`auction/rooms.py`), each with its own chair, seats, purses and broadcasts.
 * The auctioneer creates a room from Live Bidding and logs in; the code shows
 * on their control panel, and they send it to the franchise owners by other
 * means. Each franchise types it in to join. Every room the app creates seats
 * twelve franchises, which covers a ten-team auction too: the last two seats
 * simply stay empty.
 *
 * **The code is kept out of sight.** Only the auctioneer's control panel shows
 * it. Not the page anyone else sees, and not the address bar, where a shared
 * screen or a stream of the auction would show it. The room this tab is in is
 * held in sessionStorage: it survives a refresh, belongs to this tab alone,
 * and goes when the tab closes. Every caller below (the socket, the report,
 * SCOUT) reads it from here.
 *
 * A tab starts in no room at all, at the Live Bidding entry (create a room or
 * join one). MAIN, the default room the site had before there were rooms, is
 * still there to choose.
 *
 * Moving rooms happens in place: `enterRoom` and `leaveRoom` tell the
 * subscribers (`useRoom`), and the socket reconnects to the new room without a
 * page load -- which is what lets "create a room and log in" be one step.
 */
import { useSyncExternalStore } from "react";

/** The server's default room. */
export const DEFAULT_ROOM = "MAIN";

const STORAGE_KEY = "auctoniq:room";

// The server's rule (ROOM_CODE in auction/rooms.py): a letter or digit, then up
// to 23 letters, digits or dashes.
const ROOM_CODE = /^[A-Z0-9][A-Z0-9-]{0,23}$/;

// No 0/O or 1/I/L, so a code read out over a call is typed correctly.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface StoredRoom {
  code: string;
  /**
   * This tab created the room, so its connection may open it. Absent when the
   * code was typed in, so joining can never open a room by mistake -- the
   * server refuses a code nobody opened rather than seating someone alone in
   * an empty auction.
   */
  creating?: boolean;
}

/** A code as the server keys it, or null if it is not a valid one. */
export function normaliseRoomCode(raw: string | null | undefined): string | null {
  const code = (raw ?? "").trim().toUpperCase();
  return ROOM_CODE.test(code) ? code : null;
}

/** A fresh six-character room code. */
export function newRoomCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/* ------------------------------------------------------------ storage -- */

// Where the room lives if sessionStorage is unavailable (a locked-down
// browser): this page load only.
let memory: StoredRoom | null = null;

function read(): StoredRoom | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return memory;
    const parsed = JSON.parse(raw) as StoredRoom;
    const code = normaliseRoomCode(parsed.code);
    return code ? { code, creating: parsed.creating === true || undefined } : null;
  } catch {
    return memory;
  }
}

function write(room: StoredRoom | null): void {
  memory = room;
  try {
    if (room) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(room));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Kept in memory for this page load instead.
  }
}

/*
  An address that carries ?room= is honoured once, as a typed-in code: the
  room is taken into this tab and the code is stripped from the address bar.
*/
if (typeof window !== "undefined") {
  const url = new URL(window.location.href);
  if (url.searchParams.has("room")) {
    const code = normaliseRoomCode(url.searchParams.get("room"));
    if (code) write({ code });
    url.searchParams.delete("room");
    url.searchParams.delete("kind");
    window.history.replaceState(window.history.state, "", url.toString());
  }
}

/**
 * The room this tab is in. `chosen` is false at the entry screen, before the
 * tab has created or joined anything; `code` is null in the default room;
 * `creating` while this tab has created the room and not yet taken its chair.
 */
export function currentRoom(): { code: string | null; chosen: boolean; creating: boolean } {
  if (typeof window === "undefined") return { code: null, chosen: false, creating: false };
  const room = read();
  return {
    code: room && room.code !== DEFAULT_ROOM ? room.code : null,
    chosen: room !== null,
    creating: room?.creating === true,
  };
}

/**
 * `url` with this tab's room added to its query. Unchanged in the default
 * room. `open=1` goes too when this tab created the room: a connection that
 * says so may open it; one that does not may only join a room already open.
 */
export function withRoom(url: string): string {
  if (typeof window === "undefined") return url;
  const room = read();
  if (!room || room.code === DEFAULT_ROOM) return url;
  const join = url.includes("?") ? "&" : "?";
  return `${url}${join}room=${encodeURIComponent(room.code)}${room.creating ? "&open=1" : ""}`;
}

/* ------------------------------------------------------------ changes -- */

const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One string per room, so React can tell when it has changed. */
function roomKey(): string {
  const room = typeof window === "undefined" ? null : read();
  return room ? `${room.code}|${room.creating ? "open" : ""}` : "";
}

/** The room this tab is in, re-rendering when it changes. */
export function useRoom(): ReturnType<typeof currentRoom> & { key: string } {
  const key = useSyncExternalStore(subscribe, roomKey, () => "");
  return { ...currentRoom(), key };
}

/** Create a room under a fresh code and move this tab into it. */
export function createRoom(): string {
  const code = newRoomCode();
  write({ code, creating: true });
  changed();
  return code;
}

/**
 * The auctioneer has the chair of the room this tab created: from here on it
 * is an ordinary room, and a refused login after a refresh is just a refused
 * login, not a failed creation.
 */
export function markRoomClaimed(): void {
  const room = read();
  if (!room?.creating) return;
  write({ code: room.code });
  changed();
}

/** Join a room by its code (or the default room) and move this tab into it. */
export function enterRoom(code: string): void {
  write({ code });
  changed();
}

/** Out of the room, back to the Live Bidding entry. */
export function leaveRoom(): void {
  write(null);
  changed();
}
