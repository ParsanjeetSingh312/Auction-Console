/**
 * BiddingHistoryGrid.tsx
 * Every bid, newest first, with the size of each raise.
 *
 * Supersedes `LedgerPanel` — the "Tally" — in the same slot. That panel is a
 * ruled-paper ledger of everything that happened: call-ups, bids, sales and
 * passes together, as prose. This is the same events read as a *grid*, which is
 * a different job: a ledger is for reconstructing what happened, a datagrid is
 * for reading the shape of a contest while it is still running.
 *
 * `LedgerPanel` stays on disk and unmounted. Restoring it is one import line.
 *
 * **Newest first, and that is not a preference.** The prototype's note is
 * exactly right: it means "the row people care about is always at a fixed
 * position at the top, so nothing has to auto-scroll and the eye never chases a
 * moving target during a fast bidding war." Chronological order would put the
 * live row at the bottom of a list that grows under it.
 *
 * **The jump column is the point of the grid.** A column of ascending prices
 * tells you very little; the *delta* tells you whether the room is grinding up
 * the ladder or somebody just tried to end it. A raise of one increment and a
 * raise of six look identical in a ledger and completely different here.
 */
import { moneyTight } from "../../console/format";
import type { LogEntry } from "../../console/types";

/** Kinds worth a row in a bidding grid. A note or a call-up is not a bid. */
const SHOWN = new Set(["bid", "sold", "unsold", "withdraw", "timeout"]);

const TONE: Record<string, string> = {
  bid: "text-slate-ink",
  sold: "text-emerald-700",
  unsold: "text-slate-faint",
  withdraw: "text-amber-700",
  timeout: "text-amber-700",
};

export interface BiddingHistoryGridProps {
  log: LogEntry[];
  /** Omitted on read-only routes, where resetting is not on offer. */
  onClear?: () => void;
  /** Cap the rendered rows. A long auction's log is thousands of entries. */
  limit?: number;
}

export default function BiddingHistoryGrid({
  log,
  onClear,
  limit = 60,
}: BiddingHistoryGridProps) {
  /*
    Deltas are computed against the previous *bid*, not the previous row.

    A sale or a withdrawal sits between two bids in the log, so differencing
    adjacent rows would attribute the gap across an unrelated event and report
    a raise that nobody made.
  */
  const rows: Array<{ entry: LogEntry; jump: number | null }> = [];
  let previousBid: number | null = null;

  // The log arrives newest-first, so walk it backwards to accumulate in time
  // order, then reverse — rather than sorting a copy on every render.
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const entry = log[i];
    if (!SHOWN.has(entry.kind)) continue;

    let jump: number | null = null;
    if (entry.kind === "bid" && entry.amount != null) {
      jump = previousBid == null ? null : entry.amount - previousBid;
      previousBid = entry.amount;
    }
    if (entry.kind === "sold" || entry.kind === "unsold") previousBid = null;

    rows.push({ entry, jump });
  }
  rows.reverse();

  const shown = rows.slice(0, limit);

  return (
    <div className="ledger">
      <div className="lhead">
        <span className="eyebrow">Bidding history</span>
        {onClear && log.length > 0 && (
          <button type="button" className="linkbtn" onClick={onClear}>
            Reset auction
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="px-3 py-4 font-ui text-[11px] text-slate-faint">
          Bids will appear here as the room moves.
        </p>
      ) : (
        <table className="w-full border-collapse font-ui text-[11px]">
          <thead>
            <tr className="text-left text-[9px] uppercase tracking-[0.16em] text-slate-faint">
              <th scope="col" className="px-3 py-1.5 font-medium">#</th>
              <th scope="col" className="px-1 py-1.5 font-medium">Event</th>
              <th scope="col" className="px-1 py-1.5 text-right font-medium">Amount</th>
              {/* The column that makes this a grid rather than a list. */}
              <th scope="col" className="px-3 py-1.5 text-right font-medium">Raise</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ entry, jump }, index) => (
              <tr
                key={entry.seq}
                className={
                  index === 0
                    ? "bg-cyan-50/60"
                    : index % 2 === 1
                      ? "bg-black/[0.015]"
                      : undefined
                }
              >
                <td className="px-3 py-1 tabular-nums text-slate-faint">
                  {String(entry.seq).padStart(3, "0")}
                </td>
                <td className={`px-1 py-1 ${TONE[entry.kind] ?? "text-slate-ink"}`}>
                  {entry.what}
                </td>
                <td className="px-1 py-1 text-right font-num tabular-nums text-slate-ink">
                  {entry.amount == null ? "—" : moneyTight(entry.amount)}
                </td>
                <td className="px-3 py-1 text-right font-num tabular-nums">
                  {jump == null || jump <= 0 ? (
                    <span className="text-slate-faint">—</span>
                  ) : (
                    <span className="text-emerald-700">+{moneyTight(jump)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rows.length > shown.length && (
        <p className="px-3 py-1.5 font-ui text-[10px] text-slate-faint">
          showing the last {shown.length} of {rows.length}
        </p>
      )}
    </div>
  );
}
