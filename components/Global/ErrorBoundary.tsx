/**
 * ErrorBoundary.tsx
 * Keeps one broken component from taking the auction down with it.
 *
 * **Why this exists.** React has no recovery from an error thrown during
 * render: it unmounts the entire tree from the root and leaves a blank page.
 * That is the correct default for an application where a render fault means the
 * state is untrustworthy, and the wrong one here — SCOUT is an advisory panel
 * floating over a live auction, and a fault in it has no bearing on whether the
 * room can still take bids. A blank page during a lot is a far worse outcome
 * than a panel that says it broke.
 *
 * **It catches render faults, not network faults.** This is worth being precise
 * about, because the two get conflated. A failed `fetch` is already handled —
 * `streamAdvice` throws a `RagError`, `useScoutOrchestrator` catches it into an
 * `error` state and the drawer renders it as a message. An error boundary never
 * sees that and never should. What it catches is the other thing: a component
 * throwing while producing its output — reading a property off an undefined
 * payload, a malformed response that slipped past its type, a bad index. Those
 * are the ones that currently blank the page.
 *
 * **It cannot catch a dead server.** The backend serves the compiled frontend
 * out of `dist/` as well as the API, so if uvicorn exits there is no page left
 * to render and no JavaScript left running. That failure looks like "the whole
 * site crashed" and no amount of frontend code can defend against it; the fix
 * is upstream, in whatever stopped the process.
 *
 * A class component because `getDerivedStateFromError` and `componentDidCatch`
 * have no hook equivalents. React still has no function-component API for this.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * What is being guarded, in words, for the fallback copy — "SCOUT", "the
   * player pool". Named rather than generic so a user can tell which part of
   * the page is missing and which parts they can still trust.
   */
  label: string;
  /**
   * Rendered instead of the default notice. Pass `null` to fail silently,
   * which is right for purely decorative subtrees where a visible error box
   * would be more alarming than the absence it reports.
   */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Logged rather than swallowed. The fallback tells the user something
    // broke; the console is where whoever fixes it finds out what.
    console.error(
      `[${this.props.label}] crashed and was contained:`,
      error,
      info.componentStack,
    );
  }

  /**
   * Try again.
   *
   * Clearing the error re-renders the children from scratch. That is genuinely
   * worth offering rather than requiring a page reload: most faults here come
   * from one bad payload, and the next attempt gets a different one. If it
   * throws again the boundary simply catches it again.
   */
  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    const { children, label, fallback } = this.props;

    if (!error) return children;
    if (fallback !== undefined) return fallback;

    return (
      <div
        role="alert"
        className="fixed bottom-24 right-6 z-40 w-[min(22rem,calc(100vw-3rem))] rounded-xl border border-auctiq-out/40 bg-auctiq-card/95 p-4 shadow-glass backdrop-blur-xl"
      >
        <div className="font-auctiq text-[12px] tracking-[0.12em] text-auctiq-out">
          {label} stopped responding
        </div>
        <p className="mt-1.5 font-tech text-[11.5px] leading-relaxed text-auctiq-dim">
          The rest of the page is unaffected — the auction, the pool and your
          purse are all still live.
        </p>
        <button
          type="button"
          onClick={this.reset}
          className="mt-3 rounded-lg border border-white/15 px-3 py-1.5 font-tech text-[10.5px] font-semibold uppercase tracking-[0.12em] text-auctiq-dim transition-colors hover:border-cyan-400/45 hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
        >
          Try again
        </button>
      </div>
    );
  }
}
