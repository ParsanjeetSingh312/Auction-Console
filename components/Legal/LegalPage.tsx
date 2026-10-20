/**
 * LegalPage.tsx
 * The shared frame for the Privacy Policy and the Terms of Service: the site
 * menu, a title block with the last-updated date, a short table of contents,
 * one readable column of sections, and the footer.
 *
 * Both pages must be reachable without logging in (Google's OAuth review
 * opens them as a stranger would), so nothing here depends on an account.
 */
import { useEffect } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

import AuctiqFooter from "../Global/AuctiqFooter";
import AuctiqNav from "../Global/AuctiqNav";
import { CONTACT_EMAIL, LAST_UPDATED } from "../../console/legal";
import "./legal.css";

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

interface Props {
  title: string;
  /** The browser tab's title. */
  documentTitle: string;
  intro: ReactNode;
  sections: LegalSection[];
}

export default function LegalPage({ title, documentTitle, intro, sections }: Props) {
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  // `/privacy#google` (linked from the Account page): the page arrives as a
  // lazy chunk, after the browser has already tried to jump to the anchor.
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const target = document.getElementById(hash.slice(1));
    target?.scrollIntoView({ block: "start" });
  }, [hash]);

  return (
    <div className="auctiq legal-page relative min-h-screen">
      {/* In flow, not floating: a long page of text should not scroll under the menu. */}
      <AuctiqNav placement="static" />
      <main className="legal-main">
        <header className="legal-head">
          <p className="legal-eyebrow">AUCTONIQ</p>
          <h1>{title}</h1>
          <p className="legal-updated">Last updated {LAST_UPDATED}</p>
          <div className="legal-intro">{intro}</div>
        </header>

        <nav aria-label="On this page" className="legal-toc">
          <p>On this page</p>
          <ol>
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        {sections.map((section) => (
          <section key={section.id} id={section.id} className="legal-section" aria-labelledby={`${section.id}-title`}>
            <h2 id={`${section.id}-title`}>{section.title}</h2>
            {section.body}
          </section>
        ))}

        <p className="legal-contact">
          Questions about this page: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. See also our{" "}
          <Link to="/privacy">Privacy Policy</Link>, <Link to="/terms">Terms of Service</Link> and{" "}
          <Link to="/about">About AUCTONIQ</Link>.
        </p>
      </main>
      <AuctiqFooter />
    </div>
  );
}
