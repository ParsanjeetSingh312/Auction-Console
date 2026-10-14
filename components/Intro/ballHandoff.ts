/**
 * ballHandoff.ts
 * Where the delivery opening hands its ball to the landing's trophy.
 *
 * The film's last beat crosses two WebGL canvases: the ball falls out of the
 * night sky in the stadium's canvas, behind the page, and comes to rest on the
 * trophy's cradle, in the trophy's own canvas, on the page. Neither owns the
 * other, so they meet here:
 *
 * - The opening sets the phase to "awaiting" before the landing renders, so
 *   the hero holds back its wordmark and the trophy holds back its ball.
 * - The trophy attaches a socket: where its ball sits on screen and how big,
 *   and a `receive` that sets the ball into the cradle.
 * - The opening flies its ball to that point ("falling"), calls `receive` the
 *   frame it arrives and sets the phase to "landed"; the wordmark comes in.
 *
 * Anything that goes wrong — no WebGL, reduced motion, a skip, a trophy that
 * never attaches — ends in "landed" with the ball simply in place.
 */
import { useSyncExternalStore } from "react";

export type HandoffPhase = "idle" | "awaiting" | "falling" | "landed";

export interface TrophySocket {
  /** The ball's centre in viewport pixels and its radius, or null if unseen. */
  locate(): { x: number; y: number; r: number } | null;
  /** Set the ball into the cradle; `instant` skips the arrival. */
  receive(options?: { instant?: boolean }): void;
}

let phase: HandoffPhase = "idle";
let socket: TrophySocket | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const ballHandoff = {
  phase: () => phase,
  setPhase(next: HandoffPhase) {
    if (phase === next) return;
    phase = next;
    emit();
  },
  /** Ball held back: the hero hides its wordmark, the trophy its ball. */
  holding: () => phase === "awaiting" || phase === "falling",
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  attach(next: TrophySocket) {
    socket = next;
    emit();
    return () => {
      if (socket === next) {
        socket = null;
        emit();
      }
    };
  },
  socket: () => socket,
};

if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __handoff?: unknown }).__handoff = ballHandoff;

export function useHandoffPhase() {
  return useSyncExternalStore(ballHandoff.subscribe, ballHandoff.phase, ballHandoff.phase);
}
