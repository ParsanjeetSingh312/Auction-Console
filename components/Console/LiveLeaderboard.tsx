/**
 * LiveLeaderboard.tsx
 * The auction's standings, live: every franchise ranked, moving as lots
 * settle, with the statistics that explain the ranking.
 *
 * Read from the room's own `standings` (auction/leaderboard.py), so every
 * screen ranks the same way. Four rankings:
 *
 *   Spend       who has committed hardest -- predicts the next lot
 *   Value       AUCTONIQ value bought minus price paid: who is buying well
 *   Strength    mean pool percentile of the squad's ratings: who is strongest
 *   Purse left  who still has the most to spend
 *
 * Bars carry their own value labels, sorted descending, and nothing is told
 * by colour alone (the skill's ranking-chart guidance); a sortable table is
 * one click away as the accessible view of the same numbers.
 *
 * Motion is split by job. Framer Motion: rows physically reorder (layout),
 * bars grow, the sort pill slides. GSAP: figures count to their new values,
 * a row flashes its franchise colour when its numbers change, the rank
 * arrow pops, and each squad's spending curve draws itself in.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ArrowDown, ArrowUp, BarChart3, Table2 } from "lucide-react";

import { moneyTight } from "../../console/format";
import { franchiseByCode } from "../../console/franchises";
import type { Standing, StandingSale, Standings } from "../../hooks/useAuctionSocket";

gsap.registerPlugin(useGSAP);

type SortKey = "spent" | "value" | "strength" | "left";

const SORTS: { key: SortKey; label: string; hint: string }[] = [
  { key: "spent", label: "Spend", hint: "Who has committed hardest" },
  { key: "value", label: "Value", hint: "AUCTONIQ value bought minus price paid, calibrated to this room's prices" },
  { key: "strength", label: "Strength", hint: "Mean pool percentile of the squad's ratings" },
  { key: "left", label: "Purse left", hint: "Who still has the most to spend" },
];

const VERDICT_TONE: Record<string, string> = {
  steal: "#34D399",
  "good bid": "#22D3EE",
  "fair price": "#F6C45A",
  "paid over": "#FB923C",
};

const ROLE_TONE: Record<string, string> = { WK: "#C084FC", BAT: "#4D8DF6", AR: "#34D399", BOWL: "#FB923C" };

function signedCr(lakh: number): string {
  if (lakh === 0) return "±0";
  return `${lakh > 0 ? "+" : "−"}${moneyTight(Math.abs(lakh))}`;
}

function metric(row: Standing, key: SortKey): number {
  return key === "spent" ? row.spent : key === "value" ? row.value : key === "strength" ? row.strength : row.left;
}

function display(row: Standing, key: SortKey): string {
  if (key === "strength") return `${row.strength}`;
  if (key === "value") return signedCr(row.value);
  return moneyTight(metric(row, key));
}

/** A figure that counts to each new value (GSAP), instead of jumping. */
function Tally({ value, format }: { value: number; format: (n: number) => string }) {
  const node = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  const reduce = useReducedMotion();
  const fmt = useRef(format);
  fmt.current = format;
  useEffect(() => {
    if (!node.current) return;
    if (reduce) {
      node.current.textContent = fmt.current(value);
      shown.current = value;
      return;
    }
    const state = { v: shown.current };
    const tween = gsap.to(state, {
      v: value,
      duration: 0.7,
      ease: "power2.out",
      onUpdate: () => {
        shown.current = state.v;
        if (node.current) node.current.textContent = fmt.current(Math.round(state.v));
      },
    });
    return () => {
      tween.kill();
    };
  }, [value, reduce]);
  return <span ref={node}>{format(value)}</span>;
}

export default function LiveLeaderboard({ standings, maxSquad, maxOverseas }: {
  standings: Standings;
  maxSquad: number;
  maxOverseas: number;
}) {
  const [sort, setSort] = useState<SortKey>("spent");
  const [view, setView] = useState<"bars" | "table">("bars");
  const reduce = useReducedMotion();

  const ranked = useMemo(
    () => [...standings.teams].sort((a, b) => metric(b, sort) - metric(a, sort) || a.code.localeCompare(b.code)),
    [standings.teams, sort],
  );

  // Rank movement since the last change of standings (not of sort).
  const previous = useRef<Record<number, number>>({});
  const lastSort = useRef(sort);
  const [moves, setMoves] = useState<Record<number, number>>({});
  useEffect(() => {
    const now: Record<number, number> = {};
    ranked.forEach((row, i) => (now[row.id] = i));
    if (lastSort.current === sort) {
      const delta: Record<number, number> = {};
      for (const [id, rank] of Object.entries(now)) {
        const before = previous.current[Number(id)];
        if (before !== undefined && before !== rank) delta[Number(id)] = before - rank;
      }
      if (Object.keys(delta).length) {
        setMoves(delta);
        const timer = window.setTimeout(() => setMoves({}), 4000);
        previous.current = now;
        return () => window.clearTimeout(timer);
      }
    }
    lastSort.current = sort;
    previous.current = now;
  }, [ranked, sort]);

  const top = Math.max(1, ...ranked.map((row) => Math.abs(metric(row, sort))));
  const room = standings.room;

  return (
    // Not `.ledger`: that caps the panel at a third of the screen, which suits
    // a compact list, not a board of every franchise.
    <div className="flex flex-col" style={{ background: "var(--card)" }} data-testid="live-leaderboard">
      <div className="flex flex-wrap items-center gap-2 border-b px-[14px] py-[7px]" style={{ borderColor: "var(--rule)" }}>
        <span className="flex items-center gap-2">
          <span className="eyebrow">Live leaderboard</span>
          <span className="relative flex h-2 w-2" aria-hidden>
            {!reduce && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <LayoutGroup id="board-sort">
            <div className="flex rounded-lg border border-line bg-surface-sunken p-0.5" role="radiogroup" aria-label="Rank by">
              {SORTS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="radio"
                  aria-checked={sort === option.key}
                  title={option.hint}
                  onClick={() => setSort(option.key)}
                  className={`relative z-0 rounded-md px-2 py-1 font-ui text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors ${
                    sort === option.key ? "text-white" : "text-slate-muted hover:text-slate-ink"
                  }`}
                >
                  {sort === option.key && (
                    <motion.span
                      layoutId="board-sort-pill"
                      className="absolute inset-0 -z-10 rounded-md bg-slate-ink"
                      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 36 }}
                    />
                  )}
                  {option.label}
                </button>
              ))}
            </div>
          </LayoutGroup>
          <button
            type="button"
            onClick={() => setView((v) => (v === "bars" ? "table" : "bars"))}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 font-ui text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-muted hover:text-slate-ink"
            aria-label={view === "bars" ? "Show as a table" : "Show as bars"}
          >
            {view === "bars" ? <Table2 size={12} /> : <BarChart3 size={12} />}
            {view === "bars" ? "Table" : "Bars"}
          </button>
        </div>
      </div>

      {/* The room at a glance. */}
      <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
        {[
          { label: "Sold", value: <Tally value={room.sold} format={(n) => String(n)} />, note: `${room.unsold} unsold` },
          { label: "Spent", value: <Tally value={room.spent} format={moneyTight} />, note: "across the room" },
          { label: "Average buy", value: <Tally value={room.avg_price} format={moneyTight} />, note: `median ${moneyTight(room.median_price)}` },
          {
            label: "Record buy",
            value: room.record ? moneyTight(room.record.price) : "—",
            note: room.record ? `${room.record.player} · ${room.record.team_code}` : "nothing sold yet",
          },
        ].map((tile) => (
          <div key={tile.label} className="bg-surface-card px-3 py-2.5">
            <div className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.14em] text-slate-faint">{tile.label}</div>
            <div className="mt-0.5 font-num text-[20px] font-bold leading-tight text-slate-ink">{tile.value}</div>
            <div className="truncate font-ui text-[10.5px] text-slate-faint">{tile.note}</div>
          </div>
        ))}
      </div>

      <RecentSales recent={standings.recent} />

      {view === "bars" ? (
        <motion.ol className="divide-y divide-line" layout>
          {ranked.map((row, index) => (
            <BoardRow
              key={row.id}
              row={row}
              rank={index + 1}
              move={moves[row.id] ?? 0}
              sort={sort}
              share={Math.abs(metric(row, sort)) / top}
              maxSquad={maxSquad}
              maxOverseas={maxOverseas}
            />
          ))}
        </motion.ol>
      ) : (
        <BoardTable rows={ranked} sort={sort} onSort={setSort} maxSquad={maxSquad} />
      )}
    </div>
  );
}

function BoardRow({ row, rank, move, sort, share, maxSquad, maxOverseas }: {
  row: Standing;
  rank: number;
  move: number;
  sort: SortKey;
  share: number;
  maxSquad: number;
  maxOverseas: number;
}) {
  const reduce = useReducedMotion();
  const root = useRef<HTMLLIElement>(null);
  const tone = franchiseByCode(row.code)?.primary ?? row.color ?? "#94A3B8";
  const negative = sort === "value" && row.value < 0;
  const signature = `${row.spent}:${row.size}`;
  const seen = useRef(signature);

  const { contextSafe } = useGSAP({ scope: root });
  const flash = contextSafe(() => {
    if (reduce || !root.current) return;
    gsap.fromTo(root.current, { backgroundColor: `${tone}40` }, { backgroundColor: "rgba(0,0,0,0)", duration: 1.6, ease: "power2.out", clearProps: "backgroundColor" });
    gsap.fromTo(".spark-line", { strokeDashoffset: 120 }, { strokeDashoffset: 0, duration: 0.9, ease: "power2.out" });
  });
  useEffect(() => {
    if (seen.current !== signature) {
      seen.current = signature;
      flash();
    }
  }, [signature, flash]);

  const rolesTotal = Math.max(1, row.size);
  return (
    <motion.li
      ref={root}
      layout
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 38 }}
      className="relative px-3 py-2.5"
      data-testid="board-row"
      data-team={row.code}
    >
      <div className="flex items-center gap-3">
        <div className="flex w-7 flex-col items-center">
          <span className="font-num text-[15px] font-bold text-slate-ink">{rank}</span>
          <AnimatePresence>
            {move !== 0 && (
              <motion.span
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ opacity: 0 }}
                className={`flex items-center font-ui text-[9px] font-bold ${move > 0 ? "text-emerald-400" : "text-rose-400"}`}
                aria-label={move > 0 ? `up ${move}` : `down ${-move}`}
              >
                {move > 0 ? <ArrowUp size={9} /> : <ArrowDown size={9} />}
                {Math.abs(move)}
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        <span className="h-9 w-[3px] shrink-0 rounded-full" style={{ background: tone }} aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-num text-[15px] font-bold text-slate-ink">{row.code}</span>
            <span className="truncate font-ui text-[11px] text-slate-faint">{row.name}</span>
            <span className="ml-auto font-num text-[15px] font-bold tabular-nums" style={{ color: negative ? "#FB923C" : undefined }}>
              {sort === "strength" ? (
                <Tally value={row.strength} format={(n) => String(n)} />
              ) : sort === "value" ? (
                <Tally value={row.value} format={signedCr} />
              ) : (
                <Tally value={metric(row, sort)} format={moneyTight} />
              )}
            </span>
          </div>

          {/* The ranked measure, as a bar against the leader. */}
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
            <motion.div
              className="h-full rounded-full"
              style={{ background: negative ? "#FB923C" : tone }}
              initial={false}
              animate={{ width: `${Math.max(2, share * 100)}%` }}
              transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 22 }}
            />
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-ui text-[10.5px] text-slate-muted">
            <span title="Squad against the limit">
              squad <b className="text-slate-ink">{row.size}</b>/{maxSquad}
            </span>
            <span title="Overseas against the limit">
              OS <b className="text-slate-ink">{row.overseas}</b>/{maxOverseas}
            </span>
            <span>avg <b className="text-slate-ink">{moneyTight(row.avg_price)}</b></span>
            <span title="AUCTONIQ value bought minus price paid. Calibrated to what this room pays, so it re-levels with every sale." style={{ color: row.value > 0 ? "#34D399" : row.value < 0 ? "#FB923C" : undefined }}>
              value {signedCr(row.value)}
            </span>
            {row.steals > 0 && <span className="text-emerald-400">{row.steals} steal{row.steals === 1 ? "" : "s"}</span>}
            {row.top_buy && (
              <span className="truncate">
                top <b className="text-slate-ink">{row.top_buy.player}</b> {moneyTight(row.top_buy.price)}
              </span>
            )}
          </div>

          {/* Role mix, labelled, and the spending curve. */}
          {row.size > 0 && (
            <div className="mt-1.5 flex items-center gap-3">
              <div className="flex h-3.5 min-w-0 flex-1 overflow-hidden rounded" aria-label="Role mix">
                {(["WK", "BAT", "AR", "BOWL"] as const).map((role) =>
                  row.roles[role] ? (
                    <motion.span
                      key={role}
                      layout
                      className="grid place-items-center font-ui text-[8.5px] font-bold text-[#020617]"
                      style={{ background: ROLE_TONE[role], width: `${(row.roles[role] / rolesTotal) * 100}%` }}
                      title={`${row.roles[role]} ${role}`}
                    >
                      {role} {row.roles[role]}
                    </motion.span>
                  ) : null,
                )}
              </div>
              <Sparkline points={row.curve} tone={tone} />
            </div>
          )}
        </div>
      </div>
    </motion.li>
  );
}

/** Cumulative spend after each buy, drawn in when it changes (GSAP, above). */
function Sparkline({ points, tone }: { points: number[]; tone: string }) {
  if (points.length < 2) return <span className="w-16" aria-hidden />;
  const max = Math.max(...points);
  const step = 64 / (points.length - 1);
  const d = points.map((p, i) => `${(i * step).toFixed(1)},${(20 - (p / max) * 18).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 64 22" className="h-5 w-16 shrink-0 overflow-visible" aria-label="Spend over the auction">
      <polyline className="spark-line" points={d} fill="none" stroke={tone} strokeWidth="1.6" strokeLinejoin="round" strokeDasharray="120" />
    </svg>
  );
}

/** The last few sales, sliding in newest first, each with its verdict. */
function RecentSales({ recent }: { recent: StandingSale[] }) {
  const reduce = useReducedMotion();
  if (!recent.length) return null;
  return (
    <div className="border-b border-line px-3 py-2">
      <div className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.14em] text-slate-faint">Live results</div>
      <ul className="mt-1.5 flex gap-2 overflow-x-auto pb-1">
        <AnimatePresence initial={false} mode="popLayout">
          {recent.map((sale) => (
            <motion.li
              key={sale.seq ?? sale.player}
              layout
              initial={reduce ? false : { opacity: 0, x: -24, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0 }}
              className="shrink-0 rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5"
            >
              <div className="max-w-[150px] truncate font-ui text-[11.5px] font-semibold text-slate-ink">{sale.player}</div>
              <div className="mt-0.5 flex items-center gap-1.5 font-ui text-[10px] text-slate-muted">
                <span className="font-num font-bold" style={{ color: franchiseByCode(sale.team_code)?.primary }}>{sale.team_code}</span>
                {moneyTight(sale.price)}
                {sale.verdict && (
                  <span className="rounded-full px-1.5 font-bold uppercase text-[#020617]" style={{ background: VERDICT_TONE[sale.verdict] }}>
                    {sale.verdict}
                  </span>
                )}
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

/** The same standings as a sortable table: the accessible view. */
function BoardTable({ rows, sort, onSort, maxSquad }: {
  rows: Standing[];
  sort: SortKey;
  onSort: (key: SortKey) => void;
  maxSquad: number;
}) {
  const header = (key: SortKey, label: string) => (
    <th aria-sort={sort === key ? "descending" : "none"} className="px-2 py-1.5 text-right">
      <button type="button" onClick={() => onSort(key)} className={`font-semibold uppercase ${sort === key ? "text-slate-ink" : ""}`}>
        {label}{sort === key ? " ↓" : ""}
      </button>
    </th>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-ui text-[11.5px] text-slate-body">
        <thead className="text-[9.5px] tracking-[0.1em] text-slate-faint">
          <tr>
            <th className="px-2 py-1.5 text-left">#</th>
            <th className="px-2 py-1.5 text-left">Team</th>
            {header("spent", "Spent")}
            {header("left", "Left")}
            {header("value", "Value")}
            {header("strength", "Strength")}
            <th className="px-2 py-1.5 text-right">Squad</th>
            <th className="px-2 py-1.5 text-right">WK/BAT/AR/BOWL</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, i) => (
            <tr key={row.id}>
              <td className="px-2 py-1.5 font-num font-bold">{i + 1}</td>
              <td className="px-2 py-1.5 font-num font-bold text-slate-ink">{row.code}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{moneyTight(row.spent)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{moneyTight(row.left)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{signedCr(row.value)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{row.strength}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{row.size}/{maxSquad}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {row.roles.WK}/{row.roles.BAT}/{row.roles.AR}/{row.roles.BOWL}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
