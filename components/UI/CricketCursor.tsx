/**
 * CricketCursor.tsx
 * The pointer, as a cricket ball.
 *
 * **This is not the prototype's version, and the difference is deliberate.**
 * `EasterEggs.tsx` there renders a ball that *trails* the arrow at a 0.12 lag —
 * decoration alongside a real cursor. Replacing the arrow changes what the
 * element is for: a lagging cursor is actively bad, because the click lands
 * where the pointer is and the user is aiming the ball. So the ball tracks the
 * pointer exactly, and a second, softer disc lags behind it. The trail keeps
 * the dragged-along feel; the ball keeps the accuracy.
 *
 * **Affordance has to survive.** The arrow is not only a position, it is a
 * signal: it changes shape over links and over text. Hiding it throws that away
 * unless something replaces it, so the ball grows over anything clickable, and
 * the native caret is left alone over inputs and textareas — losing the I-beam
 * in a search field is a real usability cost for no visual gain.
 *
 * **It is off wherever it would be wrong**: a coarse pointer has no cursor to
 * replace, reduced motion means no chasing elements, and the effect is scoped
 * to the landing rather than following the user into the console, where a
 * bouncing ball over a live auction grid would be a distraction during bidding.
 *
 * Positioned by writing `transform` straight to the node on an animation frame.
 * Pointer position changes faster than React should ever re-render.
 */
import { useEffect, useRef } from "react";

import { useReducedMotion } from "framer-motion";

/** How much of the remaining distance the trail closes each frame. */
const TRAIL_EASE = 0.18;

/** Anything that should make the ball grow. */
const INTERACTIVE = 'a, button, [role="button"], input, select, textarea, label, summary, [tabindex]:not([tabindex="-1"])';

export default function CricketCursor() {
  const ball = useRef<HTMLDivElement>(null);
  const trail = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion() ?? false;

  useEffect(() => {
    if (reduced) return;
    // A touch device has no pointer to replace, and `pointermove` there fires
    // only while dragging — the ball would sit in a corner until first touch.
    if (window.matchMedia("(pointer: coarse)").matches) return;

    const ballNode = ball.current;
    const trailNode = trail.current;
    if (!ballNode || !trailNode) return;

    document.documentElement.classList.add("auctiq-ball-cursor");

    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;
    let trailX = x;
    let trailY = y;
    let scale = 1;
    let wantScale = 1;
    let visible = false;

    const onMove = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (!visible) {
        visible = true;
        ballNode.style.opacity = "1";
        trailNode.style.opacity = "1";
      }
      wantScale = (event.target as Element | null)?.closest?.(INTERACTIVE) ? 1.7 : 1;
    };

    // Squash on press, release on lift. The ball is the click, so it should
    // answer the click.
    const onDown = () => {
      wantScale *= 0.62;
    };
    const onUp = () => {
      wantScale = wantScale / 0.62;
    };

    // Leaving the window should take the ball with it, or it parks at the edge
    // and looks stuck.
    const onLeave = () => {
      visible = false;
      ballNode.style.opacity = "0";
      trailNode.style.opacity = "0";
    };

    let frame = requestAnimationFrame(function loop() {
      trailX += (x - trailX) * TRAIL_EASE;
      trailY += (y - trailY) * TRAIL_EASE;
      scale += (wantScale - scale) * 0.22;

      ballNode.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${scale})`;
      trailNode.style.transform = `translate3d(${trailX}px, ${trailY}px, 0) translate(-50%, -50%) scale(${scale * 0.9})`;
      frame = requestAnimationFrame(loop);
    });

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    window.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("pointerleave", onLeave);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointerleave", onLeave);
      document.documentElement.classList.remove("auctiq-ball-cursor");
    };
  }, [reduced]);

  if (reduced) return null;

  return (
    <>
      <style>{`
        /*
          Hide the native arrow, but not the text caret. An I-beam over a search
          field is information; losing it costs more than the ball gains.
          Scoped to a class this component adds and removes, so nothing is left
          behind if it unmounts.
        */
        .auctiq-ball-cursor,
        .auctiq-ball-cursor *:not(input):not(textarea) { cursor: none !important; }
        @media (pointer: coarse) {
          .auctiq-ball-cursor, .auctiq-ball-cursor * { cursor: auto !important; }
        }
      `}</style>

      {/* The soft disc that lags behind. Purely the sense of weight. */}
      <div
        ref={trail}
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 z-[60] h-7 w-7 rounded-full opacity-0"
        style={{
          background:
            "radial-gradient(circle at 50% 50%, rgba(212,64,79,0.30), rgba(212,64,79,0) 70%)",
          transition: "opacity 200ms ease",
          willChange: "transform",
        }}
      />

      {/* The ball itself, exactly on the pointer. */}
      <div
        ref={ball}
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 z-[61] h-[17px] w-[17px] rounded-full opacity-0"
        style={{
          background:
            "radial-gradient(circle at 32% 28%, #d4404f, #7d1622 72%, #4a0d14)",
          boxShadow: "0 0 14px -2px rgba(212,64,79,0.75)",
          transition: "opacity 200ms ease",
          willChange: "transform",
        }}
      >
        {/* The seam. Two dashed arcs are what make a red dot read as a ball. */}
        <span
          className="absolute rounded-full"
          style={{
            inset: "3px 2px",
            borderTop: "1px dashed rgba(242,226,196,0.85)",
            borderBottom: "1px dashed rgba(242,226,196,0.85)",
          }}
        />
      </div>
    </>
  );
}
