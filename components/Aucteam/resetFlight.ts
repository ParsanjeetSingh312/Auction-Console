/**
 * resetFlight.ts
 * Reset, with every pick flown home.
 *
 * Pressing Reset should look like what it does: the eleven players leave the
 * team sheet and go back to their own cards in the pool. So before the state
 * clears, each filled slot is copied into a fixed-position ghost, the real
 * slot is hidden, and GSAP flies the ghost along a curve (x eased in-out, y
 * eased in, which bends the path) to the centre of that player's card. The
 * card glows as its player lands. Only then does `resetBuild()` clear the
 * board and the report.
 *
 * Details that keep it honest:
 *
 * * The ghosts live inside `.aucteam`, not on <body>, so they keep the tier
 *   colours and type that are scoped to the page.
 * * A player whose card is not on screen (filtered out, or below "Show more")
 *   flies to the pool and fades rather than to a guessed spot.
 * * The board is scrolled into view first when the reset is pressed from the
 *   report further down, so the flight is something the user actually sees.
 * * If requestAnimationFrame never ticks (a backgrounded tab), a timeout
 *   finishes the reset anyway: the animation is decoration, the reset is not.
 * * Reduced motion: the reset happens at once, no flight.
 */
import gsap from "gsap";

import { getAucteamState, resetBuild } from "../../console/aucteamStore";

const FLIGHT = 0.8;
const STAGGER = 0.055;
let running = false;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Resolves once the page has stopped scrolling, or after `maxMs`. */
async function scrollSettled(maxMs = 1000): Promise<void> {
  const start = performance.now();
  let last = window.scrollY;
  let still = 0;
  while (performance.now() - start < maxMs) {
    await sleep(50);
    if (Math.abs(window.scrollY - last) < 1) {
      still += 1;
      if (still >= 3) return;
    } else {
      still = 0;
      last = window.scrollY;
    }
  }
}

export async function resetWithFlight(): Promise<void> {
  if (running) return;
  if (getAucteamState().roster.length === 0 || prefersReducedMotion()) {
    resetBuild();
    return;
  }

  const page = document.querySelector<HTMLElement>(".aucteam");
  const layout = document.querySelector<HTMLElement>(".aq-layout");
  if (!page || !layout) {
    resetBuild();
    return;
  }

  running = true;
  const layer = document.createElement("div");
  layer.className = "aq-flight-layer";
  try {
    // 1. Bring the team sheet and the pool into view.
    const target = layout.getBoundingClientRect().top + window.scrollY - 96;
    if (Math.abs(window.scrollY - target) > 40) {
      window.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
      await scrollSettled();
    }

    page.appendChild(layer);
    const slots = Array.from(document.querySelectorAll<HTMLElement>(".aq-slot[data-player-id]"));
    const pool = document.querySelector<HTMLElement>(".aq-grid");
    const tl = gsap.timeline();

    slots.forEach((slot, i) => {
      const id = slot.dataset.playerId;
      const from = slot.getBoundingClientRect();
      const card = id
        ? document.querySelector<HTMLElement>(`.aq-card-wrap[data-card-id="${id}"]`)
        : null;
      const cardRect = card?.getBoundingClientRect();
      const onScreen =
        !!cardRect && cardRect.bottom > 0 && cardRect.top < window.innerHeight && cardRect.width > 0;
      const to = onScreen ? cardRect! : pool?.getBoundingClientRect();

      const ghost = slot.cloneNode(true) as HTMLElement;
      ghost.classList.add("aq-ghost");
      ghost.removeAttribute("data-player-id");
      Object.assign(ghost.style, {
        position: "fixed",
        left: `${from.left}px`,
        top: `${from.top}px`,
        width: `${from.width}px`,
        height: `${from.height}px`,
        margin: "0",
        transform: "none",
      });
      layer.appendChild(ghost);
      slot.style.visibility = "hidden";

      const at = i * STAGGER;
      if (!to) {
        tl.to(ghost, { opacity: 0, duration: 0.3 }, at);
        return;
      }
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + Math.min(to.height, 180) / 2 - (from.top + from.height / 2);

      // A lift out of the slot, then the flight: x and y on different eases
      // bend the straight line into an arc.
      tl.to(ghost, { scale: 1.06, boxShadow: "0 18px 40px rgba(0,0,0,0.55)", duration: 0.16, ease: "power2.out" }, at)
        .to(ghost, { x: dx, duration: FLIGHT, ease: "power2.inOut" }, at + 0.12)
        .to(ghost, { y: dy, duration: FLIGHT, ease: "power2.in" }, at + 0.12)
        .to(ghost, { scale: 0.5, rotation: (i % 2 ? 1 : -1) * 6, duration: FLIGHT, ease: "power1.in" }, at + 0.12)
        .to(ghost, { opacity: 0, duration: 0.18, ease: "power1.in" }, at + 0.12 + FLIGHT - 0.14);

      if (onScreen && card) {
        tl.call(
          () => {
            card.classList.remove("aq-card-wrap--home");
            // Restart the CSS glow even if this card glowed a moment ago.
            void card.offsetWidth;
            card.classList.add("aq-card-wrap--home");
            window.setTimeout(() => card.classList.remove("aq-card-wrap--home"), 900);
          },
          undefined,
          at + 0.12 + FLIGHT - 0.1,
        );
      }
    });

    const total = (slots.length * STAGGER + FLIGHT + 0.4) * 1000;
    await Promise.race([tl.then(() => undefined), sleep(total + 800)]);
    tl.kill();
  } finally {
    resetBuild();
    layer.remove();
    running = false;
  }
}
