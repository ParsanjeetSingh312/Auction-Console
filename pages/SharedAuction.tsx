/**
 * SharedAuction.tsx
 * The `/calendar/:token` route: one scheduled auction, for the people it was
 * shared with -- from a bell notification or a link pasted anywhere.
 *
 * Public on purpose: the long random token is the permission, so a delegate
 * can add the auction to their calendar before they have even signed in. It
 * shows when (in the viewer's own time), how long, which kind of room and who
 * runs it, with "Add to calendar" buttons and a way into Live Bidding.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { CalendarDays, Clock, Gavel, User } from "lucide-react";

import { fetchSharedAuction } from "../console/scheduleApi";
import type { SharedAuction as Shared } from "../console/scheduleApi";
import { cardVariants, gridVariants } from "../console/motion";
import AuctiqNav from "../components/Global/AuctiqNav";
import StadiumBackdrop from "../components/Sections/StadiumBackdrop";
import AddToCalendar from "../components/Account/AddToCalendar";

import "../console/console.css";

/** "in 3 days", "in 5 hours", "started 20 minutes ago". */
function relative(epoch: number): string {
  const diff = epoch * 1000 - Date.now();
  const abs = Math.abs(diff);
  const unit =
    abs >= 86_400_000 ? ([Math.round(abs / 86_400_000), "day"] as const)
    : abs >= 3_600_000 ? ([Math.round(abs / 3_600_000), "hour"] as const)
    : ([Math.max(1, Math.round(abs / 60_000)), "minute"] as const);
  const words = `${unit[0]} ${unit[1]}${unit[0] === 1 ? "" : "s"}`;
  return diff >= 0 ? `in ${words}` : `started ${words} ago`;
}

export default function SharedAuction() {
  const { token = "" } = useParams();
  const [auction, setAuction] = useState<Shared | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchSharedAuction(token)
      .then((a) => {
        if (!live) return;
        setAuction(a);
        document.title = `${a.title} · AUCTONIQ`;
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "This auction link is not valid."));
    return () => {
      live = false;
    };
  }, [token]);

  const start = auction ? new Date(auction.starts_at * 1000) : null;
  const end = auction ? new Date((auction.starts_at + auction.duration_min * 60) * 1000) : null;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="console-dark">
      <StadiumBackdrop variant="console" />
      <AuctiqNav placement="static" />
      <div className="min-h-screen bg-surface bg-dots px-5 py-10">
        <motion.div className="mx-auto w-full max-w-xl" variants={gridVariants} initial="initial" animate="animate">
          {error && (
            <motion.section variants={cardVariants} className="seat-chair rounded-xl border border-line p-6">
              <h1 className="font-head text-[22px] font-bold text-slate-ink">Auction not found</h1>
              <p className="mt-2 font-ui text-[13px] text-slate-muted">{error}</p>
              <Link to="/" className="mt-4 inline-block font-ui text-[12px] text-slate-body underline underline-offset-2">
                ← AUCTONIQ
              </Link>
            </motion.section>
          )}

          {!auction && !error && <p className="font-ui text-[13px] text-slate-muted">Loading the auction…</p>}

          {auction && start && end && (
            <motion.section
              variants={cardVariants}
              className="seat-chair relative overflow-hidden rounded-xl border border-[#C084FC]/40 p-6"
              aria-label="Scheduled auction"
            >
              <span aria-hidden className="seat-chair__rule" />
              <p className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-[#C084FC]">
                Scheduled auction
              </p>
              <h1 className="mt-1 font-head text-[26px] font-bold leading-tight text-slate-ink">{auction.title}</h1>

              <div className="mt-4 flex items-end gap-3">
                <span className="font-num text-[44px] font-bold leading-none tabular-nums text-[#C084FC]">
                  {start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="pb-1 font-ui text-[12px] text-slate-muted">{relative(auction.starts_at)}</span>
              </div>

              <ul className="mt-4 space-y-2 font-ui text-[13px] text-slate-body">
                <li className="flex items-center gap-2.5">
                  <CalendarDays size={15} className="text-slate-faint" />
                  {start.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                </li>
                <li className="flex items-center gap-2.5">
                  <Clock size={15} className="text-slate-faint" />
                  Until {end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · times in {zone}
                </li>
                <li className="flex items-center gap-2.5">
                  <Gavel size={15} className="text-slate-faint" />
                  {auction.room_type === "auctioneer" ? "Auctioneer room" : "Delegate room"}
                </li>
                <li className="flex items-center gap-2.5">
                  <User size={15} className="text-slate-faint" />
                  Run by {auction.host}
                </li>
              </ul>

              {auction.notes && (
                <p className="mt-4 whitespace-pre-line border-t border-line pt-4 font-ui text-[13px] leading-relaxed text-slate-body">
                  {auction.notes}
                </p>
              )}

              <div className="mt-5 border-t border-line pt-4">
                <h2 className="mb-2 font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
                  Add to your calendar
                </h2>
                <AddToCalendar event={auction} token={auction.token} />
                <p className="mt-3 font-ui text-[11px] text-slate-faint">
                  You&apos;ll get a reminder 30 minutes before. If the time changes, your auctioneer will share it again.
                </p>
              </div>

              <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
                <Link
                  to="/auction/live"
                  className="rounded-lg border border-line bg-surface-card px-3.5 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-body hover:text-slate-ink"
                >
                  Open Live Bidding →
                </Link>
              </div>
            </motion.section>
          )}
        </motion.div>
      </div>
    </div>
  );
}
