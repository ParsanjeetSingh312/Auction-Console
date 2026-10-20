/**
 * noticeStyle.tsx
 * How each kind of notification looks, shared by the bell's list and the
 * popups so a message wears the same colour and icon in both.
 */
import { AlarmClock, CalendarPlus, Gift, Megaphone, RotateCcw, Sparkles, UserPlus } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { Notice } from "../../console/ecosystemStore";

interface Look {
  icon: LucideIcon;
  /** The accent: icon, edge glow, progress bar. */
  tone: string;
  eyebrow: string;
}

export function lookOf(notice: Notice): Look {
  if (notice.gift) {
    const gold = notice.gift.kind === "A";
    return {
      icon: notice.kind === "welcome" ? Sparkles : Gift,
      tone: gold ? "#F6C45A" : "#4D8DF6",
      eyebrow: notice.kind === "welcome" ? "Welcome gift" : gold ? "Gold pass received" : "Blue pass received",
    };
  }
  switch (notice.kind) {
    case "welcome":
      return { icon: Sparkles, tone: "#F6C45A", eyebrow: "Welcome" };
    case "gift_returned":
      return { icon: RotateCcw, tone: "#94A3B8", eyebrow: "Passes returned" };
    case "connection":
      return { icon: UserPlus, tone: "#C084FC", eyebrow: "Connection" };
    case "reminder":
      return { icon: AlarmClock, tone: "#FB923C", eyebrow: "Starting soon" };
    case "schedule":
      return { icon: CalendarPlus, tone: "#C084FC", eyebrow: "Auction scheduled" };
    default:
      return { icon: Megaphone, tone: "#E3B23C", eyebrow: "Announcement" };
  }
}

export function ago(seconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - seconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Days left on an unclaimed gift, in words. */
export function expiresIn(at: number): string {
  const days = Math.ceil((at - Date.now() / 1000) / 86400);
  return days <= 1 ? "expires today" : `expires in ${days} days`;
}
