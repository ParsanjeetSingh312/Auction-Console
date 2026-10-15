/**
 * StatCounter.tsx
 * A card figure that counts up with GSAP the first time its card is seen.
 *
 * Two rules from this repository's own history decide the shape:
 *
 * * **The final value is in the DOM from the first render.** GSAP only writes
 *   the text on a tick, so in any frame where requestAnimationFrame never runs
 *   (a hidden tab, a headless capture) the figure simply shows its real value.
 *   A counter that started at "0" in markup would fail closed and show zeros.
 * * **No React state per frame.** The tween writes `textContent` directly; a
 *   grid of two hundred cards counting at once would otherwise push thousands
 *   of renders through the reconciler.
 *
 * One IntersectionObserver is shared by every counter on the page.
 */
import { useEffect, useRef } from "react";
import gsap from "gsap";

import type { CardStat } from "../../console/aucteamApi";

export function formatStat(value: number | null, format: CardStat["format"]): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (format === "dec2") return value.toFixed(2);
  if (format === "dec1") return value.toFixed(1);
  return Math.round(value).toLocaleString("en-IN");
}

const reduced =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

type Play = () => void;
const pending = new WeakMap<Element, Play>();
let observer: IntersectionObserver | null = null;

function watch(el: Element, play: Play): () => void {
  if (typeof IntersectionObserver === "undefined") return () => undefined;
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        pending.get(entry.target)?.();
        pending.delete(entry.target);
        observer?.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  pending.set(el, play);
  observer.observe(el);
  return () => {
    pending.delete(el);
    observer?.unobserve(el);
  };
}

interface StatCounterProps {
  value: number | null;
  format: CardStat["format"];
  /** Seconds. Short: the figure is read, not watched. */
  duration?: number;
  delay?: number;
  className?: string;
}

export default function StatCounter({
  value,
  format,
  duration = 1.1,
  delay = 0,
  className,
}: StatCounterProps) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || value === null || !Number.isFinite(value) || reduced) return;

    let tween: gsap.core.Tween | null = null;
    const play = () => {
      const counter = { n: 0 };
      tween = gsap.to(counter, {
        n: value,
        duration,
        delay,
        ease: "power3.out",
        onUpdate: () => {
          el.textContent = formatStat(counter.n, format);
        },
        onComplete: () => {
          el.textContent = formatStat(value, format);
        },
      });
    };
    const stop = watch(el, play);
    return () => {
      stop();
      tween?.kill();
      el.textContent = formatStat(value, format);
    };
  }, [value, format, duration, delay]);

  return (
    <dd ref={ref as React.RefObject<HTMLElement>} className={className}>
      {formatStat(value, format)}
    </dd>
  );
}
