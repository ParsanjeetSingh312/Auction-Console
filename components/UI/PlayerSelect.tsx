/**
 * PlayerSelect.tsx
 * The landing's showcase, as a console game-select screen. It replaced the
 * scattered deck of `PlayerShowcase`; /lab/players still mounts it on its own.
 *
 * Three moments.
 *
 * **The deck.** Scrolling into the section, the cards arrive gathered into one
 * tilted deck in the middle of the stage -- the landing's current stacked
 * opening -- and the scroll deals them out into a row. Once dealt, the
 * neighbours of the focused card fold to half height. The section is tall and
 * the stage sticky, so this is scrubbed: scrolling back up gathers them again.
 *
 * **Browse.** A filmstrip of player cards that share one top edge; the focused
 * card stands at full height. Focus is chosen by hand -- click a card, the
 * arrow buttons, or the keyboard -- never by scroll. The name wipes up line by
 * line on every change and the backdrop re-grades to the franchise colour.
 *
 * **Selected.** Clicking the focused card (or Enter) sends its jersey number
 * out of the card to the middle of the screen, large and lit, while the six
 * career figures arrive one at a time in alternating left and right corners,
 * each drawing a neon line toward the number before it counts up. Esc or Back
 * returns the number to its card.
 *
 * Framer drives what is layout (the strip, the shared number); GSAP drives what
 * is choreography (the scrubbed deal, the select timeline). Geometry is
 * measured: one ResizeObserver reads the stage and every size is a ratio of it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { ArrowLeft, ChevronLeft, ChevronRight, CornerDownLeft } from "lucide-react";

import { getLenis } from "../../hooks/useJourney";
import { ROLE_TINT, type ShowcasePlayer } from "../../utils/players";
import { formatStat, type PlayerStatSheet, type SelectStat } from "../../utils/playerStats";

gsap.registerPlugin(ScrollTrigger, useGSAP);

const NEON = "#22D3EE";
const EASE_OUT = [0.22, 1, 0.36, 1] as const;
const SPRING = { type: "spring" as const, stiffness: 260, damping: 34, mass: 0.9 };
const NUMBER_SPRING = { type: "spring" as const, stiffness: 190, damping: 26, mass: 0.9 };
const INSTANT = { duration: 0 };

/* Ratios, all relative to the stage box. */
const CARD_H = 0.3; // strip card height / stage height
const CARD_AR = 0.75; // cards are 3:4
const STRIP_TOP = 0.52; // the strip's shared top edge, down the stage

/**
 * Extra page scroll the section spans, in vh: 300vh in all, the same height as
 * the `PlayerShowcase` it replaces, because the landing's 3D journey is timed
 * against the page's total height and a shorter section would shift its beats.
 */
const DECK_SCROLL = 200;
/**
 * Scroll progress at which the deal starts and lands: a hold either side. The
 * same window the old scatter used, so the cards still break apart as the
 * cricket ball comes in behind them.
 */
const DEAL_START = 0.2;
const DEAL_END = 0.44;

/**
 * How each card sits in the gathered deck: an offset from the deck's centre,
 * in fractions of a card, and an angle. Uneven on purpose -- a regular fan
 * reads as a diagram, a loose stack reads as a hand of cards.
 */
const DECK = [
  { x: -0.16, y: -0.1, r: -14 },
  { x: 0.18, y: -0.12, r: 15 },
  { x: -0.26, y: 0.02, r: -6 },
  { x: 0.24, y: 0.04, r: 7 },
  { x: -0.06, y: 0.1, r: -3 },
  { x: 0.1, y: 0.12, r: 4 },
];

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const easeInOut = gsap.parseEase("power2.inOut");

export interface PlayerSelectProps {
  players: ShowcasePlayer[];
  stats: Record<number, PlayerStatSheet>;
}

export default function PlayerSelect({ players, stats }: PlayerSelectProps) {
  const reduced = useReducedMotion() ?? false;
  const wrapRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  // True once the deck has been dealt: only then do the neighbours fold.
  const [dealt, setDealt] = useState(reduced);
  const last = Math.max(0, players.length - 1);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const read = () => setBox({ w: stage.clientWidth, h: stage.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  // Geometry.
  const fullH = clamp(box.h * CARD_H, 120, 340);
  const cardW = fullH * CARD_AR;
  const gap = Math.max(6, Math.round(cardW * 0.06));
  const step = cardW + gap;
  const pad = Math.max(18, Math.round(box.w * 0.03));
  // When the whole row fits, it stays centred as a row and focus moves along
  // it; only when it is wider than the stage does the track follow focus.
  const rowW = players.length * cardW + last * gap;
  const rowFits = rowW <= box.w - 2 * pad;
  const trackX = rowFits ? (box.w - rowW) / 2 : box.w / 2 - (index * step + cardW / 2);

  // A row that does not fit starts on a middle card, so the deck still deals
  // out to both sides rather than all one way.
  const startedMiddle = useRef(false);
  useLayoutEffect(() => {
    if (!box.w || startedMiddle.current) return;
    startedMiddle.current = true;
    if (!rowFits) setIndex(Math.floor(last / 2));
  }, [box.w, rowFits, last]);

  /**
   * Place every card for a given deal progress. Each card's resting place is
   * its slot in the strip; gathered, it is pulled back to the middle of the
   * stage plus its loose deck offset. Dealing therefore splits the deck from
   * the middle: the cards left of centre go left, the rest go right.
   */
  const deal = useRef(reduced ? 1 : 0);
  const geometry = useRef({ step, cardW, fullH, middle: 0 });
  // The point of the track that sits under the stage's centre.
  geometry.current = { step, cardW, fullH, middle: box.w / 2 - trackX };
  const place = useCallback(() => {
    const e = easeInOut(deal.current);
    const { step: s, cardW: w, fullH: h, middle } = geometry.current;
    cardRefs.current.forEach((el, i) => {
      if (!el) return;
      const slot = DECK[i % DECK.length];
      const gather = 1 - e;
      const fromMiddle = middle - (i * s + w / 2);
      gsap.set(el, {
        x: (fromMiddle + slot.x * w) * gather,
        y: slot.y * h * gather,
        rotation: slot.r * gather,
        scale: 0.86 + 0.14 * e,
        // Gathered, the cards nearest the middle sit on top of the deck.
        zIndex: gather > 0.01 ? Math.round(20 - Math.abs(fromMiddle) / s) : 1,
      });
    });
    const after = stageRef.current?.querySelectorAll(".ps-after");
    if (after?.length) gsap.set(after, { opacity: clamp((deal.current - 0.55) / 0.45, 0, 1) });
    // The section's headline leads while the deck is gathered and dims as the
    // cards split, settling as a faint watermark behind the dealt row.
    const headline = stageRef.current?.querySelector(".ps-headline");
    if (headline) gsap.set(headline, { opacity: 1 - 0.82 * e, scale: 1 - 0.06 * e });
  }, []);

  useGSAP(
    () => {
      if (reduced) {
        deal.current = 1;
        place();
        setDealt(true);
        return;
      }
      ScrollTrigger.create({
        trigger: wrapRef.current,
        start: "top top",
        end: "bottom bottom",
        onUpdate: (self) => {
          deal.current = clamp((self.progress - DEAL_START) / (DEAL_END - DEAL_START), 0, 1);
          place();
          setDealt(deal.current > 0.96);
        },
        onRefresh: (self) => {
          deal.current = clamp((self.progress - DEAL_START) / (DEAL_END - DEAL_START), 0, 1);
          place();
        },
      });
      place();
    },
    { scope: wrapRef, dependencies: [reduced, place] },
  );

  // Re-place after a focus change or a resize, so a half-dealt deck stays
  // gathered on the card that is now in the middle.
  useLayoutEffect(() => place(), [trackX, step, place]);

  const focus = useCallback((i: number) => setIndex(clamp(i, 0, last)), [last]);

  // While a player is selected the page holds still and Esc backs out.
  useEffect(() => {
    if (selected === null) return;
    const lenis = getLenis();
    lenis?.stop();
    const block = (e: Event) => e.preventDefault();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
      if ([" ", "PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) e.preventDefault();
    };
    window.addEventListener("wheel", block, { passive: false });
    window.addEventListener("touchmove", block, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      lenis?.start();
      window.removeEventListener("wheel", block);
      window.removeEventListener("touchmove", block);
      window.removeEventListener("keydown", onKey);
    };
  }, [selected]);

  const active = players[clamp(index, 0, last)];
  if (!active) return null;
  const chosen = selected === null ? null : players[selected];

  const titleSize = clamp(box.h * 0.085, 34, 104);
  // On a phone the nav wraps to a second row, so the chrome starts lower.
  const chromeTop = box.w < 640 ? 132 : Math.max(88, box.h * 0.11);

  return (
    <section
      ref={wrapRef}
      aria-label="Star players"
      className="relative w-full"
      style={{ height: reduced ? "100svh" : `calc(100vh + ${DECK_SCROLL}vh)` }}
    >
      <div
        ref={stageRef}
        tabIndex={0}
        role="group"
        aria-roledescription="carousel"
        aria-label="Player select"
        onKeyDown={(e) => {
          if (selected !== null) return;
          if (e.key === "ArrowLeft") { e.preventDefault(); focus(index - 1); }
          if (e.key === "ArrowRight") { e.preventDefault(); focus(index + 1); }
          // Only when the stage itself has focus: on a card, Enter is that card's click.
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); setSelected(index); }
        }}
        // No background of its own: on the landing the stadium and the ball's
        // delivery play out behind this stage, as they did behind the old deck.
        // A soft dark halo under every line of type in the section (text-shadow
        // inherits), so labels stay legible over the stadium whatever is
        // behind them. Elements with a glow of their own override it.
        style={{ textShadow: "0 1px 10px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.6)" }}
        className="sticky top-0 h-[100svh] w-full select-none overflow-hidden text-auctiq-text outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neon-cyan/50"
      >
        <Backdrop player={active} keyId={index} reduced={reduced} />

        {/* The section's headline, carried over from the scattered deck. */}
        <div
          className="ps-headline pointer-events-none absolute inset-x-0 z-[5] flex flex-col items-center px-6 text-center"
          style={{ top: chromeTop + (box.w < 640 ? 16 : 24) }}
        >
          <span className="font-tech text-[10px] uppercase tracking-[0.32em] text-auctiq-gold/80">On the block</span>
          <h2 className="mt-3 font-auctiq text-[clamp(2rem,6vw,4.5rem)] leading-[0.95] tracking-[0.02em] text-auctiq-text">
            EVERY NAME
            <br />
            <span className="text-auctiq-gold text-glow-gold">HAS A PRICE</span>
          </h2>
          <p className="mt-3 hidden max-w-md font-tech text-[13.5px] leading-relaxed text-auctiq-text/75 sm:block">
            Two hundred and eighty-four of them, scouted on seventeen metrics apiece. The bidding decides the rest.
          </p>
        </div>

        {/* Top chrome: a section label and a counter, like a console's home bar. */}
        <div className="ps-after absolute inset-x-0 top-0 z-10 flex items-center justify-between" style={{ padding: `${chromeTop}px ${pad}px 0` }}>
          <span className="flex items-center gap-2 font-tech text-[11px] uppercase tracking-[0.3em] text-auctiq-text/75">
            <span className="h-1.5 w-1.5 rounded-full bg-neon-cyan shadow-[0_0_10px_#22D3EE]" />
            On the block · Select a player
          </span>
          <span className="hidden font-tech text-[11px] uppercase tracking-[0.3em] text-auctiq-text/75 sm:inline">
            {players.length} players
          </span>
        </div>

        {/* Headline, sitting on the strip's top edge. */}
        <div
          className="ps-after absolute inset-x-0 top-0 z-10 flex flex-col justify-end"
          style={{ height: `${STRIP_TOP * 100}%`, paddingLeft: pad, paddingRight: pad, paddingBottom: Math.round(box.h * 0.03) }}
        >
          <div className="flex w-full flex-wrap items-end gap-x-10 gap-y-3">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.h2
                key={active.id}
                className="leading-[0.9]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.18 } }}
              >
                {[active.name.toUpperCase(), active.surname.toUpperCase()].map((line, i) => (
                  <span key={i} className="block overflow-hidden">
                    <motion.span
                      className={i === 0 ? "block font-tech font-semibold tracking-[0.32em] text-neon-cyan" : "block font-auctiq tracking-[0.02em]"}
                      style={{ fontSize: i === 0 ? Math.max(12, titleSize * 0.2) : titleSize }}
                      initial={{ y: "110%" }}
                      animate={{ y: 0 }}
                      transition={reduced ? INSTANT : { duration: 0.62, delay: i * 0.08, ease: EASE_OUT }}
                    >
                      {line}
                    </motion.span>
                  </span>
                ))}
              </motion.h2>
            </AnimatePresence>

            <div className="ml-auto flex items-end gap-8 sm:gap-12">
              {[`#${active.number}`, active.roleLabel, `${active.stat} ${active.statLabel}`].map((fact, i) => (
                <motion.span
                  key={`${active.id}-${i}`}
                  className="whitespace-nowrap font-tech text-[11px] uppercase tracking-[0.2em] text-auctiq-text/75"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={reduced ? INSTANT : { duration: 0.45, delay: 0.14 + i * 0.07 }}
                >
                  {fact}
                </motion.span>
              ))}
            </div>
          </div>
        </div>

        {/* The strip. */}
        <div className="absolute inset-x-0 z-10" style={{ top: `${STRIP_TOP * 100}%`, height: fullH + 40 }}>
          <motion.div
            className="flex items-start"
            style={{ gap }}
            animate={{ x: trackX }}
            initial={false}
            transition={reduced ? INSTANT : SPRING}
          >
            {players.map((player, i) => {
              const isFocus = i === index;
              const full = isFocus || !dealt;
              return (
                <div
                  key={player.id}
                  ref={(el) => { cardRefs.current[i] = el; }}
                  className="relative shrink-0"
                  style={{ width: cardW, height: fullH }}
                >
                  <motion.button
                    type="button"
                    aria-label={`${player.name} ${player.surname}${isFocus ? ", press Enter to view stats" : ""}`}
                    aria-current={isFocus}
                    onClick={() => (isFocus ? setSelected(i) : focus(i))}
                    className="absolute inset-0 block cursor-pointer"
                    animate={{
                      clipPath: full ? "inset(0% 0% 0% 0% round 14px)" : "inset(0% 0% 50% 0% round 14px)",
                      opacity: isFocus || !dealt ? 1 : 0.62,
                    }}
                    initial={false}
                    whileHover={isFocus || reduced ? undefined : { opacity: 0.9 }}
                    transition={reduced ? INSTANT : SPRING}
                  >
                    <CardFace player={player} height={fullH} focused={isFocus && dealt} numberHidden={selected === i} />
                  </motion.button>
                  {isFocus && dealt && selected === null ? (
                    <motion.div
                      key={`hint-${player.id}`}
                      className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-1.5 font-tech text-[10px] uppercase tracking-[0.24em] text-neon-cyan"
                      style={{ top: fullH + 14 }}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={reduced ? INSTANT : { delay: 0.35, duration: 0.4 }}
                    >
                      <CornerDownLeft className="h-3 w-3" aria-hidden /> Open
                    </motion.div>
                  ) : null}
                </div>
              );
            })}
          </motion.div>
        </div>

        {/* Position rail, with the arrows that move focus. */}
        <div className="ps-after absolute bottom-5 z-10 flex items-end gap-4" style={{ left: pad }}>
          <div style={{ width: Math.min(220, box.w * 0.2) }}>
            <div className="flex justify-between font-num text-sm tabular-nums text-auctiq-text/75">
              <span className="text-auctiq-text">{String(index + 1).padStart(2, "0")}</span>
              <span>{String(players.length).padStart(2, "0")}</span>
            </div>
            <div className="relative mt-2 h-px w-full bg-white/15">
              <motion.div
                className="absolute inset-y-0 bg-neon-cyan shadow-[0_0_8px_#22D3EE]"
                style={{ width: `${100 / players.length}%` }}
                animate={{ left: `${(index / players.length) * 100}%` }}
                transition={reduced ? INSTANT : SPRING}
              />
            </div>
          </div>
          <div className="flex gap-2">
            {[
              { label: "Previous player", icon: ChevronLeft, to: index - 1, off: index === 0 },
              { label: "Next player", icon: ChevronRight, to: index + 1, off: index === last },
            ].map(({ label, icon: Icon, to, off }) => (
              <button
                key={label}
                type="button"
                aria-label={label}
                disabled={off}
                onClick={() => focus(to)}
                className="grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-white/5 text-auctiq-text transition-colors hover:border-neon-cyan/60 hover:text-neon-cyan focus-visible:outline focus-visible:outline-2 focus-visible:outline-neon-cyan disabled:cursor-default disabled:opacity-30 disabled:hover:border-white/15 disabled:hover:text-auctiq-text"
              >
                <Icon className="h-5 w-5" aria-hidden />
              </button>
            ))}
          </div>
        </div>
        {/* Clear of the SCOUT button, which sits in this corner on every page. */}
        <div className="ps-after absolute bottom-6 z-10 hidden font-tech text-[10px] uppercase tracking-[0.24em] text-auctiq-text/75 lg:block" style={{ right: pad + 76 }}>
          Click a card or ← → to choose · Enter to open
        </div>

        <AnimatePresence>
          {chosen ? (
            <SelectScreen
              key={chosen.id}
              player={chosen}
              sheet={stats[chosen.id]}
              box={box}
              reduced={reduced}
              onClose={() => setSelected(null)}
            />
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}

/** The graded backdrop for the focused player, cross-faded on every change. */
function Backdrop({ player, keyId, reduced }: { player: ShowcasePlayer; keyId: number; reduced: boolean }) {
  return (
    <>
      <AnimatePresence initial={false}>
        <motion.div
          key={keyId}
          aria-hidden
          className="absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? INSTANT : { duration: 0.7, ease: "easeOut" }}
        >
          <div
            className="absolute inset-0"
            style={{
              background: `radial-gradient(70% 55% at 50% 62%, ${player.accent}38, transparent 70%), radial-gradient(60% 45% at 50% 105%, #0057E255, transparent 70%)`,
            }}
          />
          <motion.span
            className="absolute right-[-4vw] top-1/2 -translate-y-1/2 font-auctiq leading-none"
            style={{ fontSize: "62vh", color: "transparent", WebkitTextStroke: `2px ${player.accent}`, opacity: 0.12 }}
            initial={{ scale: reduced ? 1 : 1.12 }}
            animate={{ scale: 1 }}
            transition={reduced ? INSTANT : { duration: 6, ease: "linear" }}
          >
            {player.number}
          </motion.span>
        </motion.div>
      </AnimatePresence>
      {/* Neon floor grid and legibility wash, above the swap so they never flicker. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 opacity-40"
        style={{
          backgroundImage: "linear-gradient(#22D3EE22 1px, transparent 1px), linear-gradient(90deg, #22D3EE22 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "linear-gradient(to bottom, transparent, black 70%)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent, black 70%)",
          transform: "perspective(600px) rotateX(58deg)",
          transformOrigin: "bottom",
        }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-b from-auctiq-void/70 via-transparent to-auctiq-void/80" />
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.16] mix-blend-overlay" style={{ backgroundImage: GRAIN, backgroundSize: "180px 180px" }} />
    </>
  );
}

/**
 * A card's face: the shirt number in the franchise colour, and a name plate.
 * The number carries a shared layout id, so opening the card can lift it out
 * to the middle of the screen; `numberHidden` empties the card while it is out.
 */
function CardFace({
  player,
  height,
  focused,
  numberHidden = false,
}: {
  player: ShowcasePlayer;
  height: number;
  focused: boolean;
  numberHidden?: boolean;
}) {
  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-[14px] border bg-auctiq-card"
      style={{
        borderColor: focused ? `${NEON}AA` : "rgba(255,255,255,0.1)",
        boxShadow: focused ? `0 0 0 1px ${NEON}55, 0 0 32px ${NEON}40, 0 24px 60px rgba(0,0,0,0.55)` : "0 12px 30px rgba(0,0,0,0.45)",
      }}
    >
      <div aria-hidden className="absolute inset-0" style={{ background: `radial-gradient(120% 80% at 50% 0%, ${player.accent}55, transparent 68%)` }} />
      <div className="absolute inset-0 grid place-items-center" style={{ paddingBottom: height * 0.18 }}>
        {numberHidden ? null : (
          <motion.span
            layoutId={`ps-num-${player.id}`}
            aria-hidden
            className="font-auctiq leading-none tracking-tighter"
            style={{ fontSize: height * 0.46, color: player.accent, textShadow: `0 0 ${height * 0.12}px ${player.accent}66` }}
            transition={NUMBER_SPRING}
          >
            {player.number}
          </motion.span>
        )}
      </div>
      <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-1/3 w-full">
        <path d="M0 100 V60 Q50 88 100 60 V100 Z" fill={player.accent} fillOpacity="0.16" />
      </svg>
      <div className="absolute inset-x-0 bottom-0 border-t border-white/10 bg-auctiq-void/80 backdrop-blur-md" style={{ padding: `${height * 0.035}px ${height * 0.05}px` }}>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-tech uppercase tracking-[0.16em] text-auctiq-dim" style={{ fontSize: Math.max(9, height * 0.032) }}>
            {player.name}
          </span>
          <span
            className="shrink-0 rounded px-1.5 font-tech font-semibold uppercase tracking-[0.1em]"
            style={{ fontSize: Math.max(8, height * 0.028), color: ROLE_TINT[player.role], backgroundColor: `${ROLE_TINT[player.role]}1F` }}
          >
            {player.role}
          </span>
        </div>
        <div className="truncate font-auctiq leading-none tracking-[0.04em] text-auctiq-text" style={{ fontSize: Math.max(13, height * 0.06) }}>
          {player.surname.toUpperCase()}
        </div>
      </div>
    </div>
  );
}

/**
 * The selected screen. The jersey number arrives by shared layout from its
 * card; everything else is one GSAP timeline, so the order of arrival is
 * written down in one place.
 */
function SelectScreen({
  player,
  sheet,
  box,
  reduced,
  onClose,
}: {
  player: ShowcasePlayer;
  sheet: PlayerStatSheet | undefined;
  box: { w: number; h: number };
  reduced: boolean;
  onClose: () => void;
}) {
  const scope = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);

  // A phone has no room for three figures either side of the number, so there
  // the figures stack in the two top corners and the number sits below them.
  const narrow = box.w < 640;
  const digits = String(player.number).length;
  const numberSize = narrow ? Math.min(box.w * 0.5, box.h * 0.28) : Math.min(box.h * 0.5, box.w * 0.3);
  // Russo One's figures run about 0.66em wide.
  const numberW = numberSize * 0.66 * digits;
  const center = narrow ? 0.6 : 0.46;

  const left = sheet?.left ?? [];
  const right = sheet?.right ?? [];
  // Arrival order: alternate corners, top to bottom.
  const order: { stat: SelectStat; side: "left" | "right"; row: number }[] = [];
  for (let row = 0; row < Math.max(left.length, right.length); row++) {
    if (left[row]) order.push({ stat: left[row], side: "left", row });
    if (right[row]) order.push({ stat: right[row], side: "right", row });
  }

  useEffect(() => back.current?.focus({ preventScroll: true }), []);

  useGSAP(
    () => {
      if (reduced) return;
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
      tl.from(".sel-dim", { opacity: 0, duration: 0.35 }, 0)
        // A flash behind the number as it lands.
        .fromTo(".sel-flash", { scale: 0.4, opacity: 0.9 }, { scale: 1.6, opacity: 0, duration: 0.9, ease: "power2.out" }, 0.3)
        .fromTo(".sel-sweep", { xPercent: -140 }, { xPercent: 140, duration: 1.2, ease: "power2.inOut" }, 0.12)
        .from(".sel-name-line", { yPercent: 115, duration: 0.7, stagger: 0.08 }, 0.42)
        .from(".sel-chip", { opacity: 0, y: 10, duration: 0.4 }, 0.62)
        .from(".sel-back", { opacity: 0, x: -12, duration: 0.4 }, 0.45);

      gsap.utils.toArray<HTMLElement>(".sel-stat").forEach((el, k) => {
        const at = 0.7 + k * 0.17;
        const fromLeft = el.dataset.side === "left";
        const valueEl = el.querySelector<HTMLElement>(".sel-value");
        const target = Number(el.dataset.value);
        const decimals = Number(el.dataset.decimals);
        tl.from(el.querySelector(".sel-line"), { scaleX: 0, duration: 0.5, ease: "power2.out" }, at)
          .from(el.querySelector(".sel-node"), { scale: 0, duration: 0.35, ease: "back.out(2.4)" }, at + 0.32)
          .from(el.querySelector(".sel-label"), { x: fromLeft ? -18 : 18, opacity: 0, duration: 0.45 }, at + 0.04)
          .from(valueEl, { opacity: 0, y: 8, duration: 0.3 }, at + 0.1);
        if (valueEl) {
          const counter = { v: 0 };
          tl.to(
            counter,
            {
              v: target,
              duration: 0.9,
              ease: "power2.out",
              onStart: () => { valueEl.textContent = formatStat(0, decimals); },
              onUpdate: () => { valueEl.textContent = formatStat(counter.v, decimals); },
            },
            at + 0.1,
          );
        }
      });
    },
    { scope },
  );

  const rowTop = (row: number) => (narrow ? `${23 + row * 10}%` : `${22 + row * 20}%`);
  const edge = Math.max(14, box.w * 0.05);
  const statWidth = narrow ? `calc(50% - ${edge + 8}px)` : `calc(50% - ${numberW / 2 + edge + 28}px)`;

  return (
    <motion.div className="absolute inset-0 z-30" exit={{ opacity: 1 }} transition={{ duration: 0.45 }}>
      {/* Everything but the number fades on the way out; the number flies home. */}
      <motion.div ref={scope} className="absolute inset-0" exit={{ opacity: 0 }} transition={reduced ? INSTANT : { duration: 0.25 }}>
        <div className="sel-dim absolute inset-0 bg-auctiq-void/85 backdrop-blur-md" onClick={onClose} />
        <div
          aria-hidden
          className="sel-dim pointer-events-none absolute inset-0"
          style={{ background: `radial-gradient(45% 55% at 50% ${center * 100}%, ${player.accent}40, transparent 70%)` }}
        />
        {reduced ? null : (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2"
              style={{ top: `${center * 100}%`, width: numberSize * 1.2, height: numberSize * 1.2, marginLeft: -numberSize * 0.6, marginTop: -numberSize * 0.6 }}
            >
              <div className="sel-flash h-full w-full rounded-full" style={{ background: `radial-gradient(circle, ${player.accent}88, ${NEON}22 45%, transparent 70%)` }} />
            </div>
            <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
              <div className="sel-sweep absolute inset-y-0 left-0 w-full" style={{ background: `linear-gradient(100deg, transparent 35%, ${NEON}1F 50%, transparent 65%)`, transform: "translateX(-140%)" }} />
            </div>
          </>
        )}

        <button
          ref={back}
          type="button"
          onClick={onClose}
          className="sel-back absolute z-10 flex min-h-[44px] items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 font-tech text-[11px] uppercase tracking-[0.22em] text-auctiq-text transition-colors hover:border-neon-cyan/60 hover:text-neon-cyan focus-visible:outline focus-visible:outline-2 focus-visible:outline-neon-cyan"
          style={{ left: Math.max(18, box.w * 0.03), top: narrow ? 132 : Math.max(88, box.h * 0.11) }}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back <span className="text-auctiq-dim">Esc</span>
        </button>

        {/* Stats, in the corners. */}
        <dl className="absolute inset-0" aria-label={`${player.name} ${player.surname} career figures`}>
          {order.map(({ stat, side, row }) => (
            <div
              key={`${side}-${stat.label}`}
              className="sel-stat absolute flex items-center"
              data-side={side}
              data-value={stat.value}
              data-decimals={stat.decimals ?? 0}
              style={{
                top: rowTop(row),
                left: side === "left" ? edge : undefined,
                right: side === "right" ? edge : undefined,
                width: statWidth,
                flexDirection: side === "left" ? "row" : "row-reverse",
              }}
            >
              <div className={side === "left" ? "text-left" : "text-right"}>
                <dt className="sel-label font-tech text-[11px] uppercase tracking-[0.22em] text-auctiq-text/75">{stat.label}</dt>
                <dd className="sel-value font-num font-bold leading-none tabular-nums text-auctiq-text" style={{ fontSize: narrow ? clamp(box.w * 0.075, 22, 34) : clamp(box.h * 0.055, 22, 52) }}>
                  {formatStat(stat.value, stat.decimals)}
                </dd>
              </div>
              <div className="relative mx-3 hidden h-px flex-1 sm:block">
                <div
                  className="sel-line absolute inset-0"
                  style={{
                    background: `linear-gradient(${side === "left" ? "90deg" : "270deg"}, ${NEON}AA, ${NEON}22)`,
                    transformOrigin: side === "left" ? "left center" : "right center",
                  }}
                />
                <span
                  className="sel-node absolute top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-neon-cyan shadow-[0_0_10px_#22D3EE]"
                  style={side === "left" ? { right: -4 } : { left: -4 }}
                />
              </div>
            </div>
          ))}
        </dl>

        {/* Name lockup, under the number. */}
        <div className="pointer-events-none absolute inset-x-0 text-center" style={{ top: `calc(${center * 100}% + ${numberSize * 0.42 + 14}px)` }}>
          <div className="overflow-hidden">
            <div className="sel-name-line font-tech text-[12px] font-semibold uppercase tracking-[0.4em] text-neon-cyan">{player.name}</div>
          </div>
          <div className="overflow-hidden">
            <div className="sel-name-line font-auctiq leading-[1.05] tracking-[0.03em] text-auctiq-text" style={{ fontSize: clamp(box.h * 0.06, 26, 64) }}>
              {player.surname.toUpperCase()}
            </div>
          </div>
          <div className="sel-chip mt-2 inline-flex items-center gap-2 font-tech text-[11px] uppercase tracking-[0.2em] text-auctiq-text/75">
            <span className="rounded px-1.5 py-0.5 font-semibold" style={{ color: ROLE_TINT[player.role], backgroundColor: `${ROLE_TINT[player.role]}1F` }}>
              {player.roleLabel}
            </span>
            #{player.number} · {player.country}
          </div>
        </div>
      </motion.div>

      {/* The jersey number, out of its card and in the middle of the screen. */}
      <div className="pointer-events-none absolute inset-x-0 flex justify-center" style={{ top: `${center * 100}%`, transform: "translateY(-50%)" }}>
        <motion.span
          layoutId={`ps-num-${player.id}`}
          className="font-auctiq leading-none tracking-tighter"
          style={{
            fontSize: numberSize,
            color: player.accent,
            textShadow: `0 0 ${numberSize * 0.08}px ${player.accent}, 0 0 ${numberSize * 0.3}px ${player.accent}88, 0 0 ${numberSize * 0.6}px ${NEON}33`,
          }}
          transition={reduced ? INSTANT : NUMBER_SPRING}
        >
          {player.number}
        </motion.span>
      </div>
    </motion.div>
  );
}
