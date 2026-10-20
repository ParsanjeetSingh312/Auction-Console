/**
 * Privacy.tsx
 * The `/privacy` route: AUCTONIQ's Privacy Policy.
 *
 * Written to what the code actually does, because Google's OAuth review
 * compares the two. The Google section mirrors accounts/google_calendar.py
 * (scopes, what is stored, how it is removed) and must change with it.
 */
import { Link } from "react-router-dom";

import LegalPage from "../components/Legal/LegalPage";
import type { LegalSection } from "../components/Legal/LegalPage";
import { CONTACT_EMAIL, GOOGLE_SCOPES } from "../console/legal";

const mail = <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;

const SECTIONS: LegalSection[] = [
  {
    id: "who-we-are",
    title: "Who we are",
    body: (
      <>
        <p>
          AUCTONIQ is a virtual cricket auction simulator. You can research players in the Data Interface, run
          or join a live auction room, build a playing XI in AUCTEAM and ask the SCOUT assistant about players.
          It is for entertainment, strategy and learning: there is no real money, betting or gambling.
        </p>
        <p>
          AUCTONIQ is an independent project and is not affiliated with the BCCI or the Indian Premier League.
          You can reach us at {mail}.
        </p>
      </>
    ),
  },
  {
    id: "what-we-collect",
    title: "What we collect",
    body: (
      <>
        <h3>When you create an account</h3>
        <ul>
          <li>Your <strong>name</strong> and <strong>email address</strong>.</li>
          <li>Your <strong>password</strong>, stored only as a salted hash. We never see or keep the password itself.</li>
          <li>The <strong>account type</strong> you choose (Auctioneer, Delegate or Free).</li>
        </ul>
        <h3>When you use AUCTONIQ</h3>
        <ul>
          <li>
            <strong>Auction passes</strong>: the passes you hold, send, receive, claim and use, kept as a ledger
            so every balance can be explained.
          </li>
          <li><strong>Connections</strong> you make with other accounts, and the notifications we send you.</li>
          <li>
            <strong>Auction activity</strong>: when a room you run is opened, started and finished, and the bids
            and results inside it while it runs.
          </li>
          <li><strong>Scheduled auctions</strong> you add: name, date and time, length, room type and notes.</li>
          <li>Questions you ask SCOUT, so it can answer them and keep within usage limits.</li>
        </ul>
        <h3>Automatically</h3>
        <ul>
          <li>
            A <strong>session cookie</strong> that keeps you signed in. It is httpOnly (pages cannot read it),
            and we store only a hash of it. We do not use advertising or tracking cookies.
          </li>
          <li>Basic server logs (such as request times and errors) to keep the service running and secure.</li>
        </ul>
      </>
    ),
  },
  {
    id: "google",
    title: "Google Calendar and your Google data",
    body: (
      <>
        <p>
          Connecting Google Calendar is <strong>optional</strong> and available to Auctioneer accounts. Your
          AUCTONIQ schedule works without it. If you choose <em>Connect Google Calendar</em>, Google asks you to
          grant the following access:
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Access requested</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {GOOGLE_SCOPES.map((row) => (
              <tr key={row.scope}>
                <td>
                  <code>{row.scope}</code>
                </td>
                <td>{row.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>What we do with it</h3>
        <ul>
          <li>
            We <strong>create</strong> one Google Calendar event for each auction you schedule in AUCTONIQ, and
            <strong> update</strong> or <strong>delete</strong> that same event when you change or remove the
            auction.
          </li>
          <li>
            We <strong>do not read</strong> your other calendar events, and we never read, change or delete events
            that AUCTONIQ did not create.
          </li>
          <li>We read your Google email address only to show you which Google account is connected.</li>
        </ul>
        <h3>What we store</h3>
        <ul>
          <li>
            A Google <strong>refresh token</strong> and a short-lived <strong>access token</strong>, so the sync
            keeps working, and the email address of the connected Google account.
          </li>
          <li>The ID of each calendar event we created, so we can update or remove it later.</li>
        </ul>
        <p>These are kept in our accounts database on our server and are never sent to your browser.</p>
        <h3>What we never do</h3>
        <ul>
          <li>We do not sell Google user data or share it with anyone.</li>
          <li>We do not use it for advertising, profiling or any purpose other than the calendar sync above.</li>
          <li>We do not use it to develop, improve or train AI or machine-learning models.</li>
          <li>No person reads it, except where you ask us to, for security, or where the law requires.</li>
        </ul>
        <p className="legal-callout">
          AUCTONIQ&apos;s use and transfer of information received from Google APIs to any other app will adhere to
          the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
        <h3>Disconnecting</h3>
        <p>
          You can disconnect at any time from <Link to="/account">your Account page</Link> (Schedule → Disconnect).
          We then delete the stored tokens and Google email address, and ask Google to revoke our access. Events
          already in your calendar stay there for you to keep or delete. You can also remove AUCTONIQ&apos;s access
          from your Google Account under <em>Security → Third-party apps with account access</em>.
        </p>
      </>
    ),
  },
  {
    id: "how-we-use",
    title: "How we use your information",
    body: (
      <ul>
        <li>To run your account, sign you in and keep it secure.</li>
        <li>To run auctions: seats, bids, purses, results and the reports at the end.</li>
        <li>To move auction passes between accounts and tell you when you receive one.</li>
        <li>To keep your schedule and, if you connect it, your Google Calendar in step.</li>
        <li>To answer SCOUT questions and apply fair-use limits.</li>
        <li>To fix problems and prevent abuse.</li>
      </ul>
    ),
  },
  {
    id: "sharing",
    title: "Who can see it",
    body: (
      <>
        <p>
          Inside AUCTONIQ, people in the same auction room see what any auction shows them: franchise names,
          bids, purses and results. Your connections see your name and account type. Administrators can see
          account and pass activity to run the service.
        </p>
        <p>
          We do not sell your information. We share it only with the services that host and run AUCTONIQ
          (our hosting provider and the AI providers that answer SCOUT questions, which receive the question
          text but not your Google data), or where the law requires it.
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "How long we keep it, and deleting it",
    body: (
      <>
        <p>
          We keep your account information while your account exists. Auction rooms are held in memory and close
          when they are no longer used; we keep a record of when they ran. Google tokens are kept only while
          Google Calendar is connected.
        </p>
        <p>
          To delete your account and the information linked to it, email {mail} from the address on your
          account. We will confirm and complete the deletion within 30 days.
        </p>
      </>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <p>
        AUCTONIQ is served only over HTTPS. Passwords are hashed with a per-password salt, session cookies are
        httpOnly, and Google tokens never leave our server. No system is perfectly secure, but we work to protect
        your information and will tell you if a breach affects it.
      </p>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <p>
        AUCTONIQ is not directed at children under 13, and we do not knowingly collect their information. If you
        believe a child has created an account, contact {mail} and we will remove it.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        If we change this policy we will update the date at the top of this page, and for significant changes we
        will tell you through your AUCTONIQ notifications.
      </p>
    ),
  },
];

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy Policy"
      documentTitle="Privacy Policy · AUCTONIQ"
      intro={
        <p>
          This policy explains what information AUCTONIQ collects, how we use it, what we do with Google data when
          you connect Google Calendar, and the choices you have.
        </p>
      }
      sections={SECTIONS}
    />
  );
}
