/**
 * PostAuctionReport.tsx
 * What everyone actually wants to know when the hammer falls for the last time.
 *
 * An auction ends with ten squads and no answer to the only question anyone is
 * asking, which is *did we do well*. A list of purchases does not answer it. A
 * side does. So this leads with the Playing XI — eleven names in batting order,
 * with what each cost and what each is rated — and puts the accounting
 * underneath, where accounting belongs.
 *
 * The XI is chosen by the server (`room.report()`), not here. That matters for
 * a reason beyond tidiness: the report is the record of the auction, and a
 * record that each client computes for itself is a record that can differ
 * between two people reading it in the same room.
 *
 * Franchises are ordered by the side they can field, with complete squads
 * always above incomplete ones. Sorting on mean rating alone put a team holding
 * one 9.5 and nobody else above a full eleven averaging 9.3, which is exactly
 * backwards — the first cannot take the field at all.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";

import { money } from "../../console/format";
import { EASE, panelVariants, viewVariants } from "../../console/motion";

/* The report's shape, mirroring auction/room.py `report()`. */

interface ReportPlayer {
  id: number;
  name: string;
  role: string;
  role_short: "BAT" | "BOWL" | "AR" | "WK";
  country: string | null;
  overseas: boolean;
  rating: number | null;
  price: number | null;
}

interface ReportFranchise {
  team: { id: number; name: string; code: string; color: string };
  squad_size: number;
  overseas: number;
  spent: number;
  purse: number;
  left: number;
  squad_rating: number | null;
  xi_rating: number | null;
  playing_xi: ReportPlayer[];
  bench: ReportPlayer[];
  incomplete: boolean;
}

export interface AuctionReport {
  generated_at: number;
  phase: string;
  rules: Record<string, number>;
  totals: { available: number; sold: number; unsold: number; spent: number; purse_pool: number };
  franchises: ReportFranchise[];
}

const ROLE_CLASS: Record<ReportPlayer["role_short"], string> = {
  BAT: "bg-role-bat",
  BOWL: "bg-role-bowl",
  AR: "bg-role-ar",
  WK: "bg-role-wk",
};

export interface PostAuctionReportProps {
  /** Passed in when the socket already delivered it; otherwise fetched. */
  report?: AuctionReport | null;
  onLeave?: () => void;
  /** Auctioneer only: clear the auction and send everyone back to the lobby. */
  onReset?: () => void;
}

export default function PostAuctionReport({
  report,
  onLeave,
  onReset,
}: PostAuctionReportProps) {
  const reduced = useReducedMotion();
  const [fetched, setFetched] = useState<AuctionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTeam, setOpenTeam] = useState<number | null>(null);

  /*
    Fetched over REST rather than taken from the socket when it is not already
    to hand. The report is a document, not a live reading: it is read once,
    scrolled, and often opened in a second tab to compare — none of which wants
    a socket.
  */
  useEffect(() => {
    if (report) return;
    const base = import.meta.env?.DEV ? "http://localhost:8001" : "";
    const controller = new AbortController();

    fetch(`${base}/api/v1/auction/report`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Report unavailable (${response.status})`);
        return response.json();
      })
      .then(setFetched)
      .catch((exc: unknown) => {
        if (controller.signal.aborted) return;
        setError(exc instanceof Error ? exc.message : "Could not load the report");
      });

    return () => controller.abort();
  }, [report]);

  useEffect(() => {
    document.title = "AUCTIQ · Auction report";
  }, []);

  const data = report ?? fetched;

  if (error) {
    return (
      <Shell>
        <div className="rounded-xl border border-unsold/40 bg-unsold-tint px-4 py-4" role="alert">
          <span className="font-ui text-[10px] font-semibold uppercase tracking-[0.14em] text-unsold">
            Report unavailable
          </span>
          <p className="mt-1 font-ui text-[12.5px] text-slate-body">{error}</p>
        </div>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell>
        <div className="rounded-xl border border-line bg-surface-card px-4 py-10 text-center shadow-soft">
          <span className="font-ui text-[10px] uppercase tracking-[0.14em] text-slate-faint">
            Compiling the report…
          </span>
        </div>
      </Shell>
    );
  }

  const spentPct =
    data.totals.purse_pool > 0 ? (data.totals.spent / data.totals.purse_pool) * 100 : 0;

  return (
    <Shell onLeave={onLeave} onReset={onReset}>
      <motion.div
        variants={reduced ? undefined : viewVariants}
        initial={reduced ? false : "initial"}
        animate="animate"
      >
        {/* Headline numbers. */}
        <motion.section
          variants={reduced ? undefined : panelVariants}
          className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          <Figure label="Players sold" value={String(data.totals.sold)} />
          <Figure label="Unsold" value={String(data.totals.unsold)} />
          <Figure label="Total spend" value={money(data.totals.spent)} />
          <Figure label="Of the pool" value={`${spentPct.toFixed(1)}%`} />
        </motion.section>

        <div className="space-y-3">
          {data.franchises.map((franchise, rank) => (
            <FranchiseCard
              key={franchise.team.id}
              franchise={franchise}
              rank={rank}
              open={openTeam === franchise.team.id}
              onToggle={() =>
                setOpenTeam((current) =>
                  current === franchise.team.id ? null : franchise.team.id,
                )
              }
              reduced={!!reduced}
            />
          ))}
        </div>
      </motion.div>
    </Shell>
  );
}

function Shell({
  children,
  onLeave,
  onReset,
}: {
  children: React.ReactNode;
  onLeave?: () => void;
  onReset?: () => void;
}) {
  return (
    <div className="min-h-screen bg-surface bg-dots px-5 py-8">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
              AUCTIQ · IPL 2026
            </span>
            <h1 className="mt-1 font-head text-[30px] font-bold leading-tight text-slate-ink">
              Auction report
            </h1>
            <p className="mt-1 font-ui text-[12.5px] text-slate-muted">
              Playing XI, ratings and purse for every franchise. Ranked by the side
              they can field.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {onReset && (
              <button
                type="button"
                onClick={onReset}
                title="Clear the auction and return every client to the lobby"
                className="rounded-lg border border-slate-ink bg-slate-ink px-3.5 py-2 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-white transition-colors hover:bg-slate-ink/90"
              >
                New auction
              </button>
            )}
            {onLeave && (
              <button
                type="button"
                onClick={onLeave}
                className="rounded-lg border border-line bg-surface-card px-3.5 py-2 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
              >
                ← Room
              </button>
            )}
            <Link
              to="/"
              className="rounded-lg border border-line bg-surface-card px-3.5 py-2 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
            >
              AUCTIQ
            </Link>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-card px-3.5 py-3 shadow-chip">
      <div className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.14em] text-slate-faint">
        {label}
      </div>
      <div className="mt-1 font-num text-[22px] font-bold leading-none tabular-nums text-slate-ink">
        {value}
      </div>
    </div>
  );
}

function FranchiseCard({
  franchise,
  rank,
  open,
  onToggle,
  reduced,
}: {
  franchise: ReportFranchise;
  rank: number;
  open: boolean;
  onToggle: () => void;
  reduced: boolean;
}) {
  const { team } = franchise;
  const usedPct = franchise.purse > 0 ? (franchise.spent / franchise.purse) * 100 : 0;

  return (
    <motion.section
      initial={reduced ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE, delay: Math.min(rank, 9) * 0.03 }}
      className="relative overflow-hidden rounded-xl border border-line bg-surface-card shadow-soft"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ backgroundColor: team.color }}
      />

      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 pl-5">
        <span className="font-num text-[15px] font-bold tabular-nums text-slate-faint">
          {rank + 1}
        </span>

        <span className="min-w-[150px]">
          <span className="block font-head text-[16px] font-bold leading-tight text-slate-ink">
            {team.name}
          </span>
          <span className="font-ui text-[9.5px] uppercase tracking-[0.12em] text-slate-faint">
            {team.code}
            {franchise.incomplete && " · squad incomplete"}
          </span>
        </span>

        <Stat label="XI rating" value={franchise.xi_rating?.toFixed(2) ?? "—"} strong />
        <Stat label="Squad rating" value={franchise.squad_rating?.toFixed(2) ?? "—"} />
        <Stat label="Squad" value={`${franchise.squad_size}`} />
        <Stat label="Overseas" value={`${franchise.overseas}`} />
        <Stat label="Spent" value={money(franchise.spent)} />
        <Stat label="Left" value={money(franchise.left)} />

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="ml-auto rounded-md border border-line px-2.5 py-1 font-ui text-[9.5px] font-semibold uppercase tracking-[0.1em] text-slate-muted transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
        >
          {open ? "Hide XI" : "Playing XI"}
        </button>
      </header>

      {/* Purse used, as a rule under the header rather than a chart. */}
      <div className="mx-4 mb-3 h-1 overflow-hidden rounded-sm bg-surface-sunken">
        <div
          className="h-full rounded-sm"
          style={{
            width: `${Math.min(100, usedPct)}%`,
            backgroundColor: usedPct > 90 ? "#A2382C" : team.color,
          }}
        />
      </div>

      {open && (
        <motion.div
          initial={reduced ? false : { opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          transition={{ duration: 0.24, ease: EASE }}
          className="overflow-hidden border-t border-line-soft"
        >
          <div className="overflow-x-auto px-4 py-3">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {["#", "Player", "Role", "Country", "Rating", "Price"].map((head, i) => (
                    <th
                      key={head}
                      className={`whitespace-nowrap border-b border-line px-2 py-1.5 font-ui text-[9.5px] font-semibold uppercase tracking-[0.1em] text-slate-faint ${
                        i >= 4 ? "text-right" : "text-left"
                      }`}
                    >
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {franchise.playing_xi.map((player, index) => (
                  <tr key={player.id} className="hover:bg-surface-sunken/60">
                    <td className="whitespace-nowrap border-b border-line-soft px-2 py-1.5 font-num text-[12px] tabular-nums text-slate-faint">
                      {index + 1}
                    </td>
                    <td className="whitespace-nowrap border-b border-line-soft px-2 py-1.5 font-ui text-[12.5px] text-slate-ink">
                      {player.name}
                      {player.overseas && (
                        <span
                          className="ml-1.5 font-ui text-[9px] uppercase tracking-[0.08em] text-slate-faint"
                          title="Overseas player"
                        >
                          OS
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap border-b border-line-soft px-2 py-1.5">
                      <span
                        className={`inline-grid h-[17px] w-[26px] place-items-center rounded-sm font-mono text-[9px] font-bold text-white ${
                          ROLE_CLASS[player.role_short]
                        }`}
                      >
                        {player.role_short}
                      </span>
                    </td>
                    <td className="whitespace-nowrap border-b border-line-soft px-2 py-1.5 font-ui text-[11.5px] text-slate-muted">
                      {player.country ?? "—"}
                    </td>
                    <td className="whitespace-nowrap border-b border-line-soft px-2 py-1.5 text-right font-num text-[13px] font-bold tabular-nums text-slate-ink">
                      {player.rating?.toFixed(2) ?? "—"}
                    </td>
                    <td className="whitespace-nowrap border-b border-line-soft px-2 py-1.5 text-right font-num text-[13px] tabular-nums text-slate-body">
                      {player.price != null ? money(player.price) : "—"}
                    </td>
                  </tr>
                ))}
                {franchise.playing_xi.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-2 py-6 text-center font-ui text-[11.5px] text-slate-faint"
                    >
                      This franchise bought nobody.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {franchise.bench.length > 0 && (
              <p className="mt-2.5 font-ui text-[11px] text-slate-faint">
                <b className="font-semibold text-slate-muted">Bench ({franchise.bench.length}):</b>{" "}
                {franchise.bench.map((player) => player.name).join(" · ")}
              </p>
            )}
          </div>
        </motion.div>
      )}
    </motion.section>
  );
}

function Stat({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <span className="hidden sm:block">
      <span className="block font-ui text-[9px] uppercase leading-none tracking-[0.1em] text-slate-faint">
        {label}
      </span>
      <span
        className={`mt-0.5 block font-num tabular-nums leading-none ${
          strong ? "text-[16px] font-bold text-slate-ink" : "text-[14px] text-slate-body"
        }`}
      >
        {value}
      </span>
    </span>
  );
}
