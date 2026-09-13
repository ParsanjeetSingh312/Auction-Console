/**
 * Auctiq.tsx
 * The landing page: a list of sections, and the atmosphere they sit in.
 *
 * Deliberately thin. Every section owns its own markup and motion, so changing
 * the order of the page is moving one line here rather than surgery on a
 * thousand-line file.
 *
 * The `.auctiq` wrapper is what keeps two themes in one application honest.
 * Every dark token and glass utility is scoped to that class in styles.css, and
 * `body` is never touched — so nothing on this page can reach the console, the
 * Data Interface or the war room, which keep the white enterprise theme from
 * Phase 3b. The alternative, a `dark` class on <html> with `dark:` variants
 * everywhere, would mean editing thirty-odd existing components to describe a
 * theme none of them will ever be shown in.
 */
import { useEffect } from "react";
import { Link } from "react-router-dom";

import AuctiqLogo from "../components/Global/AuctiqLogo";
import HeroSection from "../components/Sections/HeroSection";
import PlayerShowcase from "../components/Sections/PlayerShowcase";

export default function Auctiq() {
  useEffect(() => {
    document.title = "AUCTIQ · IPL 2026 Mega Auction";
  }, []);

  /*
    `overflow-x-clip` below, NOT `overflow-x-hidden`.

    Both stop the scattered showcase cards causing a horizontal scrollbar, but
    `hidden` makes this element a scroll container — and `position: sticky`
    anchors to its nearest scroll container, not the viewport. With `hidden`
    here the showcase's sticky stage scrolled away with its section and the
    cards rendered 600px above the fold, which looked like an empty page.
    `clip` clips without establishing a scroll container, so sticky keeps
    working.
  */
  return (
    <div className="auctiq relative min-h-screen overflow-x-clip">
      {/*
        Fixed atmospheric layers, behind everything and ignoring the pointer.
        Fixed rather than scrolled so they read as the room the content is in,
        not as a texture printed on it.
      */}
      <div className="auctiq-stadium" aria-hidden />
      <div className="auctiq-grid" aria-hidden />

      <AuctiqLogo to="/" />

      <HeroSection />
      <PlayerShowcase />

      <footer className="relative z-10 border-t border-white/[0.07] px-5 py-8 sm:px-8">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4">
          <span className="font-tech text-[10px] uppercase tracking-[0.2em] text-auctiq-dim">
            AUCTIQ · IPL 2026
          </span>
          <nav className="flex flex-wrap items-center gap-5">
            <FooterLink to="/data">Data Interface</FooterLink>
            <FooterLink to="/auction">Live Bidding</FooterLink>
            <FooterLink to="/console">Console</FooterLink>
            <FooterLink to="/classic">Classic</FooterLink>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function FooterLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="font-tech text-[11px] text-auctiq-dim underline-offset-4 transition-colors duration-200 hover:text-auctiq-gold hover:underline"
    >
      {children}
    </Link>
  );
}
