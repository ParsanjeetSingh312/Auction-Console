/**
 * claimBurst.ts
 * The moment a pass is claimed: sparks burst from the Claim button, a
 * "+1 Gold pass" rises out of them, and one bright spark arcs into the bell
 * (anything marked `data-wallet-target`), which rings when it lands.
 *
 * Imperative and fire-and-forget: the burst lives in its own node on <body>,
 * outside any component, and removes itself when its GSAP timeline ends, so
 * the toast or panel that fired it can unmount mid-flight without leaving
 * anything behind.
 */
import gsap from "gsap";

import { claim } from "../../console/ecosystemStore";
import type { Notice, PassKind } from "../../console/ecosystemStore";

const SPARKS: Record<PassKind, string[]> = {
  A: ["#fff3c4", "#f6c45a", "#e3b23c", "#ffffff", "#ffd36b"],
  D: ["#e7f0ff", "#4d8df6", "#22d3ee", "#ffffff", "#93bbff"],
};

/** Fired on window when the flying spark reaches the bell. */
export const WALLET_PULSE = "auctoniq:wallet-pulse";

export function claimBurst(from: Element, kind: PassKind, quantity: number): void {
  const box = from.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const host = document.createElement("div");
  host.className = "claim-burst";
  host.style.transform = `translate(${x}px, ${y}px)`;
  const colours = SPARKS[kind];
  const sparks: HTMLElement[] = [];
  for (let i = 0; i < (reduced ? 0 : 26); i++) {
    const spark = document.createElement("i");
    spark.style.background = colours[i % colours.length];
    spark.style.boxShadow = `0 0 8px ${colours[i % colours.length]}`;
    host.appendChild(spark);
    sparks.push(spark);
  }
  const label = document.createElement("b");
  label.textContent = `+${quantity} ${kind === "A" ? "Gold" : "Blue"} pass${quantity === 1 ? "" : "es"}`;
  label.style.color = kind === "A" ? "#F6C45A" : "#93BBFF";
  host.appendChild(label);
  document.body.appendChild(host);

  const timeline = gsap.timeline({ onComplete: () => host.remove() });
  timeline
    .fromTo(label, { y: 0, scale: 0.6, autoAlpha: 0 }, { y: -48, scale: 1, autoAlpha: 1, duration: 0.5, ease: "back.out(2.2)" }, 0)
    .to(label, { y: -76, autoAlpha: 0, duration: 0.45, ease: "power1.in" }, 1.05);

  if (sparks.length) {
    timeline
      .to(
        sparks,
        {
          x: () => gsap.utils.random(-130, 130),
          y: () => gsap.utils.random(-120, 30),
          rotation: () => gsap.utils.random(-360, 360),
          scale: () => gsap.utils.random(0.5, 1.5),
          duration: 0.85,
          ease: "expo.out",
        },
        0,
      )
      .to(sparks, { y: "+=70", autoAlpha: 0, duration: 0.6, ease: "power1.in", stagger: 0.01 }, 0.45);
  }

  // One spark carries the pass home to the bell.
  const target = document.querySelector("[data-wallet-target]");
  if (!target || reduced) return;
  const end = target.getBoundingClientRect();
  const carrier = document.createElement("i");
  carrier.style.cssText = `width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:${colours[1]};box-shadow:0 0 14px 4px ${colours[1]}`;
  host.appendChild(carrier);
  const dx = end.left + end.width / 2 - x;
  const dy = end.top + end.height / 2 - y;
  timeline
    // x and y on different eases make the path an arc rather than a line.
    .to(carrier, { x: dx, duration: 0.75, ease: "power2.in" }, 0.2)
    .to(carrier, { y: dy, duration: 0.75, ease: "back.in(1.4)" }, 0.2)
    .to(carrier, { scale: 0.3, duration: 0.2, onComplete: () => void window.dispatchEvent(new Event(WALLET_PULSE)) }, 0.9)
    .to(carrier, { autoAlpha: 0, duration: 0.1 }, 1.1);
}

/**
 * Claim a gift and celebrate it. A bench notice (negative id, from
 * pushLocal) only celebrates. Returns the refusal to show, or null.
 */
export async function claimWithBurst(button: Element, notice: Notice): Promise<string | null> {
  const gift = notice.gift;
  if (!gift) return null;
  try {
    if (gift.id > 0) await claim(gift.id);
    claimBurst(button, gift.kind, gift.quantity);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not claim that.";
  }
}
