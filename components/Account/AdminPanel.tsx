/**
 * AdminPanel.tsx
 * The administrator's overview on the Account page: what has happened on
 * AUCTONIQ, at a glance.
 *
 *   tiles          auctions started and finished, rooms live now, accounts
 *   per day        auctions started each day, with opened / finished on hover
 *   passes         generated, sent, claimed, pending, returned and spent, for
 *                  gold (A) and blue (D) passes, in the window and all time
 *   given by you   what this administrator personally sent
 *   live rooms     every room open right now, and its phase
 *   top            the auctioneers who started the most auctions
 *   recent         the latest room events and pass gifts
 *
 * Every number comes from GET /api/v1/admin/overview (accounts/admin_stats.py);
 * nothing is counted on the client.
 */
import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { RefreshCw } from "lucide-react";

import { fetchAdminOverview } from "../../console/adminApi";
import type { AdminOverview, AuctionDay, PerKind } from "../../console/adminApi";
import { cardVariants } from "../../console/motion";
import { loadStatsStatus, refreshStatsNow, useStatsStatus } from "../../console/statsApi";

const RANGES = [7, 14, 30] as const;

const LABEL = "font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint";
const PASS_SWATCH: Record<"A" | "D", string> = {
  A: "linear-gradient(128deg,#e3a92c,#ffe08a)",
  D: "linear-gradient(128deg,#3b7cf0,#cfe2ff)",
};
/** The one series colour: cyan, the night console's accent. */
const BAR = "#22D3EE";

const PHASE_LABEL: Record<string, string> = {
  lobby: "Setting up",
  waiting: "Waiting room",
  live: "Live",
  finished: "Finished",
};

const EVENT_LABEL: Record<string, string> = {
  opened: "opened",
  started: "started",
  finished: "finished",
};

function shortDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function when(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminPanel() {
  const [days, setDays] = useState<number>(7);
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (range: number) => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchAdminOverview(range));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the admin panel.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  return (
    <motion.section
      variants={cardVariants}
      className="seat-chair relative mt-5 overflow-hidden rounded-xl border border-[#E8C547]/40 p-6"
      aria-label="Admin panel"
    >
      <span aria-hidden className="seat-chair__rule" />
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-[#E8C547]">Admin panel</h2>
          <p className="mt-1 font-head text-[20px] font-bold leading-tight text-slate-ink">AUCTONIQ at a glance</p>
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Time range" className="inline-flex rounded-full border border-line p-0.5">
            {RANGES.map((range) => (
              <button
                key={range}
                type="button"
                aria-pressed={days === range}
                onClick={() => setDays(range)}
                className={`rounded-full px-3 py-1 font-ui text-[10.5px] font-semibold uppercase tracking-[0.1em] transition-colors ${
                  days === range ? "bg-[var(--teal-tint)] text-[var(--teal-ink)]" : "text-slate-muted hover:text-slate-ink"
                }`}
              >
                {range} days
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void load(days)}
            aria-label="Refresh"
            className="grid h-8 w-8 place-items-center rounded-full border border-line text-slate-muted transition-colors hover:text-slate-ink"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
          </button>
        </div>
      </header>

      {error && <p className="mt-4 font-ui text-[12.5px] text-[var(--unsold)]">{error}</p>}
      {!data && !error && <p className="mt-4 font-ui text-[12.5px] text-slate-muted">Loading…</p>}

      {data && (
        <>
          {/* ---- headline tiles ---- */}
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label={`Auctions started · ${data.days}d`} value={data.auctions.window.started} sub={`${data.auctions.all_time.started} all time`} />
            <Tile label={`Auctions finished · ${data.days}d`} value={data.auctions.window.finished} sub={`${data.auctions.window.opened} rooms opened`} />
            <Tile
              label="Rooms open now"
              value={data.auctions.live.length}
              sub={`${data.auctions.live.filter((r) => r.phase === "live").length} live`}
            />
            <Tile label="Accounts" value={data.accounts.total} sub={`+${data.accounts.joined} in ${data.days}d`} />
          </div>

          {/* ---- player statistics ---- */}
          <StatsRefresh />

          {/* ---- auctions per day ---- */}
          <h3 className={`${LABEL} mt-6 border-t border-line pt-4`}>Auctions started per day</h3>
          <PerDayChart rows={data.auctions.per_day} />

          {/* ---- pass flow ---- */}
          <h3 className={`${LABEL} mt-6 border-t border-line pt-4`}>Passes · last {data.days} days (all time)</h3>
          <PassTable
            rows={[
              ["Generated", data.passes.window.generated, data.passes.all_time.generated],
              ["Sent", data.passes.window.sent, data.passes.all_time.sent],
              ["Claimed", data.passes.window.claimed, data.passes.all_time.claimed],
              ["Waiting to be claimed", data.passes.window.pending, data.passes.all_time.pending],
              ["Returned unclaimed", data.passes.window.returned, data.passes.all_time.returned],
              ["Used (rooms and seats)", data.passes.window.spent, data.passes.all_time.spent],
            ]}
          />

          <h3 className={`${LABEL} mt-6 border-t border-line pt-4`}>Given by you</h3>
          <PassTable
            rows={[
              ["Sent", data.given_by_me.window.sent, data.given_by_me.all_time.sent],
              ["Claimed", data.given_by_me.window.claimed, data.given_by_me.all_time.claimed],
              ["Waiting to be claimed", data.given_by_me.window.pending, data.given_by_me.all_time.pending],
            ]}
          />

          {/* ---- accounts by tier ---- */}
          <h3 className={`${LABEL} mt-6 border-t border-line pt-4`}>Accounts by tier</h3>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ["Admins", data.accounts.admin],
                ["Auctioneers", data.accounts.auctioneer],
                ["Delegates", data.accounts.delegate],
                ["Free", data.accounts.member],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="rounded-lg border border-line px-3 py-2">
                <dt className="font-ui text-[10.5px] text-slate-muted">{label}</dt>
                <dd className="font-num text-[20px] font-bold text-slate-ink">{n}</dd>
              </div>
            ))}
          </dl>

          {/* ---- rooms open now ---- */}
          <h3 className={`${LABEL} mt-6 border-t border-line pt-4`}>Rooms open now</h3>
          {data.auctions.live.length === 0 ? (
            <p className="mt-2 font-ui text-[12px] text-slate-muted">No auction rooms are open.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {data.auctions.live.map((room) => (
                <li key={room.code} className="flex flex-wrap items-center gap-3 py-2 font-ui text-[12.5px]">
                  <span className="font-mono text-[12px] font-semibold text-slate-ink">{room.code}</span>
                  <span className="text-slate-muted">{room.owner ?? "—"}</span>
                  <span className="text-slate-faint">{room.room_type} room</span>
                  <span className="ml-auto text-slate-body">
                    {room.seated}/{room.teams} seated
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] ${
                      room.phase === "live" ? "border-[var(--sold)] text-[var(--sold)]" : "border-line text-slate-muted"
                    }`}
                  >
                    {PHASE_LABEL[room.phase] ?? room.phase}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* ---- top auctioneers + recent rooms ---- */}
          <div className="mt-6 grid gap-6 border-t border-line pt-4 sm:grid-cols-2">
            <div>
              <h3 className={LABEL}>Most active auctioneers · {data.days}d</h3>
              {data.top_auctioneers.length === 0 ? (
                <p className="mt-2 font-ui text-[12px] text-slate-muted">No auctions started yet.</p>
              ) : (
                <ol className="mt-2 space-y-1.5">
                  {data.top_auctioneers.map((row, i) => (
                    <li key={row.id} className="flex items-center gap-2 font-ui text-[12.5px]">
                      <span className="w-4 text-slate-faint">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-body" title={row.email}>
                        {row.name}
                      </span>
                      <span className="font-num text-[14px] font-bold text-slate-ink">{row.started}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div>
              <h3 className={LABEL}>Recent rooms</h3>
              {data.recent_rooms.length === 0 ? (
                <p className="mt-2 font-ui text-[12px] text-slate-muted">Nothing yet.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {data.recent_rooms.slice(0, 8).map((row, i) => (
                    <li key={`${row.room_code}-${row.at}-${i}`} className="flex items-center gap-2 font-ui text-[12px]">
                      <span className="font-mono text-slate-ink">{row.room_code}</span>
                      <span className="text-slate-muted">{EVENT_LABEL[row.event]}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-faint">{row.owner ?? ""}</span>
                      <span className="text-[11px] text-slate-faint">{when(row.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ---- recent gifts ---- */}
          <h3 className={`${LABEL} mt-6 border-t border-line pt-4`}>Recent passes sent</h3>
          {data.recent_gifts.length === 0 ? (
            <p className="mt-2 font-ui text-[12px] text-slate-muted">No passes have been sent yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {data.recent_gifts.map((gift, i) => (
                <li key={`${gift.created_at}-${i}`} className="flex items-center gap-3 py-2 font-ui text-[12.5px]">
                  <KindChip kind={gift.kind} />
                  <span className="min-w-0 flex-1 truncate text-slate-body">
                    {gift.quantity} × {gift.sender} → {gift.recipient}
                  </span>
                  <span className="text-[11px] capitalize text-slate-muted">{gift.status}</span>
                  <span className="hidden w-[70px] text-right text-[10.5px] text-slate-faint sm:block">
                    {shortDate(gift.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </motion.section>
  );
}

/**
 * The quarterly career refresh: when it last ran, how much it covered, and a
 * button to run it now. Polls while a run is in progress (a full run downloads
 * the archive and walks every IPL match, so it takes a few minutes).
 */
function StatsRefresh() {
  const status = useStatsStatus();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const running = Boolean(status?.running) || asking;

  useEffect(() => {
    if (!status?.running) return;
    const timer = window.setInterval(() => void loadStatsStatus(true), 5000);
    return () => window.clearInterval(timer);
  }, [status?.running]);

  const run = async () => {
    setAsking(true);
    setNote(null);
    try {
      const result = await refreshStatsNow();
      setNote(result.accepted === false ? (result.note ?? "A refresh is already running.") : "Refresh started.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not start the refresh.");
    } finally {
      setAsking(false);
    }
  };

  const refreshed = status?.refreshed_at ? new Date(status.refreshed_at) : null;
  const due = status?.next_due ? new Date(status.next_due) : null;
  return (
    <>
      <h3 className={`${LABEL} mt-6 border-t border-line pt-4`}>Player statistics</h3>
      <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2 font-ui text-[12.5px] text-slate-body">
        <span>
          {status?.season_through ? `IPL careers through ${status.season_through}` : "Never refreshed"}
          {refreshed && <span className="text-slate-muted"> · refreshed {refreshed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>}
        </span>
        {status?.players_updated != null && (
          <span className="text-slate-muted">
            {status.players_updated} of {status.players_in_pool} players
            {status.split_coverage != null && ` · splits ${(status.split_coverage * 100).toFixed(0)}% covered`}
            {status.styles_pending ? ` · ${status.styles_pending} style lookups pending` : ""}
          </span>
        )}
        {due && <span className="text-slate-muted">next due {due.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>}
        {status?.state === "failed" && <span className="text-[var(--unsold)]">last attempt failed</span>}
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 font-ui text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-ink transition-colors hover:bg-surface-sunken disabled:opacity-50"
        >
          <RefreshCw size={12} className={running ? "animate-spin" : undefined} />
          {running ? "Refreshing…" : "Refresh stats now"}
        </button>
      </div>
      {note && <p className="mt-1 font-ui text-[11px] text-slate-muted">{note}</p>}
    </>
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

function KindChip({ kind }: { kind: "A" | "D" }) {
  return (
    <span
      className="grid h-6 w-8 shrink-0 place-items-center rounded-[4px] font-auctiq text-[11px] text-[#020617]"
      style={{ background: PASS_SWATCH[kind] }}
      title={kind === "A" ? "Auctioneer pass (gold)" : "Delegate pass (blue)"}
    >
      {kind}
    </span>
  );
}

/** Rows of [label, window, all-time], with gold and blue columns. */
function PassTable({ rows }: { rows: [string, PerKind, PerKind][] }) {
  return (
    <table className="mt-2 w-full font-ui text-[12.5px]">
      <thead>
        <tr className="text-left text-[10.5px] text-slate-faint">
          <th className="py-1.5 font-semibold" />
          {(["A", "D"] as const).map((kind) => (
            <th key={kind} className="py-1.5 text-right font-semibold">
              <span className="inline-flex items-center gap-1.5">
                <KindChip kind={kind} />
                {kind === "A" ? "Auctioneer" : "Delegate"}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map(([label, window, all]) => (
          <tr key={label}>
            <td className="py-1.5 text-slate-body">{label}</td>
            {(["A", "D"] as const).map((kind) => (
              <td key={kind} className="py-1.5 text-right">
                <span className="font-num text-[15px] font-bold text-slate-ink">{window[kind]}</span>
                <span className="ml-1.5 text-[11px] text-slate-faint">({all[kind]})</span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Auctions started per day: one series, so one hue and no legend (the heading
 * names it). Bars grow from a shared baseline; hovering a day shows all three
 * counts. A zero day keeps a hairline stub so the day is still visibly there.
 */
function PerDayChart({ rows }: { rows: AuctionDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(1, ...rows.map((r) => r.started));
  const shown = hover === null ? null : rows[hover];
  const everyNth = rows.length > 14 ? Math.ceil(rows.length / 7) : 1;

  return (
    <div className="mt-3">
      <div className="h-5 font-ui text-[11.5px] text-slate-muted" aria-live="polite">
        {shown
          ? `${shortDate(shown.day)} · ${shown.started} started · ${shown.finished} finished · ${shown.opened} rooms opened`
          : `Most in a day: ${Math.max(0, ...rows.map((r) => r.started))} · hover a day for details`}
      </div>
      <div className="mt-1 flex h-28 items-end gap-[2px] border-b border-line" onPointerLeave={() => setHover(null)}>
        {rows.map((row, i) => {
          const pct = (row.started / top) * 100;
          return (
            <button
              key={row.day}
              type="button"
              aria-label={`${shortDate(row.day)}: ${row.started} started, ${row.finished} finished`}
              onPointerEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              className="group flex h-full min-w-0 flex-1 items-end justify-center border-0 bg-transparent p-0 outline-none"
            >
              <span
                className="block w-full max-w-[28px] rounded-t-[4px] transition-opacity"
                style={{
                  // Inline, because a page-wide rule pads spans inside buttons.
                  padding: 0,
                  border: 0,
                  height: row.started ? `${pct}%` : "2px",
                  background: row.started ? BAR : "rgba(255,255,255,0.12)",
                  opacity: hover === null || hover === i ? 1 : 0.45,
                }}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex gap-[2px]">
        {rows.map((row, i) => (
          <span key={row.day} className="min-w-0 flex-1 truncate text-center font-ui text-[9.5px] text-slate-faint">
            {i % everyNth === 0 || i === rows.length - 1 ? shortDate(row.day) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
