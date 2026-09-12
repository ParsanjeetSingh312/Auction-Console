/**
 * WelcomeHero.tsx
 * The AUCTIQ landing page.
 *
 * One job: make the choice between the two interfaces obvious, and say enough
 * about each that nobody has to click to find out what it is. Everything else
 * on this page is atmosphere.
 *
 * On the theme. The console is a white enterprise instrument and this page does
 * not break from it — a landing that looks like a different product is a
 * landing that makes the product feel unfinished the moment you enter it. So
 * the drama comes from scale and from a single warm accent, not from a dark
 * mode: a large trophy, a large wordmark, two large targets, and franchise
 * colour used exactly as the budget grid uses it — a rail and a dot, never a
 * fill.
 *
 * On the artwork. The trophy, the wordmark and the two figures are drawn here
 * as original SVG rather than fetched. That is partly practical — inline vector
 * is crisp at any size, costs no request, and cannot 404 — and partly a
 * licensing matter: the IPL's own logo, trophy photography and player imagery
 * are protected marks, and this file will not ship them. `BRAND_SLOT` below
 * marks the one place to drop in licensed artwork if you have the rights to it.
 *
 * Props are a finished answer, not a promise: this component never fetches.
 * See Home.tsx, which does.
 */
import { Link } from "react-router-dom";
import { motion, useReducedMotion, type Variants } from "framer-motion";

import { money } from "../console/format";
import { EASE } from "../console/motion";
import { DEFAULT_RULES } from "../console/useAuctionEngine";

/**
 * What Home learned from `GET /api/v1/health`.
 *
 * `down` carries the message rather than a boolean because "cannot reach the
 * backend" and "the backend is up but the pool is empty" need different
 * remedies, and the user is better served by the actual sentence.
 */
export type BackendStatus =
  | { state: "checking" }
  | { state: "up"; players: number | null; vectors: number | null; llmReady: boolean }
  | { state: "down"; message: string };

export interface WelcomeHeroProps {
  status: BackendStatus;
}

/**
 * Licensed-artwork slot.
 *
 * Set this to the public path of your own IPL logo (e.g. "/brand/ipl.svg",
 * served from Vite's `public/` directory) and it replaces the AUCTIQ mark in
 * the masthead. Left null, the page uses its own mark and ships clean.
 */
const BRAND_SLOT: string | null = null;

/** Parent of the staggered entrance. Children inherit the timing. */
const stage: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
};

const rise: Variants = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
};

export default function WelcomeHero({ status }: WelcomeHeroProps) {
  const reduced = useReducedMotion();

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-surface bg-dots">
      {/*
        The two figures, standing at the foot of the stage.

        Two things about how they are dimmed. The opacity is on the <svg>, not
        on the colour — a figure is a dozen overlapping strokes and fills, and a
        semi-transparent `currentColor` composites each of them separately, so
        every elbow and shoulder joint comes out darker than the limb it belongs
        to. Setting opacity on the element flattens the figure first and fades
        it once, which is the difference between a silhouette and a smudge.

        And they are anchored to the bottom rather than centred, because a
        full-height figure is wider than the margin beside a 1024px column at
        any realistic window size and would end up behind the headline. Down
        here they frame the footer instead. Below `xl` there is no margin at
        all, so they are not drawn.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-[46vh] max-h-[430px] xl:block"
      >
        <BatterFigure className="absolute bottom-0 left-3 h-full w-auto text-ipl-mum opacity-[0.045]" />
        <BowlerFigure className="absolute bottom-0 right-3 h-full w-auto text-ipl-rcb opacity-[0.04]" />
      </div>

      {/* ---------------------------------------------------------------- *
        Masthead
       * ---------------------------------------------------------------- */}
      <header className="relative z-10 flex items-center justify-between border-b border-line/70 px-5 py-3 sm:px-8">
        <div className="flex items-center gap-2.5">
          {BRAND_SLOT ? (
            <img src={BRAND_SLOT} alt="" className="h-7 w-7" />
          ) : (
            <AuctiqMark className="h-7 w-7" />
          )}
          <span className="font-head text-[15px] font-extrabold tracking-[0.16em] text-slate-ink">
            AUCTIQ
          </span>
        </div>

        <StatusPill status={status} />
      </header>

      {/* ---------------------------------------------------------------- *
        Stage
       * ---------------------------------------------------------------- */}
      <motion.main
        variants={stage}
        initial={reduced ? false : "initial"}
        animate="animate"
        className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-5 py-10 sm:px-8"
      >
        <motion.div variants={rise}>
          <Trophy className="h-[104px] w-auto sm:h-[124px]" animated={!reduced} />
        </motion.div>

        <motion.h1
          variants={rise}
          className="mt-5 text-center font-head text-[40px] font-extrabold leading-none tracking-[0.14em] text-slate-ink sm:text-[56px]"
        >
          AUCTIQ
        </motion.h1>

        <motion.p
          variants={rise}
          className="mt-3 max-w-md text-center font-ui text-[13px] leading-relaxed text-slate-muted"
        >
          The IPL 2026 mega auction, run live — scouted on real numbers, bid in
          real time, settled with a report before anyone leaves the room.
        </motion.p>

        {/* The choice. */}
        <motion.div
          variants={rise}
          className="mt-9 grid w-full gap-4 sm:grid-cols-2"
        >
          <OptionCard
            to="/data"
            option="Option A"
            title="Data Interface"
            accent="#0B6E5B"
            reduced={!!reduced}
            blurb="Pre-auction analysis. The complete player pool, franchise records and the SCOUT retrieval engine — read-only, with no bidding attached."
            points={[
              "Player pool · 17 scouting metrics a head",
              "Franchise budgets and squad composition",
              "SCOUT — hybrid SQL + vector search",
            ]}
            cta="Open analytics"
            icon={<DataIcon />}
          />

          <OptionCard
            to="/auction"
            option="Option B"
            title="Live Bidding Interface"
            accent="#D5152D"
            reduced={!!reduced}
            blurb="The auction room. Take the chair as auctioneer and run the event, or join as a franchise and bid against the other nine."
            points={[
              "Auctioneer split-screen control",
              "Franchise console with jumpbid",
              "Live sync · auto Playing XI report",
            ]}
            cta="Enter the room"
            icon={<GavelIcon />}
            emphasis
          />
        </motion.div>

        {/* The three facts worth knowing before choosing. */}
        <motion.div
          variants={rise}
          className="mt-8 flex flex-wrap items-center justify-center gap-x-7 gap-y-2 font-ui text-[11px] text-slate-faint"
        >
          <Fact
            value={
              status.state === "up" && status.players != null
                ? String(status.players)
                : "—"
            }
            label="players registered"
          />
          <Fact value="10" label="franchises" />
          <Fact value={money(DEFAULT_RULES.purse)} label="purse a team" />
          <Fact value={String(DEFAULT_RULES.maxSquad)} label="squad cap" />
        </motion.div>
      </motion.main>

      {/* ---------------------------------------------------------------- *
        Footer

        The earlier deliverables stay reachable. Phase 2's unified console and
        Phase 3's war-room demo both still work, and burying them behind a URL
        nobody remembers is the same as deleting them.
       * ---------------------------------------------------------------- */}
      <footer className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-t border-line/70 px-5 py-3 sm:px-8">
        <span className="font-ui text-[10px] uppercase tracking-[0.14em] text-slate-faint">
          IPL 2026 · Mega Auction
        </span>
        <nav className="flex items-center gap-4">
          <FooterLink to="/console">Phase 2 console</FooterLink>
          <FooterLink to="/auction/demo">War-room demo</FooterLink>
          <a
            href="/docs"
            className="font-ui text-[11px] text-slate-muted underline-offset-2 transition-colors hover:text-slate-ink hover:underline"
          >
            API docs
          </a>
        </nav>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

function Fact({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <b className="font-num text-[16px] font-bold tabular-nums text-slate-body">{value}</b>
      <span className="uppercase tracking-[0.1em]">{label}</span>
    </span>
  );
}

function FooterLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="font-ui text-[11px] text-slate-muted underline-offset-2 transition-colors hover:text-slate-ink hover:underline"
    >
      {children}
    </Link>
  );
}

/**
 * A destination.
 *
 * The whole card is the target, not a button inside it — a 300px card with a
 * 90px button in the corner asks the user to aim at the small thing, and there
 * is no reason for anything else on the card to be clickable.
 *
 * `motion.create(Link)` rather than a button with `useNavigate`, so the card
 * keeps everything a link is: middle-click, ⌘-click, a real href in the status
 * bar, and keyboard focus without extra work.
 *
 * `emphasis` is the only asymmetry between the two: Option B is where the
 * product actually happens, so it carries a faint ring that makes it the
 * default read without resorting to a coloured fill.
 */
const MotionLink = motion.create(Link);

function OptionCard({
  to,
  option,
  title,
  blurb,
  points,
  cta,
  icon,
  accent,
  reduced,
  emphasis = false,
}: {
  to: string;
  option: string;
  title: string;
  blurb: string;
  points: string[];
  cta: string;
  icon: React.ReactNode;
  accent: string;
  reduced: boolean;
  emphasis?: boolean;
}) {
  return (
    <MotionLink
      to={to}
      whileHover={reduced ? undefined : { y: -4, scale: 1.012 }}
      whileTap={reduced ? undefined : { scale: 0.995 }}
      transition={{ type: "spring", stiffness: 340, damping: 26, mass: 0.7 }}
      className={`group relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface-card p-5 text-left shadow-soft transition-shadow hover:shadow-soft-lg ${
        emphasis ? "ring-1 ring-slate-ink/[0.07]" : ""
      }`}
    >
      {/* Franchise-register accent: a rail across the top edge, nothing more. */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ backgroundColor: accent }}
      />

      <div className="flex items-start justify-between gap-3">
        <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
          {option}
        </span>
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
          style={{ backgroundColor: `${accent}12`, color: accent }}
        >
          {icon}
        </span>
      </div>

      <h2 className="mt-2.5 font-head text-[21px] font-bold leading-tight text-slate-ink">
        {title}
      </h2>

      <p className="mt-2 font-ui text-[12.5px] leading-relaxed text-slate-muted">{blurb}</p>

      <ul className="mt-3.5 space-y-1.5">
        {points.map((point) => (
          <li key={point} className="flex items-start gap-2 font-ui text-[11.5px] text-slate-body">
            <span
              aria-hidden
              className="mt-[6px] h-1 w-1 shrink-0 rounded-full"
              style={{ backgroundColor: accent }}
            />
            {point}
          </li>
        ))}
      </ul>

      <span className="mt-5 flex items-center gap-1.5 font-ui text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-ink">
        {cta}
        {/* Travels on hover — the one piece of motion that says "this goes somewhere". */}
        <span className="transition-transform duration-200 group-hover:translate-x-1">→</span>
      </span>
    </MotionLink>
  );
}

/**
 * Backend reachability, stated in one line.
 *
 * A missing LLM key is shown as a mode, not a fault: the Scout falls back to
 * the deterministic local analyst and still answers, so calling it an error
 * would be a lie that sends someone hunting for a problem they do not have.
 */
function StatusPill({ status }: { status: BackendStatus }) {
  const tone =
    status.state === "up" ? "#1E6B47" : status.state === "down" ? "#A2382C" : "#94A3B8";

  const label =
    status.state === "checking"
      ? "checking backend"
      : status.state === "down"
        ? "backend offline"
        : status.llmReady
          ? "pool ready · Scout live"
          : "pool ready · local analyst";

  return (
    <span
      className="flex items-center gap-2 rounded-full border border-line bg-surface-card px-3 py-1.5 shadow-chip"
      title={status.state === "down" ? status.message : undefined}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${status.state === "checking" ? "animate-pulse" : ""}`}
        style={{ backgroundColor: tone }}
      />
      <span className="font-ui text-[10px] uppercase tracking-[0.12em] text-slate-muted">
        {label}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Artwork
 *
 * All original, all `currentColor` where it can be, so a figure is tinted by
 * its Tailwind text class rather than by a prop.
 * ------------------------------------------------------------------ */

function AuctiqMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id="auctiq-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1B4FA8" />
          <stop offset="100%" stopColor="#0F172A" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#auctiq-mark)" />
      {/* A cricket ball: the circle plus two seams. */}
      <circle cx="16" cy="16" r="8" fill="none" stroke="#FFFFFF" strokeOpacity="0.9" strokeWidth="1.8" />
      <path
        d="M16 8.2 C11.6 10.8 11.6 21.2 16 23.8"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.55"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M16 8.2 C20.4 10.8 20.4 21.2 16 23.8"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.55"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {/* The gold spark: the "IQ" half of the name. */}
      <circle cx="24.5" cy="7.5" r="3" fill="#F6C45A" />
    </svg>
  );
}

/**
 * The trophy.
 *
 * Floats when motion is allowed — four pixels over three seconds, which is slow
 * enough to read as weight rather than as an animation asking to be watched.
 */
function Trophy({ className = "", animated }: { className?: string; animated: boolean }) {
  return (
    <motion.svg
      viewBox="0 0 120 140"
      className={className}
      aria-hidden
      focusable="false"
      animate={animated ? { y: [0, -5, 0] } : undefined}
      transition={
        animated
          ? { duration: 3.6, repeat: Infinity, ease: "easeInOut" }
          : undefined
      }
    >
      <defs>
        <linearGradient id="auctiq-gold" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor="#F8D07A" />
          <stop offset="45%" stopColor="#E0A72F" />
          <stop offset="100%" stopColor="#B77C12" />
        </linearGradient>
        <linearGradient id="auctiq-plinth" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#334155" />
          <stop offset="100%" stopColor="#0F172A" />
        </linearGradient>
      </defs>

      {/* Handles, drawn first so the cup overlaps them. */}
      <path
        d="M31 32 C11 32 4 54 18 66 C25 72 32 75 40 76"
        fill="none"
        stroke="url(#auctiq-gold)"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <path
        d="M89 32 C109 32 116 54 102 66 C95 72 88 75 80 76"
        fill="none"
        stroke="url(#auctiq-gold)"
        strokeWidth="7"
        strokeLinecap="round"
      />

      {/* Rim and cup. */}
      <rect x="26" y="18" width="68" height="11" rx="3.5" fill="url(#auctiq-gold)" />
      <path
        d="M31 30 H89 L81 70 Q76 86 60 86 Q44 86 39 70 Z"
        fill="url(#auctiq-gold)"
      />
      {/* A single highlight, which is what makes flat gold read as metal. */}
      <path
        d="M39 32 H49 L45 68 Q44 76 40 79 Q36 74 36 66 Z"
        fill="#FFFFFF"
        fillOpacity="0.28"
      />

      {/* Stem and plinth. */}
      <path d="M53 86 H67 V100 H53 Z" fill="url(#auctiq-gold)" />
      <path d="M41 100 H79 L84 111 H36 Z" fill="url(#auctiq-plinth)" />
      <rect x="31" y="111" width="58" height="14" rx="3" fill="url(#auctiq-plinth)" />
      <rect x="42" y="116" width="36" height="4" rx="2" fill="#FFFFFF" fillOpacity="0.16" />
    </motion.svg>
  );
}

/**
 * A batter raising the bat.
 *
 * The first version of this was a cover drive, and it failed for a reason worth
 * recording: a drive is read from the *angles between* the limbs, and at four
 * per cent opacity there are no edges left to read those angles from — two arms
 * sixteen degrees apart merge into one thick band and the bat becomes a stick
 * being waved. The salute survives the contrast because it is read from
 * silhouette alone: arms up, bat vertical, and the outline is unmistakable even
 * when it is barely darker than the page.
 *
 * The bat is drawn as two strokes rather than one. A cricket bat is a thin
 * handle and a wide blade, and a single stroke of either width reads as a club.
 */
function BatterFigure({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 256" className={className} aria-hidden focusable="false">
      <g
        fill="currentColor"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Legs, planted. */}
        <path d="M104 148 L95 202 L90 242" strokeWidth="20" fill="none" />
        <path d="M118 148 L130 202 L137 242" strokeWidth="20" fill="none" />

        {/* Torso. */}
        <path d="M87 70 L125 68 L130 148 L92 152 Z" stroke="none" />

        {/* Bat arm, up and out to the right. */}
        <path d="M122 82 L159 50" strokeWidth="14" fill="none" />
        {/* Handle, then blade. */}
        <path d="M159 50 L170 33" strokeWidth="6" fill="none" />
        <path d="M171 31 L185 8" strokeWidth="16" fill="none" />

        {/* Helmet arm, up and out to the left. */}
        <path d="M92 84 L55 52" strokeWidth="14" fill="none" />
        <circle cx="48" cy="45" r="11" stroke="none" />

        {/* Head. */}
        <circle cx="106" cy="46" r="20" stroke="none" />
      </g>
    </svg>
  );
}

/** A bowler in the delivery stride, arm vertical. */
function BowlerFigure({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 256" className={className} aria-hidden focusable="false">
      <g
        fill="currentColor"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Legs: braced front, trailing back. */}
        <path d="M126 158 L100 216 L73 244" strokeWidth="21" fill="none" />
        <path d="M149 156 L179 206 L207 229" strokeWidth="21" fill="none" />

        {/* Torso. */}
        <path d="M117 84 L151 81 L157 156 L120 162 Z" stroke="none" />

        {/* Bowling arm, high. */}
        <path d="M147 90 L159 30" strokeWidth="15" fill="none" />
        <circle cx="161" cy="22" r="9" stroke="none" />

        {/* Leading arm, across the body. */}
        <path d="M121 98 L77 74" strokeWidth="14" fill="none" />

        {/* Head. */}
        <circle cx="133" cy="60" r="20" stroke="none" />
      </g>
    </svg>
  );
}

/* Card glyphs — 18px, single stroke, no fill. */

function DataIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </svg>
  );
}

function GavelIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 3.5 20.5 10" />
      <path d="M11.5 6 17 11.5" />
      <path d="m16 8-8.5 8.5" />
      <path d="M3 21h10" />
      <path d="m5.5 18.5 3-3" />
    </svg>
  );
}
