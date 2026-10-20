/**
 * AuctioneerPanel.tsx
 * The auctioneer's own corner of the Account page.
 *
 *   delegate passes   generated today against the daily cap, and how many
 *                     were given, claimed, are waiting, or came back
 *   recipients        who received them, and whether they claimed
 *   auctions          rooms opened, started and finished
 *   schedule          upcoming auctions, synced to Google Calendar
 *                     (SchedulePanel)
 *
 * Figures come from GET /api/v1/auctioneer/overview (accounts/admin_stats.py).
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";

import { fetchAuctioneerOverview } from "../../console/scheduleApi";
import type { AuctioneerOverview } from "../../console/scheduleApi";
import { openSendPasses } from "../../console/ecosystemStore";
import { cardVariants } from "../../console/motion";
import SchedulePanel from "./SchedulePanel";

const LABEL = "font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint";
const PRIMARY =
  "rounded-lg bg-slate-ink px-4 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-white transition-opacity hover:opacity-90";

export default function AuctioneerPanel() {
  const [data, setData] = useState<AuctioneerOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchAuctioneerOverview(30)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load your figures."));
    return () => {
      live = false;
    };
  }, []);

  const given = data?.given.all_time;
  const cap = data?.generate_cap;

  return (
    <motion.section
      variants={cardVariants}
      className="seat-chair relative mt-5 overflow-hidden rounded-xl border border-[#22D3EE]/30 p-6"
      aria-label="Auctioneer panel"
    >
      <span aria-hidden className="seat-chair__rule" />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-[var(--teal-ink)]">
            Auctioneer panel
          </h2>
          <p className="mt-1 font-head text-[20px] font-bold leading-tight text-slate-ink">Your auctions and delegates</p>
        </div>
        <button type="button" className={PRIMARY} onClick={() => openSendPasses()}>
          Send Delegate passes →
        </button>
      </header>

      {error && <p className="mt-4 font-ui text-[12.5px] text-[var(--unsold)]">{error}</p>}
      {!data && !error && <p className="mt-4 font-ui text-[12.5px] text-slate-muted">Loading…</p>}

      {data && given && (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Delegate passes given" value={given.sent.D} sub={`${data.given.window.sent.D} in ${data.days} days`} />
            <Tile label="Claimed" value={given.claimed.D} sub={`${given.pending.D} waiting to be claimed`} />
            <Tile
              label="Generated today"
              value={data.generated_today}
              sub={cap ? `of ${cap} a day` : "no daily limit"}
            />
            <Tile
              label="Auctions run"
              value={data.auctions.all_time.started}
              sub={`${data.auctions.all_time.finished} finished`}
            />
          </div>

          {given.returned.D > 0 && (
            <p className="mt-3 font-ui text-[11.5px] text-slate-muted">
              {given.returned.D} Delegate pass{given.returned.D === 1 ? "" : "es"} came back to you unclaimed.
            </p>
          )}

          <h3 className={`${LABEL} mt-6 border-t border-line pt-4`}>Who has your Delegate passes</h3>
          {data.recipients.filter((r) => r.kind === "D").length === 0 ? (
            <p className="mt-2 font-ui text-[12px] text-slate-muted">
              You have not sent any Delegate passes yet. Connect with your delegates, then send them one each.
            </p>
          ) : (
            <table className="mt-2 w-full font-ui text-[12.5px]">
              <thead>
                <tr className="text-left text-[10.5px] text-slate-faint">
                  <th className="py-1.5 font-semibold">Delegate</th>
                  <th className="py-1.5 text-right font-semibold">Sent</th>
                  <th className="py-1.5 text-right font-semibold">Claimed</th>
                  <th className="hidden py-1.5 text-right font-semibold sm:table-cell">Last sent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.recipients
                  .filter((r) => r.kind === "D")
                  .map((r) => (
                    <tr key={r.id}>
                      <td className="py-1.5">
                        <span className="text-slate-body">{r.name}</span>
                        <span className="ml-2 text-[10.5px] text-slate-faint">{r.role === "member" ? "Free" : "Delegate"}</span>
                      </td>
                      <td className="py-1.5 text-right font-num text-[14px] font-bold text-slate-ink">{r.sent}</td>
                      <td className="py-1.5 text-right">
                        <span className="font-num text-[14px] font-bold text-slate-ink">{r.claimed}</span>
                        {r.pending > 0 && <span className="ml-1.5 text-[10.5px] text-[var(--live)]">{r.pending} waiting</span>}
                      </td>
                      <td className="hidden py-1.5 text-right text-[11px] text-slate-faint sm:table-cell">
                        {new Date(r.last_sent * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h3 className={`${LABEL} mt-6 border-t border-line pt-4`}>Schedule</h3>
      <div className="mt-3">
        <SchedulePanel />
      </div>
    </motion.section>
  );
}

function Tile({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="rounded-lg border border-line bg-white/[0.02] px-3.5 py-3">
      <div className="font-ui text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-faint">{label}</div>
      <div className="mt-1 font-num text-[30px] font-bold leading-none text-slate-ink">{value}</div>
      <div className="mt-1 font-ui text-[11px] text-slate-muted">{sub}</div>
    </div>
  );
}
