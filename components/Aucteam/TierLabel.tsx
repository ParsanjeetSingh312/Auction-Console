/**
 * TierLabel.tsx
 * The two-letter neon tag that sits above the jersey number: MQ, PR or EM.
 *
 * The colour comes from `data-tier` on this element (see aucteam.css), so the
 * label is correct wherever it is placed, not only inside a card that already
 * set the tier.
 */
import { TIER_NAMES, type TierCode } from "../../console/aucteamApi";

export default function TierLabel({
  tier,
  small = false,
  reason,
}: {
  tier: TierCode;
  small?: boolean;
  /** Why this player is in this tier, shown on hover. */
  reason?: string;
}) {
  return (
    <span
      className={`aq-tier${small ? " aq-tier--sm" : ""}`}
      data-tier={tier}
      title={reason ? `${TIER_NAMES[tier]}: ${reason}` : `${TIER_NAMES[tier]} player`}
      aria-label={`${TIER_NAMES[tier]} player`}
    >
      {tier}
    </span>
  );
}
