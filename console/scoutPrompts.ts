/**
 * scoutPrompts.ts
 * The questions the console hands SCOUT on a user's behalf.
 *
 * A player card's "Ask Scout" used to send a one-line comparison question.
 * The SCOUT agents answer what they are asked and no more, so a vague question
 * got a vague answer. This spells out everything a bidder wants about one
 * player, tailored to the role -- a batter's matchups against pace and spin, a
 * bowler's economy against left- and right-handers -- and asks for the live
 * research (form, fitness, availability) the pool cannot hold.
 *
 * It opens with "Give me the statistics of <name>", so the question reads as
 * what it is in the transcript, and the rest tells the agents what a complete
 * answer contains.
 */
import { crore } from "../components/Auction/blockTypes";
import type { ConsolePlayer } from "./types";

const BATTING =
  "matches, runs, batting average, strike rate, strike rate against pace and against spin, " +
  "and boundary percentage against pace and against spin";
const BOWLING =
  "matches, wickets, economy, bowling average, bowling strike rate, " +
  "and economy against left-handed and right-handed batters";

/** "Give me the statistics of Virat Kohli — …", sized to the player's role. */
export function playerStatsPrompt(player: ConsolePlayer): string {
  const record =
    player.roleShort === "BOWL"
      ? `his complete IPL career bowling record (${BOWLING})`
      : player.roleShort === "AR"
        ? `his complete IPL career record with bat (${BATTING}) and with ball (${BOWLING})`
        : `his complete IPL career batting record (${BATTING})` +
          (player.roleShort === "WK" ? ", plus his role behind the stumps" : "");

  const who = [
    player.roleShort === "WK" ? "wicket-keeper" : player.role.toLowerCase(),
    player.overseas ? "overseas" : "Indian",
    player.cap === "UNCAPPED" ? "uncapped" : "capped",
  ].join(", ");

  return (
    `Give me the statistics of ${player.name} (${who}). ` +
    `Include ${record}; ` +
    "his form and key performances in the latest IPL season; any injury, fitness or availability news; " +
    "where he is strongest and where he is exposed; " +
    `and what all of that means for his auction value against a base price of ${crore(player.base)}.`
  );
}
