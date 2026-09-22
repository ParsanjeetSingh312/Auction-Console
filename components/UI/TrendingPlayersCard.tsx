/**
 * TrendingPlayersCard.tsx
 * The orange panel: who else is worth watching.
 *
 * **On the columns.** The reference draws this as a table with fixed SR and ECO
 * headings, and that is the one thing from the mockup deliberately not carried
 * over. Strike rate is a batting figure and economy is a bowling one; a bowler's
 * "strike rate" means balls per wicket, a different quantity wearing the same
 * label. A uniform pair of columns across mixed roles therefore forces either
 * blank cells or numbers that quietly mean different things row to row.
 *
 * The product already solved this. `utils/players.ts` gives every player a
 * single `stat`/`statLabel` chosen to suit their role — Bumrah carries an
 * economy, Dhoni dismissals, Kohli runs — and `PlayerCard` renders exactly that
 * pair in gold beneath the name. This panel reuses it, so the hero and the
 * showcase below describe a player the same way instead of inventing a second
 * vocabulary for the same six people.
 *
 * `CAREER` is honest as a single heading in a way `SR` is not: every figure
 * under it is a career total or average, whatever the metric happens to be.
 *
 * **On the roster.** `slice(1)` — everyone except the player currently on the
 * block, who is the subject of the panel above. Deriving it rather than listing
 * five names means the two panels can never drift into showing the same player
 * as both "on the block" and "also worth watching".
 */
import { ROLE_TINT, SHOWCASE_PLAYERS } from "../../utils/players";

/** Everyone but the player on the block in LiveBiddingCard. */
const TRENDING = SHOWCASE_PLAYERS.slice(1);

export default function TrendingPlayersCard() {
  return (
    <article className="neon-card neon-card--orange flex flex-col p-4">
      <h2 className="font-stadium text-[17px] font-semibold uppercase tracking-[0.04em] text-auctiq-text">
        Trending Players
      </h2>
      <div className="neon-rule mt-2" />

      {/*
        A real table, not a grid of divs. Five rows of figures with a header is
        tabular data by any definition, and the markup is what lets a screen
        reader announce "Bumrah, career, 7.30 economy" instead of reading six
        loose numbers in a row.
      */}
      <table className="mt-3 w-full border-separate border-spacing-y-[5px]">
        <thead>
          <tr className="font-tech text-[9px] uppercase tracking-[0.18em] text-auctiq-dim/70">
            <th scope="col" className="w-5 text-left font-medium">
              #
            </th>
            <th scope="col" className="text-left font-medium">
              Player
            </th>
            <th scope="col" className="text-right font-medium">
              Career
            </th>
          </tr>
        </thead>
        <tbody>
          {TRENDING.map((player, i) => (
            <tr key={player.id}>
              <td className="font-num text-[12px] tabular-nums text-auctiq-dim">
                {i + 1}
              </td>
              <td>
                <div className="flex items-center gap-2">
                  <span className="truncate font-tech text-[12.5px] font-semibold uppercase tracking-[0.03em] text-auctiq-text">
                    {player.surname}
                  </span>
                  <RoleBadge role={player.role} label={player.role} />
                </div>
              </td>
              {/*
                Figure and label on one line, right-aligned, the figure in gold
                and the label dim — the same treatment PlayerCard gives it, so a
                row here and a card in the showcase read as the same object.
              */}
              <td className="whitespace-nowrap text-right">
                <span className="font-num text-[13px] font-bold tabular-nums text-auctiq-gold">
                  {player.stat}
                </span>
                <span className="ml-1.5 font-tech text-[9px] uppercase tracking-[0.1em] text-auctiq-dim">
                  {player.statLabel}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-auto pt-3 font-tech text-[9.5px] uppercase tracking-[0.16em] text-auctiq-dim/70">
        Five of 284 in the pool
      </p>
    </article>
  );
}

/**
 * The role glyph, tinted from the same map the showcase cards use.
 *
 * The tint is inlined rather than mapped to a Tailwind class because
 * `ROLE_TINT` is data: a class name built at runtime from a variable is exactly
 * the string Tailwind's scanner cannot see, and the colour would be dropped
 * from the build with nothing to explain why.
 */
function RoleBadge({ role, label }: { role: keyof typeof ROLE_TINT; label: string }) {
  return (
    <span
      className="shrink-0 rounded-[3px] px-1.5 py-[1px] font-tech text-[8.5px] font-bold uppercase tracking-[0.08em]"
      style={{ color: ROLE_TINT[role], background: `${ROLE_TINT[role]}1F` }}
    >
      {label}
    </span>
  );
}
