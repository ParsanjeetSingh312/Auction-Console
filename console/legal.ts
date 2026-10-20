/**
 * legal.ts
 * The few facts the Privacy Policy and Terms of Service state, in one place.
 *
 * Google's OAuth verification compares the policy against what the app really
 * does (accounts/google_calendar.py), so anything here that changes in the
 * code should change here too: the scopes, what is stored, and how to remove it.
 */

/** Where people write about their data or account. Shown on both pages. */
export const CONTACT_EMAIL = "support@auctoniq.com";

/** Shown at the top of each page; update it whenever the wording changes. */
export const LAST_UPDATED = "20 October 2026";

/** The Google OAuth scopes the "Connect Google Calendar" flow asks for. */
export const GOOGLE_SCOPES: { scope: string; why: string }[] = [
  {
    scope: "openid, email",
    why: "To show you which Google account is connected to your AUCTONIQ schedule.",
  },
  {
    scope: "https://www.googleapis.com/auth/calendar.events",
    why: "To add the auctions you schedule in AUCTONIQ to your Google Calendar, and to change or remove those same events when you change or remove the auction.",
  },
];
