/**
 * App.tsx
 * AUCTIQ's route table.
 *
 * Phase 3 chose the view with a query string, because there were two views and
 * a router would have been more machinery than that choice deserved. Phase 4
 * has five destinations, two of them role-gated, and one of them a room a user
 * is invited into by URL — so the addressing now has to be real.
 *
 *   /                the AUCTIQ landing
 *   /classic         the previous white landing, kept as a fallback
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
import ErrorBoundary from "./components/Global/ErrorBoundary";
import ScoutDrawer from "./components/Scout/ScoutDrawer";
import ScoutLauncher from "./components/Scout/ScoutLauncher";
import { useScoutHotkey } from "./console/scoutStore";

// The AUCTIQ landing — now the front door.
const Auctiq = lazy(() => import("./pages/Auctiq"));
const DataRoom = lazy(() => import("./pages/DataRoom"));
const LiveAuction = lazy(() => import("./pages/LiveAuction"));
const AuctionConsole = lazy(() => import("./components/Console/AuctionConsole"));
const AuctionBlock = lazy(() => import("./components/Auction/AuctionBlock"));
// The scene bench, while the 3D landing is being built piece by piece.
const StadiumLab = lazy(() => import("./pages/StadiumLab"));

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<LandingOrLegacy />} />
          {/* The previous white landing, kept one route away rather than
              deleted: if the dark treatment turns out to be wrong for any
              surface, reverting is a one-line change, not a recovery. */}
          <Route path="/classic" element={<Home />} />
          {/* Anyone holding the build-time URL lands in the right place. */}
          <Route path="/auctiq" element={<Navigate replace to="/" />} />
          <Route path="/data" element={<DataRoom />} />
          <Route path="/auction" element={<LiveAuction />} />
          {/*
            `/auction/live` is the same room, under the name the rest of the
            product calls it.

            A second path to one component rather than a redirect, because both
            are legitimate addresses for it and a redirect would rewrite the URL
            under anyone who typed the other one. `/auction` has been the route
            since Phase 4 and is in bookmarks; `/auction/live` is what the nav
            and the specification call the live bidding control panel. Neither
            should win.
          */}
          <Route path="/auction/live" element={<LiveAuction />} />
          {/* A near-miss worth catching rather than 404ing. */}
          <Route path="/auction/room" element={<Navigate replace to="/auction/live" />} />
          <Route path="/auction/demo" element={<BlockDemo />} />
          {/* The stadium bench. Mounted from the first step of the 3D build so
              each piece can be scrolled and judged as it lands, rather than
              only once the whole scene is wired into the hero. */}
          <Route path="/stadium" element={<StadiumLab />} />
          <Route path="/console" element={<AuctionConsole />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>

      {/*
        SCOUT, on every route.

        Mounted here rather than per-page for the reason the brief asks for it
        to be global: the assistant has to be reachable from the landing, the
        Data Interface, the live room and the console without each of them
        knowing it exists. Inside `BrowserRouter` so the panel can link into
        the app later, and outside `Suspense` so it is not replaced by the
        route fallback while a lazy chunk is in flight — a launcher that
        disappears during navigation reads as a bug.

        Not lazy, deliberately. The whole point is that it is always there, and
        a chunk fetched on first click would make the first open the slowest.
      */}
      {/*
        SCOUT is advisory; the auction is not.

        A render fault anywhere inside the drawer would otherwise unmount the
        whole tree from the root and leave a blank page — during a live lot.
        The boundary confines it to the panel, so a broken assistant costs the
        assistant and nothing else.

        It does NOT catch a failed request: those are already handled as state
        by useScoutOrchestrator and rendered as a message. And it cannot help
        when the backend is down, because uvicorn serves this page too — there
        is no React left running to catch anything.
      */}
      <ErrorBoundary label="SCOUT">
        <GlobalScout />
      </ErrorBoundary>
    </BrowserRouter>
  );
}

/**
 * The launcher, the panel, and the keyboard shortcut that opens them.
 *
 * A component rather than three lines in `App` because `useScoutHotkey` is a
 * hook and has to be called from one. Keeping it here also means the shortcut
 * is registered exactly once for the life of the application, which is what
 * the store's own header asks for.
 *
 * The drawer is rendered before the launcher so the button paints over the
 * panel it opened. Both carry explicit z-indices as well, because paint order
 * alone would not survive either of them gaining a stacking context.
 */
function GlobalScout() {
  useScoutHotkey();

  return (
    <>
      <ScoutDrawer />
      <ScoutLauncher />
    </>
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

  return <Auctiq />;
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
