/**
 * UpcomingAuctionsCard.tsx
 * The purple panel: what goes under the hammer next.
 *
 * It used to draw two hard-coded fixtures. It now draws the auctioneer's real
 * schedule (accounts/schedule.py, through console/scheduleApi.ts): one row per
 * auction, the start time large in the viewer's local time, the day and the
 * room type beneath it. A row that is also in Google Calendar carries a small
 * "in Google" mark.
 *
 * **On the colour.** The times are `neon-lilac`, not `neon-purple`: `--neon`
 * on a purple card is #A855F7, which measures 5.10:1 on the page ground --
 * legible, but only just, and the labels beneath these figures are small.
 * #C084FC measures 7.63:1. The border and its bloom keep the deeper purple,
 * because nothing is read off those.
 */
import type { ScheduleEntry } from "../../console/scheduleApi";

interface Props {
  entries: ScheduleEntry[];
  /** At most this many rows. */
  limit?: number;
  /** Called with a row the viewer clicks, to edit it. */
  onSelect?: (entry: ScheduleEntry) => void;
  className?: string;
}

const DAY = 24 * 3600 * 1000;

/** "Today", "Tomorrow", or the weekday and date, in local time. */
function dayLabel(epoch: number): string {
  const date = new Date(epoch * 1000);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const diff = Math.floor((date.getTime() - start.getTime()) / DAY);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function clock(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function UpcomingAuctionsCard({ entries, limit = 4, onSelect, className = "" }: Props) {
  const rows = entries.slice(0, limit);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <article className={`neon-card neon-card--purple flex flex-col p-4 ${className}`}>
      <h2 className="font-stadium text-[17px] font-semibold uppercase tracking-[0.04em] text-auctiq-text">
        Upcoming Auctions
      </h2>
      <div className="neon-rule mt-2" />

      {rows.length === 0 ? (
        <p className="mt-3 font-tech text-[12px] leading-relaxed text-auctiq-dim">
          Nothing scheduled yet. Pick a date to schedule your next auction.
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                disabled={!onSelect}
                onClick={() => onSelect?.(entry)}
                className="w-full rounded-md text-left outline-none transition-colors enabled:hover:bg-white/[0.04] focus-visible:ring-1 focus-visible:ring-neon-lilac"
              >
                <div className="flex items-baseline justify-between gap-3">
                  {/* tabular-nums: stacked clock faces keep their colons in line. */}
                  <span className="font-num text-[24px] font-bold leading-none tabular-nums text-neon-lilac">
                    {clock(entry.starts_at)}
                  </span>
                  <span className="font-tech text-[9.5px] uppercase tracking-[0.18em] text-auctiq-dim">
                    {dayLabel(entry.starts_at)}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-tech text-[12.5px] font-semibold text-auctiq-text">
                    {entry.title}
                  </span>
                  <span className="rounded-[3px] border border-white/10 bg-white/[0.04] px-2 py-[2px] font-tech text-[10px] font-semibold uppercase tracking-[0.06em] text-auctiq-text">
                    {entry.room_type === "auctioneer" ? "Auctioneer" : "Delegate"}
                  </span>
                  {entry.google_event_id && (
                    <span className="font-tech text-[9.5px] uppercase tracking-[0.12em] text-neon-lilac" title="Also in Google Calendar">
                      in Google
                    </span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-auto pt-3 font-tech text-[9.5px] uppercase tracking-[0.16em] text-auctiq-dim/70">
        Times in {zone}
      </p>
    </article>
  );
}
