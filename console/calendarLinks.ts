/**
 * calendarLinks.ts
 * "Add to calendar" links for a scheduled auction, with no sign-in.
 *
 *   Google   calendar.google.com's own event-template link: it opens Google
 *            Calendar with the event filled in, and the person clicks Save.
 *   .ics     the server's iCalendar file (/api/v1/calendar/<token>/ics), which
 *            Apple Calendar, Outlook and Google all import.
 *
 * Neither keeps the event in step afterwards: if the auction moves, people
 * add it again. That is the trade for needing no Google verification.
 */
import { apiUrl } from "./apiBase";

export interface CalendarEvent {
  title: string;
  room_type: "auctioneer" | "delegate";
  /** Epoch seconds. */
  starts_at: number;
  duration_min: number;
  notes: string;
  host?: string | null;
}

/** 20261024T133000Z: the compact UTC form both Google and iCalendar use. */
function stamp(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function details(event: CalendarEvent): string {
  const room = event.room_type === "auctioneer" ? "Auctioneer room" : "Delegate room";
  const parts = [`${room} on AUCTONIQ${event.host ? `, run by ${event.host}` : ""}.`];
  if (event.notes) parts.push(event.notes);
  parts.push(`Join on the day: ${window.location.origin}/auction/live`);
  return parts.join("\n\n");
}

/** Google Calendar's "create event" page, pre-filled. */
export function googleCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `AUCTONIQ · ${event.title}`,
    dates: `${stamp(event.starts_at)}/${stamp(event.starts_at + event.duration_min * 60)}`,
    details: details(event),
    location: `${window.location.origin}/auction/live`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** The .ics download for a shared auction. */
export function icsUrl(token: string): string {
  return apiUrl(`/api/v1/calendar/${encodeURIComponent(token)}/ics`);
}

/** The public page delegates open: `/calendar/<token>`, on this site. */
export function sharePageUrl(token: string): string {
  return `${window.location.origin}/calendar/${token}`;
}
