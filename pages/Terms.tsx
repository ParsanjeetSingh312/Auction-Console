/**
 * Terms.tsx
 * The `/terms` route: AUCTONIQ's Terms of Service.
 *
 * Plain terms for a free simulation: what the service is, what an account may
 * do, what passes are (and are not), and the disclaimer the rest of the site
 * already carries (LEGAL_DISCLAIMER in AuctiqNav.tsx).
 */
import { Link } from "react-router-dom";

import LegalPage from "../components/Legal/LegalPage";
import type { LegalSection } from "../components/Legal/LegalPage";
import { LEGAL_DISCLAIMER } from "../components/Global/AuctiqNav";
import { CONTACT_EMAIL } from "../console/legal";

const mail = <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;

const SECTIONS: LegalSection[] = [
  {
    id: "the-service",
    title: "The service",
    body: (
      <>
        <p>
          AUCTONIQ is a virtual cricket auction simulator for entertainment, strategic analysis and learning. By
          creating an account or using the site you agree to these terms and to our{" "}
          <Link to="/privacy">Privacy Policy</Link>.
        </p>
        <p className="legal-callout">{LEGAL_DISCLAIMER}</p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Your account",
    body: (
      <ul>
        <li>Give accurate details, keep your password to yourself, and tell us if you think someone else is using your account.</li>
        <li>One person per account. You are responsible for what happens under your account.</li>
        <li>Account types decide what you can do: Auctioneers run auction rooms, Delegates take franchise seats, and Free accounts use the rest of the site.</li>
      </ul>
    ),
  },
  {
    id: "passes",
    title: "Auction passes",
    body: (
      <ul>
        <li>Auction passes are free, in-app tokens that open an auction room or take a franchise seat.</li>
        <li><strong>Passes have no monetary value.</strong> They cannot be bought, sold, exchanged for money or redeemed for anything outside AUCTONIQ.</li>
        <li>A pass sent to you and not claimed within 14 days goes back to its sender.</li>
        <li>We may change how passes work, or reset balances, to keep the service fair.</li>
      </ul>
    ),
  },
  {
    id: "auctions",
    title: "Auction rooms",
    body: (
      <ul>
        <li>The auctioneer of a room sets its rules and runs it. Once an auction starts, delegates hold their seats until it finishes.</li>
        <li>Player data and ratings are provided for the simulation and may be incomplete or out of date.</li>
        <li>Results are part of a game and carry no real-world entitlement.</li>
      </ul>
    ),
  },
  {
    id: "google",
    title: "Google Calendar",
    body: (
      <p>
        Connecting Google Calendar is optional. When connected, AUCTONIQ adds, updates and removes calendar events
        only for the auctions you schedule, as described in the <Link to="/privacy#google">Privacy Policy</Link>.
        You can disconnect at any time from your Account page. Your use of Google Calendar is also subject to
        Google&apos;s own terms.
      </p>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <p>Please do not:</p>
        <ul>
          <li>use AUCTONIQ for betting, gambling or any real-money arrangement;</li>
          <li>harass other people, or impersonate anyone;</li>
          <li>try to break, overload or get around the security or limits of the service;</li>
          <li>scrape the service or resell access to it.</li>
        </ul>
        <p>We may suspend or close accounts that break these terms.</p>
      </>
    ),
  },
  {
    id: "liability",
    title: "No warranty",
    body: (
      <p>
        AUCTONIQ is provided free and &ldquo;as is&rdquo;. We work to keep it available and accurate but cannot
        promise it will always be, and to the extent the law allows we are not liable for losses arising from using
        it.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes and contact",
    body: (
      <p>
        We may update these terms; the date at the top of the page shows the latest version. Continuing to use
        AUCTONIQ after a change means you accept it. Questions: {mail}.
      </p>
    ),
  },
];

export default function Terms() {
  return (
    <LegalPage
      title="Terms of Service"
      documentTitle="Terms of Service · AUCTONIQ"
      intro={<p>These terms cover using AUCTONIQ: your account, auction passes, auction rooms and what is not allowed.</p>}
      sections={SECTIONS}
    />
  );
}
