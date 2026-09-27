/**
 * PoolGrid.tsx
 * The player pool as boxes, grouped by role.
 *
 * The structure comes from the second reference: four columns — BATTERS,
 * ALL-ROUNDERS, WICKET KEEPERS, BOWLERS — each a stack of boxes carrying a
 * name, a capped/uncapped pill, a price and two figures. The card geometry and
 * the hover behaviour come from the prototype's `player/PlayerCard.tsx`: the
 * jersey number set large behind the content, a role tint, and a lift.
 *
 * **It does not replace `PoolTable`.** The sheet is still there behind a
 * toggle, with its eleven sortable columns and its market-data gating intact.
 * This is the view that opens first, because it is the one the reference calls
 * for; the sheet is one click away for anyone who wants to sort by rating.
 *
 * **The filtering and sorting are not done here.** `PoolTable` already owns
 * that pipeline — the chips, the search query, the rating floor, the role
 * gate — and this receives the result. Two copies of that logic would drift,
 * and the first symptom would be the grid and the sheet disagreeing about how
 * many players match a filter.
 *
 * **The figures are role-aware, never a fixed grid.** `statLines` already
 * returns the right pair per role — a bowler gets economy and bowling average
 * where a batter gets average and strike rate — because the pool stores one set
 * or the other per player and never both. A uniform column set would leave half
 * the boxes blank or, worse, print a batting label over a bowling number.
 *
 * **Hover is CSS, orchestration is GSAP.** The prototype splits it the same
 * way and states why: hover has to survive a pointer moving across forty-eight
 * cards, and attaching JS handlers to each is work per frame that a `transition`
 * declaration does for free on the compositor. GSAP drives the things CSS
 * cannot see — the page-change stagger below.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import { money, statLines } from "../../console/format";
import type {
  AuctionRecord,
  ConsolePlayer,
  RoleShort,
} from "../../console/types";

gsap.registerPlugin(useGSAP);

/**
 * Players per column, per page.
 *
 * **Ten, fixed, so every column is the same length.** That is the requirement:
 * four columns of equal height leave no uneven gap between them, which is what
 * the page is judged on.
 *
 * It is worth recording what this trades away, because it was tried the other
 * way first. The roles are very unevenly sized — 99 bowlers against 48 wicket
 * keepers — so a fixed slice means the shorter columns exhaust before the
 * longer ones: keepers finish around page 5 while bowlers need all ten. An
 * earlier version sized each column's slice in proportion to its own role total
 * so that all four ran out together, and that kept every page full at the cost
 * of columns of visibly different heights on *every* page. Between an uneven
 * page early and a short column late, the even page wins: the first page is the
 * one everybody sees.
 *
 * `items-start` on the grid is what keeps the late pages honest — a column that
 * has run out ends, rather than stretching into an empty bordered box.
 */
const PER_COLUMN = 10;

/** The columns, in the reference's order. */
const COLUMNS: { key: RoleShort; label: string }[] = [
  { key: "BAT", label: "Batters" },
  { key: "AR", label: "All-rounders" },
  { key: "WK", label: "Wicket keepers" },
  { key: "BOWL", label: "Bowlers" },
];

/**
 * Role tints, carried over from the prototype's player card.
 *
 * A grid of three hundred boxes in one colour reads as a spreadsheet; the tint
 * is what lets the eye find the bowlers without reading a single label.
 */
const TINT: Record<RoleShort, string> = {
  BAT: "#22d3ee",
  BOWL: "#34d399",
  AR: "#b58cff",
  WK: "#f6c45a",
};

export interface PoolGridProps {
  /** Already filtered and sorted by PoolTable. */
  players: ConsolePlayer[];
  recordFor: (id: number) => AuctionRecord;
  /** True for the auctioneer: sold prices and status become visible. */
  showMarket: boolean;
  onOpenCard: (player: ConsolePlayer) => void;
}

export default function PoolGrid({
  players,
  recordFor,
  showMarket,
  onOpenCard,
}: PoolGridProps) {
  const container = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);

  /** The whole filtered pool, split by role. Paging happens inside each. */
  const byRole = useMemo(() => {
    const buckets: Record<RoleShort, ConsolePlayer[]> = {
      BAT: [],
      AR: [],
      WK: [],
      BOWL: [],
    };
    for (const player of players) buckets[player.roleShort]?.push(player);
    return buckets;
  }, [players]);

  /**
   * Driven by the largest role, so no player is unreachable.
   *
   * Taking the pool total instead would under-count: 284 players over 40 a page
   * is 8 pages, but the 99 bowlers alone need 10 at ten a page, and the last 19
   * of them would have no page to appear on.
   */
  const pages = Math.max(
    1,
    ...COLUMNS.map((column) => Math.ceil(byRole[column.key].length / PER_COLUMN)),
  );

  /*
    Snap back to page one whenever the result set changes.

    Without this, filtering 284 players down to nine while sitting on page four
    leaves an empty grid and a pager reading "Page 4 of 1" — which looks like
    the filter matched nothing rather than like the page being out of range.
  */
  useEffect(() => {
    setPage(1);
  }, [players.length]);

  // Belt and braces: a page can also fall out of range if the pool shrinks
  // between renders without its length landing on the effect above.
  const current = Math.min(page, pages);

  /** This page's slice of each column. */
  const grouped = useMemo(() => {
    const from = (current - 1) * PER_COLUMN;
    const out = {} as Record<RoleShort, ConsolePlayer[]>;
    for (const column of COLUMNS) {
      out[column.key] = byRole[column.key].slice(from, from + PER_COLUMN);
    }
    return out;
  }, [byRole, current]);

  /**
   * Only the columns that have someone on this page.
   *
   * The roles are unevenly sized, so on the later pages the shorter ones run
   * out — keepers finish around page 5 while bowlers need all ten. Rendering an
   * empty bordered box for them leaves exactly the uneven gap this layout is
   * supposed to avoid, so the column is dropped instead and the survivors take
   * the width.
   *
   * The count chip in each header still reports the role's full total, so a
   * column disappearing reads as "that role is exhausted", not as data going
   * missing.
   */
  const visibleColumns = useMemo(
    () => COLUMNS.filter((column) => grouped[column.key].length > 0),
    [grouped],
  );

  /*
    The stagger, on every page change.

    Capped by using a short `each` rather than a per-card delay: forty-eight
    cards at 0.03s finish in under a second, where a longer step would still be
    animating the last column after the user had started reading the first.
  */
  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(".pool-box", {
          y: 10,
          autoAlpha: 0,
          duration: 0.34,
          ease: "power3.out",
          stagger: { each: 0.03, from: "start" },
        });
      });
      return () => media.revert();
    },
    { dependencies: [current, players.length], scope: container },
  );

  if (players.length === 0) {
    return (
      <div className="panel px-4 py-10 text-center">
        <span className="eyebrow">No player matches these filters</span>
      </div>
    );
  }

  return (
    <div ref={container}>
      {/*
        `auto-fit` rather than a fixed four.

        Two jobs in one declaration. It is the responsive rule — as many 240px
        columns as the width allows, so this is one column on a phone and four
        on a desktop with no breakpoints to keep in sync. And it is what makes a
        dropped column close up: with three sections left, three tracks are
        created and they stretch to fill the row, instead of three sitting in a
        four-track grid beside a hole.

        `items-start`, not the default `stretch`, because grid siblings
        otherwise all grow to the tallest — which is what put 1995px of empty
        space inside the All-rounders box in the first version.
      */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] items-start gap-3">
        {visibleColumns.map((column) => (
          <section
            key={column.key}
            className="rounded-xl border border-[var(--rule)] bg-[var(--card)] p-2.5"
            style={{ ["--tint" as string]: TINT[column.key] }}
          >
            <header className="mb-2.5 flex items-center justify-between px-1">
              <h3 className="font-ui text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]">
                {column.label}
              </h3>
              <span
                className="rounded-full px-1.5 py-px font-num text-[10px] font-semibold"
                style={{
                  color: TINT[column.key],
                  background: `color-mix(in oklab, ${TINT[column.key]} 14%, transparent)`,
                }}
              >
                {byRole[column.key].length}
              </span>
            </header>

            <ul className="space-y-2">
              {grouped[column.key].map((player) => (
                <PlayerBox
                  key={player.id}
                  player={player}
                  record={recordFor(player.id)}
                  showMarket={showMarket}
                  onOpen={onOpenCard}
                />
              ))}

            </ul>
          </section>
        ))}
      </div>

      {pages > 1 && (
        <nav
          className="flex items-center justify-center gap-4 py-5"
          aria-label="Pagination"
        >
          <PagerButton
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={current <= 1}
          >
            ← Prev
          </PagerButton>

          <span className="font-ui text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
            Page <span className="font-num text-[var(--ink)]">{current}</span> of{" "}
            <span className="font-num text-[var(--ink)]">{pages}</span>
            <span className="mx-2 opacity-40">·</span>
            <span className="font-num text-[var(--ink)]">{players.length}</span>{" "}
            players
          </span>

          <PagerButton
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            disabled={current >= pages}
          >
            Next →
          </PagerButton>
        </nav>
      )}
    </div>
  );
}

function PagerButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-[var(--rule)] px-3.5 py-1.5 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--ink-2)] transition-colors hover:border-[var(--teal)] hover:text-[var(--teal)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-[var(--rule)] disabled:hover:text-[var(--ink-2)]"
    >
      {children}
    </button>
  );
}

/**
 * One player, as a box.
 *
 * A button rather than a div: opening the detail card is the whole point of the
 * box, and a keyboard user should reach it by tabbing rather than not at all.
 */
function PlayerBox({
  player,
  record,
  showMarket,
  onOpen,
}: {
  player: ConsolePlayer;
  record: AuctionRecord;
  showMarket: boolean;
  onOpen: (player: ConsolePlayer) => void;
}) {
  const tint = TINT[player.roleShort];

  // Two figures, chosen by role. `statLines` leads with Matches, which is the
  // least interesting of the three here, so it is dropped.
  const figures = statLines(player).slice(1, 3);

  const sold = showMarket && record.status === "sold";
  const unsold = showMarket && record.status === "unsold";

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(player)}
        style={{ ["--tint" as string]: tint }}
        className={`pool-box group relative block w-full overflow-hidden rounded-lg border border-[var(--rule)] bg-[var(--paper)] p-2.5 text-left transition-[transform,border-color,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:border-[color-mix(in_oklab,var(--tint)_55%,transparent)] hover:shadow-[0_0_28px_-14px_var(--tint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tint)] ${
          sold || unsold ? "opacity-75 hover:opacity-100" : ""
        }`}
      >
        {/* The jersey number, set large behind the content and allowed to
            bleed. Absent for most of the pool — an unverified number at this
            size would be the most prominent lie on the page — in which case
            nothing is drawn and the layout is unchanged. */}
        {player.jersey != null && (
          <span
            aria-hidden
            className="pointer-events-none absolute -top-1 right-1 select-none font-num text-[34px] font-bold leading-none transition-transform duration-500 ease-out group-hover:scale-110"
            style={{ color: `color-mix(in oklab, ${tint} 20%, transparent)` }}
          >
            {player.jersey}
          </span>
        )}

        <div className="relative">
          <div className="flex items-start justify-between gap-2">
            <span className="font-ui text-[12.5px] font-bold leading-tight text-[var(--ink)]">
              {player.name}
            </span>
            <span
              className="mt-px flex-none rounded-full border px-1.5 py-px font-ui text-[8.5px] font-semibold uppercase tracking-[0.1em]"
              style={{
                borderColor: `color-mix(in oklab, ${tint} 45%, transparent)`,
                color: tint,
              }}
            >
              {player.cap === "CAPPED" ? "Capped" : "Uncapped"}
            </span>
          </div>

          {/* The price. Base by default — the Data Interface is the
              participant's view and has no business showing what a player
              went for. An auctioneer sees the sale instead. */}
          <div className="mt-1 flex items-baseline gap-1.5">
            <span
              className="font-num text-[14px] font-bold leading-none"
              style={{ color: sold ? "var(--sold)" : tint }}
            >
              {sold && record.price != null ? money(record.price) : money(player.base)}
            </span>
            <span className="font-ui text-[8.5px] uppercase tracking-[0.12em] text-[var(--muted)]">
              {sold ? "sold" : unsold ? "unsold · base" : "base"}
            </span>
            {player.baseAssumed && !sold && (
              <span
                className="font-ui text-[8.5px] text-[var(--muted)]"
                title="No base price in the dataset; the auction floor is shown instead"
              >
                ~
              </span>
            )}
          </div>

          {figures.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5 font-ui text-[10px] text-[var(--muted)]">
              {figures.map((figure) => (
                <span key={figure.label}>
                  {figure.label}{" "}
                  <span className="font-num text-[var(--ink-2)]">
                    {figure.value}
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="mt-1 font-ui text-[9px] uppercase tracking-[0.1em] text-[var(--muted)] opacity-70">
            {player.country ?? (player.overseas ? "Overseas" : "—")}
            <span className="mx-1 opacity-50">·</span>
            {player.set}
          </div>
        </div>
      </button>
    </li>
  );
}
