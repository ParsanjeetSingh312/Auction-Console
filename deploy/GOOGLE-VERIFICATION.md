# Google Calendar: getting AUCTONIQ verified

Calendar access (`calendar.events`) is a **sensitive** scope. While the Google
Cloud app is in *Testing* mode it works only for listed test users and asks
them to reconnect every 7 days. Publishing it removes both limits, but first
Google reviews the app. This file is everything that review asks for.

Replace `auctoniq.com` below if the final domain is different.

---

## 1. What the website already has (done in code)

| Google requirement | Where it is |
| --- | --- |
| Public homepage that explains the app, with no login needed | `/` (the intro screen describes AUCTONIQ and links About, Privacy and Terms) and `/about` |
| Privacy policy on the same domain, linked from the homepage | `/privacy`, linked from the intro screen, the footer of every public page and the sign-up form |
| Privacy policy says what Google data is used, why, how it is stored and removed | `/privacy#google` |
| The Limited Use statement | `/privacy#google`, the highlighted box |
| Terms of service | `/terms` |
| The app explains the access before asking for it | Account → Schedule, under *Connect Google Calendar* |
| Users can disconnect and the app deletes its tokens | Account → Schedule → *Disconnect* (also revokes the token with Google) |
| Only the scope that is needed | `calendar.events` (events only, never calendar settings or sharing), plus `openid email` |

The contact email shown on both pages is set in `console/legal.ts`
(`CONTACT_EMAIL`, now `support@auctoniq.com`). **Create that mailbox before
submitting**: Google may write to it.

---

## 2. Before you submit

1. auctoniq.com is live and serves AUCTONIQ over `https` (see the domain steps).
2. In **Google Search Console** (search.google.com/search-console), add the
   property `auctoniq.com` as a **Domain** property, then add the TXT record it
   gives you at your DNS provider. Do this with a Google account that is an
   **Owner or Editor of the Google Cloud project**.
3. In Google Cloud → OAuth client → **Authorised redirect URIs**, add
   `https://auctoniq.com/api/v1/schedule/google/callback`, and set the same
   value as `GOOGLE_REDIRECT_URL` on Railway.
4. Open `https://auctoniq.com/privacy` and `https://auctoniq.com/terms` in a
   private window to confirm they load without logging in.

---

## 3. What to fill in (Google Cloud → Google Auth Platform)

### Branding

| Field | Value |
| --- | --- |
| App name | `AUCTONIQ` (exactly as on the website) |
| User support email | `support@auctoniq.com` |
| App logo | Optional. Uploading one adds a logo review, so leave it out the first time. |
| Application home page | `https://auctoniq.com` |
| Application privacy policy link | `https://auctoniq.com/privacy` |
| Application terms of service link | `https://auctoniq.com/terms` |
| Authorised domains | `auctoniq.com` |
| Developer contact email | your email |

### Data access (scopes)

- `openid`
- `.../auth/userinfo.email`
- `.../auth/calendar.events`

**Justification for `calendar.events`** (paste into the form):

> AUCTONIQ is a cricket auction simulator. Auctioneers schedule their upcoming
> auctions inside AUCTONIQ. When an auctioneer chooses "Connect Google
> Calendar", AUCTONIQ creates a Google Calendar event for each auction they
> schedule, and updates or deletes that same event when they change or cancel
> the auction in AUCTONIQ. We never read, change or delete any event that
> AUCTONIQ did not create. A narrower scope is not sufficient because we must
> create events and later update and delete them; `calendar.events` is the
> narrowest scope that allows this without access to calendar settings,
> sharing or other calendars. Connecting is optional and can be undone at any
> time from the user's Account page, which deletes our stored tokens and
> revokes access.

### Audience

- User type: **External**
- Publishing status: click **Publish app**, then **Prepare for verification**.

---

## 4. The demo video

Google asks for an unlisted YouTube video (2–4 minutes is enough). Record the
screen, in English, showing:

1. The browser address bar on `https://auctoniq.com`, then the homepage and
   the **Privacy Policy** link opening `/privacy`.
2. Logging in to an **Auctioneer** account and opening **Account**.
3. The Schedule panel: point out the sentence explaining what AUCTONIQ does
   with calendar access.
4. Clicking **Connect Google Calendar**. On Google's consent screen, show the
   app name and the requested permissions clearly (the address bar should
   show the OAuth client ID).
5. Back on AUCTONIQ: the "Google Calendar connected" message.
6. Scheduling an auction, then opening **Google Calendar** to show the new
   "AUCTONIQ · …" event.
7. Changing the auction's time in AUCTONIQ and showing the event move; then
   removing it and showing the event disappear.
8. Clicking **Disconnect**.

---

## 5. After submitting

- Google replies by email to the developer contact, sometimes asking for small
  changes (most often: the privacy-policy wording, or the video not showing
  the consent screen clearly). Answer by replying to that thread.
- While in review, the app keeps working for test users exactly as now.
- If the code ever asks for a new scope, or the Google data use changes,
  update `/privacy` (`pages/Privacy.tsx` and `console/legal.ts`) **before**
  shipping it, and expect a new review.
