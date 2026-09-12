/**
 * Placeholder.tsx
 * A route that exists but is not built yet.
 *
 * Deliberately says which file comes next rather than "coming soon". A
 * placeholder that names its own replacement is a to-do list you cannot lose,
 * and it stops a half-built route being mistaken for a broken one during
 * testing. Delete this file when the last stub is replaced.
 */
import { Link } from "react-router-dom";

export interface PlaceholderProps {
  title: string;
  blurb: string;
  /** The file or sequence that will replace this route. */
  step: string;
}

export default function Placeholder({ title, blurb, step }: PlaceholderProps) {
  return (
    <div className="grid min-h-screen place-items-center bg-surface bg-dots px-5">
      <div className="w-full max-w-lg rounded-xl border border-line bg-surface-card p-6 shadow-soft">
        <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
          Scaffolding
        </span>
        <h1 className="mt-1.5 font-head text-[24px] font-bold leading-tight text-slate-ink">
          {title}
        </h1>
        <p className="mt-2 font-ui text-[12.5px] leading-relaxed text-slate-muted">{blurb}</p>

        <div className="mt-4 rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
          <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.14em] text-slate-faint">
            Up next
          </span>
          <code className="mt-1 block font-mono text-[11.5px] text-slate-body">{step}</code>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-4">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-card px-3.5 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
          >
            ← AUCTIQ
          </Link>
          {/*
            The working console, one click away. While these stubs stand it is
            the only route that actually runs an auction, and sending someone
            back to the landing to find it is a waste of their time.
          */}
          <Link
            to="/console"
            className="font-ui text-[11px] text-slate-muted underline-offset-2 transition-colors hover:text-slate-ink hover:underline"
          >
            Open the Phase 2/3 console instead
          </Link>
        </div>
      </div>
    </div>
  );
}
