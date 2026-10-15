/**
 * PoolGrid.tsx
 * The drag source: the filters and the card grid.
 *
 * Cards render 36 at a time. Every card carries a drag controller, a sprung
 * tilt and six GSAP counters, and mounting all 284 to show the first dozen
 * would spend a second of main thread on cards nobody has scrolled to. The
 * page resets to the first 36 whenever a filter changes, so a narrowed list
 * never opens scrolled past its own top.
 *
 * Sorting lives in the store (useFilteredPool): tier first, then rating, then
 * matches -- the order an auctioneer reads a catalogue.
 */
import { useEffect, useMemo, useState } from "react";

import { ROLE_NAMES, ROLE_ORDER, TIER_NAMES, type RoleCode, type TierCode } from "../../console/aucteamApi";
import { setFilter, useAucteam, useFilteredPool } from "../../console/aucteamStore";
import AucteamCard from "./AucteamCard";

const PAGE = 36;
const TIERS: TierCode[] = ["MQ", "PR", "EM"];

export default function PoolGrid() {
  const filters = useAucteam((s) => s.filters);
  const pool = useAucteam((s) => s.pool);
  const roster = useAucteam((s) => s.roster);
  const players = useFilteredPool();
  const [shown, setShown] = useState(PAGE);

  useEffect(() => setShown(PAGE), [filters]);

  const picked = useMemo(() => new Set(roster), [roster]);
  const tierCounts = useMemo(() => {
    const counts: Record<TierCode, number> = { MQ: 0, PR: 0, EM: 0 };
    for (const p of pool) counts[p.tier] += 1;
    return counts;
  }, [pool]);

  return (
    <section aria-label="Player pool">
      <div className="aq-filters" role="search">
        <div className="aq-seg" role="group" aria-label="Tier">
          <button type="button" aria-pressed={filters.tier === "ALL"} onClick={() => setFilter({ tier: "ALL" })}>
            All <span className="aq-count">{pool.length}</span>
          </button>
          {TIERS.map((tier) => (
            <button
              key={tier}
              type="button"
              data-tier={tier}
              aria-pressed={filters.tier === tier}
              onClick={() => setFilter({ tier })}
              title={`${TIER_NAMES[tier]} players`}
            >
              <span className="aq-dot" aria-hidden />
              {TIER_NAMES[tier]} <span className="aq-count">{tierCounts[tier]}</span>
            </button>
          ))}
        </div>

        <div className="aq-seg" role="group" aria-label="Role">
          <button type="button" aria-pressed={filters.role === "ALL"} onClick={() => setFilter({ role: "ALL" })}>
            Any role
          </button>
          {ROLE_ORDER.map((role: RoleCode) => (
            <button key={role} type="button" aria-pressed={filters.role === role} onClick={() => setFilter({ role })}>
              {role === "WK" ? "Keepers" : ROLE_NAMES[role]}
            </button>
          ))}
        </div>

        <input
          className="aq-search"
          type="search"
          value={filters.query}
          onChange={(event) => setFilter({ query: event.target.value })}
          placeholder="Search by name or country"
          aria-label="Search players"
        />
      </div>

      {players.length === 0 ? (
        <div className="aq-empty">
          No players match these filters. Clear the search or pick another tier.
        </div>
      ) : (
        <>
          <div className="aq-grid">
            {players.slice(0, shown).map((player, index) => (
              <AucteamCard key={player.id} player={player} picked={picked.has(player.id)} index={index} />
            ))}
          </div>
          {shown < players.length && (
            <button type="button" className="aq-more" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, players.length - shown)} more of {players.length - shown}
            </button>
          )}
        </>
      )}
    </section>
  );
}
