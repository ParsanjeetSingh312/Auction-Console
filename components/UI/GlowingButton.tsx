/**
 * GlowingButton.tsx
 * The two controls at the foot of a neon panel.
 *
 * **It takes its colour from its panel.** Every value below is written against
 * `--neon`, the custom property `.neon-card` sets, so a button inside the cyan
 * panel is cyan and the same component inside the orange one is orange without
 * being told which. That is the same mechanism `.neon-rule` uses, and it means
 * recolouring a panel stays a one-line change rather than a hunt for every
 * child that hard-coded the old hue.
 *
 * **A `<button>`, not a Link.** `MagneticButton` is an anchor because it
 * navigates, and an anchor that navigates must be an anchor. These two do not
 * navigate — they act on the auction — so they are buttons, which is what gets
 * them space-and-enter activation and the right role for assistive tech.
 *
 * **Inert by design in this phase.** The brief is explicit that this is a
 * UI-only pass with no logic changes, so `onClick` is optional and these ship
 * without a handler. They are deliberately NOT `disabled`: a disabled control
 * is a statement that the action is unavailable, which would be a lie here and
 * would also drop them out of the tab order and grey them out of a design whose
 * whole point is how they look. When the socket layer is wired up, passing
 * `onClick` is the entire change.
 *
 * The brackets are decorative and `aria-hidden`, so the accessible name is
 * "Place bid" rather than "open bracket place bid close bracket".
 */
import type { ReactNode } from "react";

export interface GlowingButtonProps {
  children: ReactNode;
  /**
   * `solid`   — filled with the panel's hue, dark text. The primary action.
   * `outline` — hairline and text in the hue, transparent ground.
   */
  tone?: "solid" | "outline";
  onClick?: () => void;
  className?: string;
}

const TONES = {
  solid:
    "bg-[rgb(var(--neon))] text-auctiq-void shadow-[0_0_18px_-4px_rgb(var(--neon)/0.65)] hover:brightness-110",
  outline:
    "border border-[rgb(var(--neon)/0.55)] text-[rgb(var(--neon))] hover:border-[rgb(var(--neon)/0.9)] hover:bg-[rgb(var(--neon)/0.08)]",
} as const;

export default function GlowingButton({
  children,
  tone = "solid",
  onClick,
  className = "",
}: GlowingButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      /*
        min-h-[38px] rather than the 44px floor the landing's CTAs use. These sit
        inside a panel where vertical space is the scarcest thing there is, and
        they are secondary to the figure above them. 38px is still comfortably
        above the 24px minimum for a pointer target and the row stays reachable.
      */
      /* No `gap` on the flex row: the brackets are punctuation around the
         label, and a 4px gap renders them as "[ PLACE BID ]" where the
         reference has them closed up against the words. */
      className={`inline-flex min-h-[38px] flex-1 items-center justify-center rounded-[5px] px-3 font-tech text-[11px] font-semibold uppercase tracking-[0.12em] transition-all duration-200 ${TONES[tone]} ${className}`}
    >
      <span aria-hidden>[</span>
      {children}
      <span aria-hidden>]</span>
    </button>
  );
}
