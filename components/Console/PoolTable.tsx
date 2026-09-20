/**
 * PoolTable.tsx
 * The filter strip and the pool sheet — the console's main working surface.
 *
 * The 296-row dummy array the prototype shipped with is gone; every row here is
 * a `ConsolePlayer` hydrated from GET /api/v1/players, which is the same table
 * the vector index was built from. That matters beyond tidiness: a player the
 * Scout recommends is guaranteed to exist in this table, so the hand-off
 * between the two halves of the console can never dangle.
 *
 * Rendering is capped at 400 rows. Sorting and filtering run over the whole
 * pool; only the DOM is truncated, because a 300-row table with eleven columns
 * is already at the edge of what re-renders smoothly on every keystroke.
 */
import { useMemo } from "react";
import { motion } from "framer-motion";

import {
  cssVars,
  moneyTight,
  ratingLabel,
  ratingPct,
  ROLE_LABELS,
  roleGlyphClass,
  roleGlyphText,
  setMeta,
} from "../../console/format";
import { panelVariants } from "../../console/motion";
import { runQuery } from "../../console/search";
import type { AuctionEngine } from "../../console/useAuctionEngine";
import type {
  CapStatus,
  ConsolePlayer,
  PoolFilters,
  RoleShort,
  SortKey,
} from "../../console/types";

const RENDER_CAP = 400;

/**
 * How far down the sheet the entrance stagger keeps counting.
 *
 * Rows past this index all share the last delay, so the whole sweep finishes in
 * about 240ms whether the filter matched fourteen players or four hundred. An
 * uncapped stagger over RENDER_CAP rows would take seven seconds to reach the
 * bottom of the table.
 */
const STAGGER_CAP = 13;

const ROLE_CHIPS: RoleShort[] = ["BAT", "BOWL", "AR", "WK"];
const STATUS_CHIPS: PoolFilters["status"][] = ["all", "available", "sold", "unsold"];
const CAP_CHIPS: (CapStatus | "all")[] = ["all", "CAPPED", "UNCAPPED"];

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "sno", label: "#", className: "c-no" },
  { key: "set", label: "Band", className: "c-set" },
  { key: "name", label: "Player", className: "c-name" },
  { key: "country", label: "Country" },
  { key: "role", label: "Role" },
  { key: "cap", label: "C/UC" },
  { key: "base", label: "Base", className: "c-num" },
  { key: "rating", label: "Rating", className: "c-num" },
  { key: "status", label: "Status" },
  { key: "price", label: "Price", className: "c-num" },
];

export interface PoolTableProps {
  engine: AuctionEngine;
  query: string;
  filters: PoolFilters;
  onFiltersChange: (next: PoolFilters) => void;
  sortKey: SortKey;
  sortDir: 1 | -1;
  onSort: (key: SortKey) => void;
  onOpenCard: (player: ConsolePlayer) => void;
  onNotice: (message: string, kind?: "err") => void;
}

export default function PoolTable({
  engine,
  query,
  filters,
  onFiltersChange,
  sortKey,
  sortDir,
  onSort,
  onOpenCard,
  onNotice,
}: PoolTableProps) {
  const { players, recordFor, teams, block, teamById } = engine;

  /** Country options, built from the pool rather than a hardcoded list. */
  const countries = useMemo(() => {
    const seen = new Set<string>();
    for (const player of players) if (player.country) seen.add(player.country);
    return Array.from(seen).sort();
  }, [players]);

  const bands = useMemo(() => {
    const seen = new Set(players.map((player) => player.set));
    return Array.from(seen).sort();
  }, [players]);

  const rows = useMemo(() => {
    const passes = (player: ConsolePlayer): boolean => {
      const record = recordFor(player.id);
      if (filters.status !== "all" && record.status !== filters.status) return false;
      if (filters.role !== "all" && player.roleShort !== filters.role) return false;
      if (filters.cap !== "all" && player.cap !== filters.cap) return false;
      if (filters.set !== "all" && player.set !== filters.set) return false;
      if (filters.country !== "all" && player.country !== filters.country) return false;
      // An absent rating is "not rated", never "rated zero" — two thirds of the
      // pool has no rating, and treating null as below the floor would hide
      // them all the moment the slider moved off its minimum.
      if (player.rating != null && player.rating < filters.minRating) return false;
      return true;
    };

    const hits = runQuery(players.filter(passes), query, {
      recordFor,
      teams,
      onBlockId: block?.playerId ?? null,
    });

    const value = (player: ConsolePlayer): string | number => {
      const record = recordFor(player.id);
      switch (sortKey) {
        case "set":
          return player.set;
        case "name":
          return player.surname + player.first;
        case "country":
          return player.country ?? "ZZZ";
        case "role":
          return player.roleShort;
        case "cap":
          return player.cap;
        case "base":
          return player.base;
        case "rating":
          return player.rating ?? -1;
        case "status":
          return record.status;
        case "price":
          return record.price ?? -1;
        default:
          return player.sno;
      }
    };

    return hits.slice().sort((a, b) => {
      const x = value(a.player);
      const y = value(b.player);
      const primary =
        typeof x === "number" && typeof y === "number"
          ? (x - y) * sortDir
          : String(x).localeCompare(String(y)) * sortDir;
      // Sheet order is the tiebreaker, so equal keys never shuffle between
      // renders.
      return primary || a.player.sno - b.player.sno;
    });
  }, [players, recordFor, teams, block, query, filters, sortKey, sortDir]);

  function set<K extends keyof PoolFilters>(key: K, value: PoolFilters[K]) {
    onFiltersChange({ ...filters, [key]: value });
  }

  function putUp(player: ConsolePlayer) {
    const result = engine.putOnBlock(player.id);
    if (!result.ok && result.message) onNotice(result.message, "err");
  }

  return (
    <>
      <motion.div className="filters" variants={panelVariants}>
        <div className="fgroup">
          <span className="eyebrow">Status</span>
          {STATUS_CHIPS.map((option) => (
            <button
              key={option}
              type="button"
              className="chip"
              aria-pressed={filters.status === option}
              onClick={() => set("status", option)}
            >
              {option === "all" ? "All" : option[0].toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>

        <div className="fgroup">
          <span className="eyebrow">Role</span>
          <button
            type="button"
            className="chip"
            aria-pressed={filters.role === "all"}
            onClick={() => set("role", "all")}
          >
            All
          </button>
          {ROLE_CHIPS.map((role) => (
            <button
              key={role}
              type="button"
              className="chip"
              aria-pressed={filters.role === role}
              title={ROLE_LABELS[role]}
              onClick={() => set("role", role)}
            >
              {role}
            </button>
          ))}
        </div>

        <div className="fgroup">
          <span className="eyebrow">Cap</span>
          {CAP_CHIPS.map((option) => (
            <button
              key={option}
              type="button"
              className="chip"
              aria-pressed={filters.cap === option}
              onClick={() => set("cap", option)}
            >
              {option === "all" ? "All" : option === "CAPPED" ? "Capped" : "Uncapped"}
            </button>
          ))}
        </div>

        <div className="fgroup">
          <span className="eyebrow">Band</span>
          <select
            className="pick"
            aria-label="Filter by band"
            value={filters.set}
            onChange={(event) => set("set", event.target.value)}
          >
            <option value="all">All bands</option>
            {bands.map((code) => (
              <option key={code} value={code}>
                {code} · {setMeta(code).label}
              </option>
            ))}
          </select>
        </div>

        <div className="fgroup">
          <span className="eyebrow">Country</span>
          <select
            className="pick"
            aria-label="Filter by country"
            value={filters.country}
            onChange={(event) => set("country", event.target.value)}
          >
            <option value="all">All countries</option>
            {countries.map((country) => (
              <option key={country} value={country}>
                {country}
              </option>
            ))}
          </select>
        </div>

        <div className="fgroup rate">
          <span className="eyebrow">Min rating</span>
          <input
            type="range"
            min={8}
            max={9.75}
            step={0.25}
            value={filters.minRating}
            aria-label="Minimum rating"
            onChange={(event) => set("minRating", Number(event.target.value))}
          />
          <output className="num">{filters.minRating.toFixed(2)}</output>
        </div>

        <div className="push">
          <span className="eyebrow">
            {rows.length} of {players.length} shown
          </span>
          <button
            type="button"
            className="linkbtn"
            onClick={() =>
              onFiltersChange({
                status: "all",
                role: "all",
                cap: "all",
                set: "all",
                country: "all",
                minRating: 8,
              })
            }
          >
            Reset filters
          </button>
        </div>
      </motion.div>

      <motion.div className="tablewrap" variants={panelVariants}>
        <div className="max-h-[calc(100vh-320px)] overflow-auto">
          <table className="sheet">
            <thead>
              <tr>
                <th className="c-rail" aria-hidden />
                {COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={`sortable ${column.className ?? ""}`}
                    aria-sort={
                      sortKey === column.key
                        ? sortDir === 1
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    onClick={() => onSort(column.key)}
                  >
                    {column.label}
                    <span
                      aria-hidden
                      className={`ml-1 ${sortKey === column.key ? "opacity-100" : "opacity-0"}`}
                    >
                      {sortDir === 1 ? "▲" : "▼"}
                    </span>
                  </th>
                ))}
                <th className="c-act" aria-label="Actions" />
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length + 2}>
                    <div className="empty">
                      <b>Nothing matches</b>
                      Loosen a filter, or clear the search to see all {players.length} players.
                    </div>
                  </td>
                </tr>
              )}

              {rows.slice(0, RENDER_CAP).map(({ player }, index) => {
                const record = recordFor(player.id);
                const meta = setMeta(player.set);
                const onBlock = block?.playerId === player.id;
                const team = teamById(record.teamId);

                return (
                  <tr
                    key={player.id}
                    className={`row-in ${
                      onBlock ? "is-block" : record.status === "sold" ? "is-sold" : ""
                    }`}
                    style={cssVars({ "--i": String(Math.min(index, STAGGER_CAP)) })}
                  >
                    <td className="c-rail" style={{ background: meta.rail }} />
                    <td className="c-no">{player.sno}</td>
                    <td className="c-set">
                      <span
                        className="setpill"
                        style={cssVars({ "--band": meta.band })}
                        title={`${meta.label}${player.setDerived ? " · derived from role and cap status" : ""}`}
                      >
                        {player.set}
                      </span>
                    </td>
                    <td className="c-name">
                      <button type="button" onClick={() => onOpenCard(player)}>
                        {player.first && <span className="fn">{player.first} </span>}
                        <span className="sn">{player.surname}</span>
                      </button>
                    </td>
                    <td>
                      <span className={`flag${player.overseas ? " is-os" : ""}`}>
                        {player.country ?? "—"}
                      </span>
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={`roleglyph ${roleGlyphClass(player.roleShort)}`}
                          aria-hidden
                        >
                          {roleGlyphText(player.roleShort)}
                        </span>
                        <span className="text-mini text-ink-soft">{player.roleShort}</span>
                      </span>
                    </td>
                    <td className="font-mono text-[10.5px]">
                      {player.cap === "CAPPED" ? "C" : "UC"}
                    </td>
                    <td
                      className={`c-num font-mono ${player.baseAssumed ? "text-muted italic" : ""}`}
                      title={
                        player.baseAssumed
                          ? "No base price in the dataset — the auction floor is assumed"
                          : undefined
                      }
                    >
                      {moneyTight(player.base)}
                      {player.baseAssumed && "*"}
                    </td>
                    <td className="c-num">
                      {player.rating == null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <span className="ratebar">
                          <span className="ratebar-v num">{ratingLabel(player.rating)}</span>
                          <span className="ratebar-t">
                            <i style={{ width: `${ratingPct(player.rating)}%` }} />
                          </span>
                        </span>
                      )}
                    </td>
                    <td>
                      <StatusTag
                        onBlock={onBlock}
                        status={record.status}
                        teamCode={team?.code ?? null}
                      />
                    </td>
                    <td className={`c-num font-mono ${record.price ? "font-semibold" : ""}`}>
                      {record.price ? moneyTight(record.price) : "·"}
                    </td>
                    <td className="c-act">
                      {record.status === "sold" ? (
                        <button
                          type="button"
                          className="mini"
                          onClick={() => {
                            const result = engine.returnToPool(player.id);
                            if (result.message) onNotice(result.message);
                          }}
                        >
                          Release
                        </button>
                      ) : (
                        <button type="button" className="mini" onClick={() => putUp(player)}>
                          {onBlock ? "On block" : "Put up"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}

              {rows.length > RENDER_CAP && (
                <tr>
                  <td colSpan={COLUMNS.length + 2}>
                    <div className="empty">
                      Showing the first {RENDER_CAP} of {rows.length} matches.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="tfoot">
          <span className="eyebrow">
            {rows.length} rows · sorted by {sortKey} {sortDir > 0 ? "↑" : "↓"}
          </span>
          <span className="eyebrow">
            ✈ overseas · — not in the dataset · * base price assumed
          </span>
        </div>
      </motion.div>
    </>
  );
}

function StatusTag({
  onBlock,
  status,
  teamCode,
}: {
  onBlock: boolean;
  status: string;
  teamCode: string | null;
}) {
  if (onBlock) return <span className="tag tag-live">On block</span>;
  if (status === "sold") return <span className="tag tag-sold">{teamCode ?? "Sold"}</span>;
  if (status === "unsold") return <span className="tag tag-unsold">Unsold</span>;
  return <span className="tag tag-neutral">In pool</span>;
}
