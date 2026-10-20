/**
 * passPowers.ts
 * What each pass can do, printed on the back of the card (FlipPass.tsx).
 *
 * Kept as data so the card stays a drawing and the wording can change in one
 * place. The powers are the product's real rules (accounts/passes.py,
 * auction/room.py); a line added here should be something the pass actually
 * unlocks.
 */
import type { PassKind } from "../../console/ecosystemStore";

export interface PassPowers {
  title: string;
  tagline: string;
  powers: string[];
}

export const POWERS: Record<PassKind, PassPowers> = {
  A: {
    title: "Auctioneer powers",
    tagline: "Run the room",
    powers: [
      "Opens one auctioneer room for up to 12 franchises",
      "Takes the chair: put players up, sell, undo",
      "Invites delegates; starts when all have acknowledged",
      "Sets the purse, squad size and overseas limits",
      "Unlocks the post-auction report for every team",
    ],
  },
  D: {
    title: "Delegate powers",
    tagline: "Take a seat, win the player",
    powers: [
      "Takes one franchise seat in an auctioneer's room",
      "Bid live: raise, jump +5/+10/+15 Cr, or withdraw",
      "Three 30-second decision buffers per auction",
      "Or opens a delegate room of your own",
      "Spent once per room; rejoining is free",
    ],
  },
};

/** One line under the powers, depending on who is holding the card. */
export function holderNote(kind: PassKind, tier: "admin" | "auctioneer" | "delegate" | "member" | null): string {
  if (tier === "admin") return "Administrators open rooms free and send both passes without limit.";
  if (tier === "auctioneer") {
    return kind === "A"
      ? "Granted by an administrator."
      : "Generate up to 50 a day and send them to your delegates.";
  }
  if (kind === "D") return "Sent to you by your auctioneer.";
  return "Held by auctioneers.";
}
