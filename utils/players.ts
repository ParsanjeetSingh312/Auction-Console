/**
 * players.ts
 * The showcase roster.
 *
 * On the images. Every player here is a real person, and their photographs and
 * likenesses are not ours to ship — the same reason the IPL logo and trophy are
 * drawn rather than fetched. So `image` is left null and `PlayerCard` renders a
 * generated portrait instead: jersey number, franchise colour, role glyph.
 *
 * That is not a placeholder in the apologetic sense. A numbered card in team
 * colours is a legitimate design for a sports showcase — it is what the back of
 * a shirt looks like — and it means the page ships complete rather than with
 * grey boxes waiting on an asset drop.
 *
 * To use real photography you have rights to: drop the files in `public/players/`
 * and set `image` to the public path, e.g. `/players/kohli.webp`. Nothing else
 * changes — `PlayerCard` prefers the image when one is present and falls back to
 * the generated portrait when it is not, so the two can be mixed while assets
 * arrive one at a time.
 *
 * `accent` is the franchise colour, lifted for a dark ground. The white theme's
 * values are too dark to read against #020617.
 */

export type ShowcaseRole = "BAT" | "BOWL" | "AR" | "WK";

export interface ShowcasePlayer {
  id: number;
  name: string;
  surname: string;
  /** Shirt number, used as the generated portrait's subject. */
  number: number;
  role: ShowcaseRole;
  roleLabel: string;
  country: string;
  /** Franchise colour, lifted for legibility on the dark ground. */
  accent: string;
  /** A single career figure worth putting on a card. */
  stat: string;
  statLabel: string;
  /** Licensed photograph, if you have one. Null renders the generated portrait. */
  image: string | null;
}

export const SHOWCASE_PLAYERS: ShowcasePlayer[] = [
  {
    id: 1,
    name: "Virat",
    surname: "Kohli",
    number: 18,
    role: "BAT",
    roleLabel: "Batter",
    country: "India",
    accent: "#E23744",
    stat: "8,004",
    statLabel: "IPL runs",
    image: null,
  },
  {
    id: 2,
    name: "Rohit",
    surname: "Sharma",
    number: 45,
    role: "BAT",
    roleLabel: "Batter",
    country: "India",
    accent: "#4D8DF6",
    stat: "6,628",
    statLabel: "IPL runs",
    image: null,
  },
  {
    id: 3,
    name: "MS",
    surname: "Dhoni",
    number: 7,
    role: "WK",
    roleLabel: "Wicket Keeper",
    country: "India",
    accent: "#F6C45A",
    stat: "264",
    statLabel: "dismissals",
    image: null,
  },
  {
    id: 4,
    name: "Jasprit",
    surname: "Bumrah",
    number: 93,
    role: "BOWL",
    roleLabel: "Bowler",
    country: "India",
    accent: "#4D8DF6",
    stat: "7.30",
    statLabel: "economy",
    image: null,
  },
  {
    id: 5,
    name: "Ravindra",
    surname: "Jadeja",
    number: 8,
    role: "AR",
    roleLabel: "All-Rounder",
    country: "India",
    accent: "#F6C45A",
    stat: "160",
    statLabel: "IPL wickets",
    image: null,
  },
  {
    id: 6,
    name: "KL",
    surname: "Rahul",
    number: 1,
    role: "WK",
    roleLabel: "Wicket Keeper",
    country: "India",
    accent: "#34D399",
    stat: "4,683",
    statLabel: "IPL runs",
    image: null,
  },
];

/** Role glyph colours, matching the console's role bands. */
export const ROLE_TINT: Record<ShowcaseRole, string> = {
  BAT: "#4D8DF6",
  BOWL: "#F87171",
  AR: "#34D399",
  WK: "#C4A6F5",
};
