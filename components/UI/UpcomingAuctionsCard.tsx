/**
 * UpcomingAuctionsCard.tsx
 * The purple panel: what goes under the hammer next.
 *
 * **On the reference's rows.** The mockup draws each row as two large times
 * either side of a VS — "13:30 TEAM M1 VS 00:55 TEAM M2" — which cannot be
 * right: a fixture has one start time and two sides, not a time each. It is a
 * generated artefact, the time element duplicated across the pair. What is
 * carried over is the treatment, which is the part worth having: one large
 * coloured figure per row, a VS joining two sides, and small dim labels
 * underneath. What is not carried over is the second clock.
 *
 * So a row here is a session: when it starts, and which two franchises are
 * expected to contest it.
 *
 * **On the colour.** The times are `neon-lilac`, not `neon-purple`, and this is
 * the one panel where that distinction earns its keep. `--neon` on a purple
 * card is #A855F7, which measures 5.10:1 on the page ground — legible, but only
 * just, and the labels beneath these figures are 9px. #C084FC measures 7.63:1
 * and carries them with room to spare. The border and its bloom keep the deeper
 * purple, because nothing is read off those.
 *
 * That is why the figures below name their colour outright instead of reading
 * `rgb(var(--neon))` the way GlowingButton does: inheriting the panel's hue is
 * right for a control, and wrong for small type.
 */

interface Session {
  /** 24-hour, because an auction room does not deal in am/pm. */
  time: string;
  day: string;
  home: string;
  away: string;
}

const SESSIONS: Session[] = [
  { time: "13:30", day: "Today", home: "MUM", away: "CHE" },
  { time: "19:00", day: "Tomorrow", home: "RCB", away: "KKR" },
];

export default function UpcomingAuctionsCard() {
  return (
    <article className="neon-card neon-card--purple flex flex-col p-4">
      <h2 className="font-stadium text-[17px] font-semibold uppercase tracking-[0.04em] text-auctiq-text">
        Upcoming Auctions
      </h2>
      <div className="neon-rule mt-2" />

      <ul className="mt-3 space-y-3">
        {SESSIONS.map((session) => (
          <li key={session.time}>
            <div className="flex items-baseline justify-between gap-3">
              {/*
                `tabular-nums` matters more here than anywhere else on the page:
                these are clock faces stacked vertically, and proportional digits
                would leave the colons out of line with each other.
              */}
              <span className="font-num text-[24px] font-bold leading-none tabular-nums text-neon-lilac">
                {session.time}
              </span>
              <span className="font-tech text-[9px] uppercase tracking-[0.18em] text-auctiq-dim">
                {session.day}
              </span>
            </div>

            <div className="mt-1.5 flex items-center gap-2">
              <Side code={session.home} />
              <span className="font-tech text-[9.5px] uppercase tracking-[0.14em] text-auctiq-dim/80">
                vs
              </span>
              <Side code={session.away} />
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-auto pt-3 font-tech text-[9.5px] uppercase tracking-[0.16em] text-auctiq-dim/70">
        All times IST
      </p>
    </article>
  );
}

/**
 * One franchise in a fixture.
 *
 * The three-letter code rather than the full name: at this width "Royal
 * Challengers Bengaluru vs Kolkata Knight Riders" either truncates or wraps to
 * three lines, and the codes are what the rest of the console uses anyway.
 */
function Side({ code }: { code: string }) {
  return (
    <span className="rounded-[3px] border border-white/10 bg-white/[0.04] px-2 py-[2px] font-tech text-[11px] font-semibold uppercase tracking-[0.06em] text-auctiq-text">
      {code}
    </span>
  );
}
