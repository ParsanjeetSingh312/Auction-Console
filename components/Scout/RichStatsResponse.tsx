/**
 * RichStatsResponse.tsx
 * The advisor's answer, as a dossier rather than a wall of text.
 *
 * **There is no Markdown here, and that is the whole reason this is worth
 * building.** The brief asks for "custom React components for Markdown
 * rendering", which assumes the model returns prose that has to be parsed back
 * into structure. It does not: `/api/v1/scout/advise/stream` returns an
 * `AdvisorRecommendation` — a validated Pydantic model whose candidates each
 * carry a typed `rationale`, a non-empty `evidence` list, an integer
 * `suggested_max_bid_lakh` and a `risks` list. Parsing that back out of
 * generated Markdown would be throwing away a contract the backend already
 * enforces, and re-deriving it with regular expressions.
 *
 * So each candidate below is a real card built from real fields. Nothing here
 * can misreport a figure by mis-parsing a heading.
 *
 * **Evidence is rendered with its numbers lifted out.** The backend's own
 * comment describes the format — short strings like "bat_sr 148.2 vs pool
 * median 131" — and the figure is the part a bidder reads. `highlight` below
 * splits on numbers and tints them, which is the brief's "inline highlighted
 * metrics" done against data rather than against prose.
 *
 * **A candidate with no suggested bid renders without one.** The backend leaves
 * `suggested_max_bid_lakh` null when there is no franchise context — the /data
 * screen asks questions with no team behind them — and an em dash in a price
 * slot reads as a missing number rather than an absent question.
 */
import { useRef } from "react";

import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import { money } from "../../console/format";
import type {
  AdvisorRecommendation,
  Candidate,
} from "../../console/scoutOrchestrator";

gsap.registerPlugin(useGSAP);

/**
 * Split a string so its numbers can be tinted.
 *
 * Deliberately naive: any run of digits with an optional decimal part. It will
 * also tint the "2" in "last 2 seasons", which is correct often enough and
 * wrong harmlessly — the alternative is a grammar for a format the backend
 * describes only by example.
 */
function highlight(text: string) {
  return text.split(/(\d+(?:\.\d+)?)/g).map((chunk, index) =>
    /^\d+(?:\.\d+)?$/.test(chunk) ? (
      <span key={index} className="font-num font-semibold text-cyan-300">
        {chunk}
      </span>
    ) : (
      <span key={index}>{chunk}</span>
    ),
  );
}

/** Role short codes to the tints the prototype's player cards already use. */
const ROLE_TINT: Record<string, string> = {
  BAT: "border-cyan-400/40 text-cyan-200",
  BOWL: "border-emerald-400/40 text-emerald-200",
  AR: "border-[#b58cff]/40 text-[#cdb4ff]",
  WK: "border-amber-400/40 text-amber-200",
};

function roleClass(role: string): string {
  const key = role.toUpperCase();
  return ROLE_TINT[key] ?? "border-white/15 text-auctiq-dim";
}

function CandidateCard({ candidate }: { candidate: Candidate }) {
  return (
    <li className="scout-candidate rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-auctiq text-[13px] leading-tight tracking-[0.03em] text-auctiq-text">
            {candidate.player_name}
          </div>
          <span
            className={`mt-1 inline-block rounded-full border px-1.5 py-px font-tech text-[9px] uppercase tracking-[0.14em] ${roleClass(candidate.role)}`}
          >
            {candidate.role}
          </span>
        </div>

        {candidate.suggested_max_bid_lakh != null && (
          <div className="flex-none text-right">
            <div className="font-tech text-[8.5px] uppercase tracking-[0.14em] text-auctiq-dim/70">
              Bid up to
            </div>
            <div className="font-num text-[15px] font-bold leading-tight text-auctiq-gold">
              {money(candidate.suggested_max_bid_lakh)}
            </div>
          </div>
        )}
      </div>

      <p className="mt-2 font-tech text-[11.5px] leading-relaxed text-auctiq-dim">
        {candidate.rationale}
      </p>

      {/* The figures the rationale rests on. The backend requires at least one,
          so this block never renders empty — an advisor that cannot cite
          anything is generating prose, and this is what makes that visible. */}
      <ul className="mt-2 space-y-1">
        {candidate.evidence.map((item, index) => (
          <li
            key={index}
            className="flex gap-1.5 font-tech text-[10.5px] leading-snug text-auctiq-dim/90"
          >
            <span className="mt-[5px] h-1 w-1 flex-none rounded-full bg-cyan-400/60" />
            <span>{highlight(item)}</span>
          </li>
        ))}
      </ul>

      {candidate.risks.length > 0 && (
        <ul className="mt-2 space-y-1 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] p-2">
          {candidate.risks.map((risk, index) => (
            <li
              key={index}
              className="font-tech text-[10px] leading-snug text-amber-200/90"
            >
              {risk}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export interface RichStatsResponseProps {
  recommendation: AdvisorRecommendation;
}

export default function RichStatsResponse({ recommendation }: RichStatsResponseProps) {
  const container = useRef<HTMLDivElement>(null);

  // The dossier arrives all at once — the stream sends one `result` event —
  // so the cards are staggered in rather than appearing as a block.
  useGSAP(
    () => {
      gsap.from(".scout-candidate", {
        y: 12,
        autoAlpha: 0,
        duration: 0.44,
        ease: "power3.out",
        stagger: 0.08,
      });
    },
    { scope: container },
  );

  const { answer, candidates, max_bid_lakh } = recommendation;

  /*
    The answer and the cards, and nothing about how they were made.

    The provenance strip (which model answered, refresh counts, timing) and the
    pipeline's notes used to sit under every answer. They read as filler to the
    people the answer is for, so they are gone; the backend still returns them
    for anyone debugging. The bid ceiling stays, because a "bid up to" figure
    means nothing without the purse it was worked out against.
  */
  return (
    <div ref={container} className="space-y-3">
      {/* The prose answer leads: it is the verdict. */}
      <p className="whitespace-pre-wrap font-tech text-[12.5px] leading-relaxed text-auctiq-text">
        {answer}
      </p>

      {candidates.length > 0 && (
        <ul className="space-y-2">
          {candidates.map((candidate) => (
            <CandidateCard key={candidate.player_id} candidate={candidate} />
          ))}
        </ul>
      )}

      {max_bid_lakh != null && candidates.some((c) => c.suggested_max_bid_lakh != null) && (
        <p className="font-tech text-[10px] uppercase tracking-[0.12em] text-auctiq-dim/70">
          Your ceiling {money(max_bid_lakh)}
        </p>
      )}
    </div>
  );
}
