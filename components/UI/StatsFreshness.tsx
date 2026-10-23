/**
 * StatsFreshness.tsx
 * "IPL career stats through 2026 · refreshed 23 Oct" -- the age of every
 * figure on the surface it sits on.
 *
 * Shown in the data room, the SCOUT drawer and on the live block, so a number
 * a franchise bids on always says how current it is. Renders nothing until the
 * first quarterly refresh has run, rather than a badge with no date in it.
 *
 * GSAP sweeps a light across the badge when the reading changes (a refresh
 * landing while the page is open); `tone` matches the surface: "light" for
 * the white console, "dark" for the night-theme broadcast surfaces.
 */
import gsap from "gsap";
import { useEffect, useRef } from "react";

import { describeFreshness, useStatsStatus } from "../../console/statsApi";

export default function StatsFreshness({
  tone = "light",
  className = "",
}: {
  tone?: "light" | "dark";
  className?: string;
}) {
  const status = useStatsStatus();
  const label = describeFreshness(status);
  const ref = useRef<HTMLSpanElement>(null);
  const sheen = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!label || !ref.current || !sheen.current) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(ref.current, { autoAlpha: 0, y: 3 }, { autoAlpha: 1, y: 0, duration: 0.35, ease: "power2.out" });
      gsap.fromTo(sheen.current, { xPercent: -120 }, { xPercent: 220, duration: 1.1, ease: "power2.inOut", delay: 0.15 });
    });
    return () => ctx.revert();
  }, [label]);

  if (!label) return null;

  const running = status?.running;
  const palette =
    tone === "dark"
      ? "border-white/10 bg-white/[0.04] text-slate-300"
      : "border-line bg-surface-sunken text-slate-muted";

  return (
    <span
      ref={ref}
      className={`relative inline-flex items-center gap-1.5 overflow-hidden rounded-full border px-2.5 py-0.5 font-ui text-[9.5px] font-semibold uppercase tracking-[0.1em] ${palette} ${className}`}
      title={
        status?.last_match_date
          ? `Career figures computed from every IPL match up to ${status.last_match_date}. Refreshed every quarter.`
          : "Career figures refreshed every quarter."
      }
      data-testid="stats-freshness"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${running ? "animate-pulse bg-amber-400" : "bg-emerald-500"}`}
        aria-hidden
      />
      {running ? "Refreshing stats…" : label}
      <span
        ref={sheen}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/40 to-transparent opacity-60"
      />
    </span>
  );
}
