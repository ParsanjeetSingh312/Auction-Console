/**
 * App.tsx
 * AUCTIQ's route table.
 *
 * Phase 3 chose the view with a query string, because there were two views and
 * a router would have been more machinery than that choice deserved. Phase 4
 * has five destinations, two of them role-gated, and one of them a room a user
 * is invited into by URL — so the addressing now has to be real.
 *
 *   /                the welcome page: pick an interface
 *   /auctiq          the dark AUCTIQ landing, in progress
 *   /data            read-only analytics — pool, teams, SCOUT. No block.
 *   /auction         the live room: auctioneer or franchise
 *   /auction/demo    the standalone war-room on its mock feed (Phase 3)
 *   /console         the unified Phase 2/3 console, unchanged
 *
 * `/console` and `/auction/demo` are kept deliberately. They are the Phase 2
 * and Phase 3 deliverables and they still work; the new routes sit beside them
 * rather than on top of them.
 *
 * BrowserRouter rather than HashRouter: real paths survive a refresh in
 * production because the FastAPI app already answers any unmatched path with
 * index.html (see api/main.py, `serve_console`), and Vite does the same in dev.
 * Nothing needs to change on the server for these routes to resolve.
 *
 * Every destination except the landing is lazy. The console alone pulls the
 * auction engine, GSAP, and eleven view components; the landing is the first
 * paint every user gets and has no business waiting on that bundle.
 */
import { lazy, Suspense } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import Home from "./pages/Home";

// The dark AUCTIQ landing, under construction. Built alongside `/`
// rather than over it, so the working white landing stays working; it
// is promoted to `/` when Phase 4 signs off.
const Auctiq = lazy(() => import("./pages/Auctiq"));
const DataRoom = lazy(() => import("./pages/DataRoom"));
const LiveAuction = lazy(() => import("./pages/LiveAuction"));
const AuctionConsole = lazy(() => import("./components/Console/AuctionConsole"));
const AuctionBlock = lazy(() => import("./components/Auction/AuctionBlock"));

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<LandingOrLegacy />} />
          <Route path="/auctiq" element={<Auctiq />} />
          <Route path="/data" element={<DataRoom />} />
          <Route path="/auction" element={<LiveAuction />} />
          <Route path="/auction/demo" element={<BlockDemo />} />
          <Route path="/console" element={<AuctionConsole />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

/**
 * The landing, with the Phase 3 URLs still honoured.
 *
 * `/?view=block` was how the war room was reached for the whole of Phase 3, so
 * it is likely to be sitting in a bookmark or a browser's address bar
 * autocomplete. It forwards to the demo route with its parameters intact rather
 * than silently showing the welcome page, which would look like the feature had
 * been removed.
 */
function LandingOrLegacy() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);

  if (params.get("view") === "block") {
    params.delete("view");
    const query = params.toString();
    return <Navigate replace to={`/auction/demo${query ? `?${query}` : ""}`} />;
  }

  return <Home />;
}

/**
 * The Phase 3 war room on its mock socket.
 *
 * Its two knobs stay on the query string — they are debugging affordances, not
 * navigation. `?purse=250` is the quickest way to reach the blocked state and
 * watch the refusal shake; `?team=CHE` bids as a different franchise. Both are
 * parsed defensively, because a junk value should open the demo at its defaults
 * rather than render a component full of NaN.
 */
function BlockDemo() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);

  const purse = Number(params.get("purse"));
  const team = params.get("team")?.toUpperCase();

  return (
    <AuctionBlock
      purse={Number.isFinite(purse) && purse > 0 ? purse : undefined}
      myTeam={team && /^[A-Z]{3}$/.test(team) ? team : undefined}
    />
  );
}

/**
 * Shown while a lazy route's chunk is in flight.
 *
 * Deliberately not a spinner. On a warm cache this is on screen for a single
 * frame, and a spinner that flashes for one frame reads as a glitch; a static
 * wordmark that matches the landing reads as the page still being itself.
 */
function RouteFallback() {
  return (
    <div className="grid min-h-screen place-items-center bg-surface bg-dots">
      <div className="text-center">
        <div className="font-head text-[22px] font-extrabold tracking-[0.18em] text-slate-ink">
          AUCTIQ
        </div>
        <div className="mt-1 font-ui text-[10px] uppercase tracking-[0.2em] text-slate-faint">
          loading
        </div>
      </div>
    </div>
  );
}

/**
 * A real 404 rather than a redirect home.
 *
 * Bouncing an unknown path to `/` hides typos and makes a broken link
 * indistinguishable from a working one, which is a genuinely annoying thing to
 * debug later.
 */
function NotFound() {
  const { pathname } = useLocation();

  return (
    <div className="grid min-h-screen place-items-center bg-surface bg-dots px-6">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface-card p-6 text-center shadow-soft">
        <div className="font-num text-[40px] font-bold leading-none text-slate-ink">404</div>
        <p className="mt-2 font-ui text-[13px] text-slate-body">
          Nothing is routed at{" "}
          <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[12px] text-slate-ink">
            {pathname}
          </code>
        </p>
        <Link
          to="/"
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-card px-3.5 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
        >
          ← Back to AUCTIQ
        </Link>
      </div>
    </div>
  );
}
