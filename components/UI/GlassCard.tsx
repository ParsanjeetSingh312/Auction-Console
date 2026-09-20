/**
 * GlassCard.tsx
 * The dark glassmorphic surface, in one place.
 *
 * The border does more work than the blur. On a near-black ground a translucent
 * panel has no edge at all — without the hairline the card dissolves into the
 * page and the blur is invisible, because there is nothing behind it with
 * enough contrast to smear. That is why every variant below keeps a border even
 * when it drops almost everything else.
 *
 * `as` exists so a card can be a section, an article or a link without wrapping
 * it in another div — an extra element in a grid is an extra thing to fight
 * when the layout changes.
 */
import type { ElementType, ReactNode } from "react";

export interface GlassCardProps {
  children: ReactNode;
  /** Element to render. Defaults to a div. */
  as?: ElementType;
  /**
   * `panel` — the standard raised card.
   * `soft`  — quieter, for secondary content that should recede.
   * `solid` — nearly opaque, for anything carrying dense text, where a
   *           translucent ground makes small type painful to read.
   */
  variant?: "panel" | "soft" | "solid";
  /** Gold hairline across the top edge, for the one card that matters most. */
  rail?: boolean;
  className?: string;
  [key: string]: unknown;
}

const VARIANTS = {
  panel: "border-white/10 bg-white/[0.04] shadow-glass backdrop-blur-xl",
  soft: "border-white/[0.07] bg-white/[0.025] backdrop-blur-md",
  solid: "border-white/10 bg-auctiq-card/85 shadow-glass backdrop-blur-xl",
} as const;

export default function GlassCard({
  children,
  as: Tag = "div",
  variant = "panel",
  rail = false,
  className = "",
  ...rest
}: GlassCardProps) {
  return (
    <Tag
      className={`relative overflow-hidden rounded-2xl border ${VARIANTS[variant]} ${
        rail ? "gold-rail" : ""
      } ${className}`}
      {...rest}
    >
      {children}
    </Tag>
  );
}
