/**
 * About.tsx
 * The About page, built from the AUCTONIQ about prototype.
 *
 * The prototype's body is here as designed: the floodlit hero, the two
 * interfaces, how it works, what it fixes, and the disclaimer. Its standalone
 * header and footer are not -- inside the site they would sit under the site's
 * own fixed nav and above its footer, so AuctiqNav and AuctiqFooter take their
 * place.
 *
 * The copy for the steps, the problems and the disclaimer is imported from
 * AuctiqNav rather than retyped. Those are the same words the About dialog
 * carried, and two hand-copied versions of a legal notice drift.
 *
 * Inside `.auctiq` for the same reason as the landing: the shared nav and
 * footer are styled by tokens scoped to that class. `.about-page` scopes this
 * page's own rules; see about.css.
 */
import { useEffect } from "react";
import {
  Activity,
  BarChart3,
  Calculator,
  FileCheck2,
  Gavel,
  MessageSquareText,
  ShieldCheck,
  Timer,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import AuctiqFooter from "../components/Global/AuctiqFooter";
import AuctiqNav, {
  HOW_IT_WORKS,
  LEGAL_DISCLAIMER,
  PROBLEMS_SOLVED,
} from "../components/Global/AuctiqNav";
import "./about.css";

/** The prototype's icon for each step and each problem, in list order. */
const STEP_ICONS: LucideIcon[] = [Users, Timer, Wallet];
const PROBLEM_ICONS: LucideIcon[] = [FileCheck2, Calculator, Activity, MessageSquareText];

export default function About() {
  useEffect(() => {
    document.title = "About AUCTONIQ · Live Cricket Auction Simulator";
  }, []);

  return (
    <div className="auctiq about-page relative min-h-screen">
      <AuctiqNav />

      <main>
        <section className="about-hero" aria-labelledby="about-title">
          <img
            className="hero-image"
            src="/cricket-about-white.jpg"
            alt="A white cricket ball and bat on a floodlit cricket ground"
            width={1264}
            height={848}
          />
          <div className="hero-content page-width">
            <div className="eyebrow">The game behind the game</div>
            <h1 id="about-title">ABOUT AUCTONIQ</h1>
            <p className="hero-subtitle">A virtual cricket auction, run properly.</p>
            <p className="hero-description">
              AUCTONIQ is a Live Auction Simulator Platform, bringing player
              research and live bidding together in one place.
            </p>
            <p className="hero-description">
              AUCTONIQ runs a cricket player auction the way a real one works — a
              shared room, a live clock, and a purse that everyone can see.
            </p>
            <div className="hero-tags">
              <span><BarChart3 aria-hidden="true" />Player data</span>
              <span><Gavel aria-hidden="true" />Live bidding</span>
              <span><Users aria-hidden="true" />Shared rooms</span>
            </div>
          </div>
        </section>

        <div className="page-width">
          <section className="content-section" aria-labelledby="interfaces-title">
            <div className="section-heading">
              <h2 id="interfaces-title">Two interfaces. One platform.</h2>
              <span className="section-index">Explore &amp; compete</span>
            </div>
            <div className="interface-grid">
              <article className="interface-item">
                <div className="icon-box"><BarChart3 aria-hidden="true" /></div>
                <div>
                  <h3>Data interface</h3>
                  <p>
                    Explore comprehensive statistical data on IPL players. Study
                    their performances, plan effectively for your auction, or
                    simply deepen your knowledge of the game.
                  </p>
                  <span className="interface-label">Research. Understand. Plan.</span>
                </div>
              </article>
              <article className="interface-item">
                <div className="icon-box"><Gavel aria-hidden="true" /></div>
                <div>
                  <h3>Live bidding interface</h3>
                  <p>
                    Take part in a live auction simulation. Participants join as
                    franchises, while one participant takes the role of auctioneer
                    to conduct the auction.
                  </p>
                  <span className="interface-label">Join. Bid. Build your squad.</span>
                </div>
              </article>
            </div>
          </section>

          <section className="content-section" aria-labelledby="how-title">
            <div className="section-heading">
              <h2 id="how-title">How it works</h2>
              <span className="section-index">From pool to playing XI</span>
            </div>
            <ol className="steps-grid">
              {HOW_IT_WORKS.map((item, i) => {
                const Icon = STEP_ICONS[i] ?? Users;
                return (
                  <li className="step-card" key={item.step}>
                    <div className="step-top">
                      <span>{item.step}</span>
                      <Icon aria-hidden="true" />
                    </div>
                    <h3>{item.title}</h3>
                    <p>{item.body}</p>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="content-section" aria-labelledby="fixes-title">
            <div className="section-heading">
              <h2 id="fixes-title">What it fixes</h2>
              <span className="section-index">Less admin. More auction.</span>
            </div>
            <ul className="fixes-grid">
              {PROBLEMS_SOLVED.map((item, i) => {
                const Icon = PROBLEM_ICONS[i] ?? Activity;
                return (
                  <li className="fix-item" key={item.title}>
                    <Icon className="fix-icon" aria-hidden="true" />
                    <div>
                      <h3>{item.title}</h3>
                      <p>{item.body}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <aside className="disclaimer" aria-labelledby="disclaimer-title">
            <ShieldCheck className="disclaimer-icon" aria-hidden="true" />
            <div>
              <h2 id="disclaimer-title">For the love of the game. Not for gambling.</h2>
              <p data-testid="about-disclaimer">{LEGAL_DISCLAIMER}</p>
            </div>
          </aside>
        </div>
      </main>

      <AuctiqFooter />
    </div>
  );
}
