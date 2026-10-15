/**
 * dropZone.ts
 * Where the board is, for cards being dragged towards it.
 *
 * Framer Motion's drag has no notion of a drop target, so the board registers
 * its element here and a card asks, at the pointer's position, whether it is
 * over it. Measured on demand rather than cached: the board is sticky and the
 * page scrolls under a drag, so a rectangle taken at drag start goes stale.
 */
let board: HTMLElement | null = null;

export function registerBoard(el: HTMLElement | null): void {
  board = el;
}

export function overBoard(x: number, y: number): boolean {
  if (!board) return false;
  const r = board.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Viewport coordinates from whichever pointer event Framer hands over. */
export function pointOf(event: MouseEvent | TouchEvent | PointerEvent): { x: number; y: number } | null {
  if ("changedTouches" in event && event.changedTouches.length) {
    const t = event.changedTouches[0];
    return { x: t.clientX, y: t.clientY };
  }
  if ("clientX" in event) return { x: event.clientX, y: event.clientY };
  return null;
}
