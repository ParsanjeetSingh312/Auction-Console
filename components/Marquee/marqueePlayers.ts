/**
 * marqueePlayers.ts
 * The players who get a marquee reveal when they are put on the block.
 *
 * Five for now, the trending list. Each has a tagline (supplied by
 * Parsanjeet), the franchise colours their sparks and jersey number are drawn
 * in, and three highlight stats -- the figures that make the player who they
 * are, not a full scorecard.
 *
 * Every figure is from the project's own pool (`IPL AUCTION DATA.xlsx`, the
 * table SCOUT and the data room read), so a number on the reveal never
 * disagrees with one on the next screen. Matched to the pool by name rather
 * than id, because ids differ between the local SQLite file and Supabase.
 *
 * Franchises are named by city, as the room names its teams, and coloured
 * from their kits. Gujarat's navy is too dark to read as light on a night
 * ground, so its spark leads with a lifted navy and its secondary is gold.
 */

export interface MarqueeTeam {
  /** The room's city name for the franchise. */
  city: string;
  /** Spark, jersey number and accent colour. */
  primary: string;
  /** Mixed into the sparks and used for the lightning's core. */
  secondary: string;
}

export interface MarqueeStat {
  value: number;
  label: string;
  decimals?: number;
}

export interface MarqueePlayer {
  /** Exactly as the pool spells it -- the match key. */
  poolName: string;
  firstName: string;
  surname: string;
  jersey: number;
  role: string;
  tagline: string;
  team: MarqueeTeam;
  stats: [MarqueeStat, MarqueeStat, MarqueeStat];
}

const TEAMS = {
  bengaluru: { city: "Bengaluru", primary: "#E8202A", secondary: "#D9B44A" },
  chennai: { city: "Chennai", primary: "#FFCB05", secondary: "#2E6FD8" },
  mumbai: { city: "Mumbai", primary: "#2F7BFF", secondary: "#D9B44A" },
  gujarat: { city: "Ahmedabad", primary: "#3D6BC7", secondary: "#C9A44C" },
} satisfies Record<string, MarqueeTeam>;

export const MARQUEE_PLAYERS: MarqueePlayer[] = [
  {
    poolName: "Virat Kohli",
    firstName: "Virat",
    surname: "Kohli",
    jersey: 18,
    role: "Batter",
    tagline: "The Chase Master",
    team: TEAMS.bengaluru,
    stats: [
      { value: 7697, label: "IPL runs" },
      { value: 44.49, label: "Batting average", decimals: 2 },
      { value: 150.75, label: "Strike rate vs pace", decimals: 2 },
    ],
  },
  {
    poolName: "Rohit Sharma",
    firstName: "Rohit",
    surname: "Sharma",
    jersey: 45,
    role: "Batter",
    tagline: "The Hitman",
    team: TEAMS.mumbai,
    stats: [
      { value: 257, label: "IPL matches" },
      { value: 6628, label: "IPL runs" },
      { value: 18.1, label: "Boundary % vs pace", decimals: 1 },
    ],
  },
  {
    poolName: "MS Dhoni",
    firstName: "MS",
    surname: "Dhoni",
    jersey: 7,
    role: "Wicket Keeper",
    tagline: "Captain Cool",
    team: TEAMS.chennai,
    stats: [
      { value: 264, label: "IPL matches" },
      { value: 152.6, label: "Strike rate vs pace", decimals: 1 },
      { value: 39.13, label: "Batting average", decimals: 2 },
    ],
  },
  {
    poolName: "Jasprit Bumrah",
    firstName: "Jasprit",
    surname: "Bumrah",
    jersey: 93,
    role: "Bowler",
    tagline: "Yorker King",
    team: TEAMS.mumbai,
    stats: [
      { value: 184, label: "IPL wickets" },
      { value: 7.3, label: "Economy", decimals: 2 },
      { value: 19.5, label: "Balls per wicket", decimals: 1 },
    ],
  },
  {
    poolName: "Shubman Gill",
    firstName: "Shubman",
    surname: "Gill",
    jersey: 77,
    role: "Batter",
    tagline: "Gill Da Mamla",
    team: TEAMS.gujarat,
    stats: [
      { value: 4598, label: "IPL runs" },
      { value: 40.33, label: "Batting average", decimals: 2 },
      { value: 142.09, label: "Strike rate", decimals: 2 },
    ],
  },
];

/** The marquee entry for a pool player, by name. Null for everyone else. */
export function marqueeFor(playerName: string | null | undefined): MarqueePlayer | null {
  if (!playerName) return null;
  const key = playerName.trim().toLowerCase();
  return MARQUEE_PLAYERS.find((p) => p.poolName.toLowerCase() === key) ?? null;
}
