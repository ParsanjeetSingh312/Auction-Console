/**
 * TeamReport.tsx
 * SCOUT's verdict on the finished eleven.
 *
 * The store requests it the moment the eleventh legal pick lands, so this
 * component only ever renders state: writing, failed, or written. When the
 * report arrives the page scrolls to it once -- the user has just finished
 * the thing the whole page exists for, and should not have to go looking.
 *
 * The badge always says who wrote it. "SCOUT analysis" is a language model
 * working from the computed metrics; "Rule-based analysis" is the fallback
 * that states the same findings plainly. The grade is identical either way
 * (see aucteam/analysis.py), which is why it is safe to show it large.
 */
import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { RotateCcw } from "lucide-react";

import type { TeamReport as Report } from "../../console/aucteamApi";
import { generateReport, useAucteam, type LoadStatus } from "../../console/aucteamStore";
import ScoutEmblem from "../Scout/ScoutEmblem";
import { resetWithFlight } from "./resetFlight";

const GRADE_COLOUR = {
  A: "var(--aq-turf)",
  B: "var(--aq-pr)",
  C: "var(--aq-mq)",
  D: "var(--aq-alarm)",
} as const;

function Points({ items, mark, none }: { items: string[]; mark: string; none: string }) {
  if (items.length === 0) return <p className="aq-points--none">{none}</p>;
  return (
    <ul className="aq-points" style={{ ["--mark" as string]: mark }}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * The big Reset: every pick flies back to its card in the pool (resetFlight.ts)
 * and the board and this report clear, ready for a new XI.
 */
function ResetCta() {
  const reduced = useReducedMotion();
  return (
    <motion.button
      type="button"
      className="aq-reset"
      onClick={() => void resetWithFlight()}
      whileHover={reduced ? undefined : { scale: 1.015 }}
      whileTap={reduced ? undefined : { scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 26 }}
    >
      <span className="aq-reset__icon" aria-hidden>
        <RotateCcw className="h-6 w-6" strokeWidth={2} />
      </span>
      <span className="aq-reset__text">
        <strong>Reset and build a new XI</strong>
        <small>Every player goes back to the pool</small>
      </span>
    </motion.button>
  );
}

/**
 * The report, with a Framer Motion exit when Reset clears it.
 *
 * The body keeps rendering the last report it was given while it leaves: the
 * store is already idle by then, and an exit that rendered nothing would have
 * nothing to animate.
 */
export default function TeamReport() {
  const status = useAucteam((s) => s.reportStatus);
  const reduced = useReducedMotion();
  return (
    <AnimatePresence>
      {status !== "idle" && (
        <motion.div
          key="report"
          exit={reduced ? undefined : { opacity: 0, y: 48, transition: { duration: 0.35, ease: "easeIn" } }}
        >
          <ReportBody />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ReportBody() {
  const liveStatus = useAucteam((s) => s.reportStatus);
  const liveReport = useAucteam((s) => s.report);
  const liveError = useAucteam((s) => s.reportError);
  const last = useRef<{ status: LoadStatus; report: Report | null; error: string | null }>({
    status: liveStatus,
    report: liveReport,
    error: liveError,
  });
  if (liveStatus !== "idle") last.current = { status: liveStatus, report: liveReport, error: liveError };
  const { status, report, error } = last.current;
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (status === "ready" || status === "loading") {
      ref.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }
  }, [status, reduced]);

  if (status === "idle") return null;

  if (status === "loading") {
    return (
      <section ref={ref} id="aq-report" className="aq-report aq-report--pending" aria-live="polite" aria-busy>
        <div style={{ width: 72, height: 72 }} aria-hidden>
          <ScoutEmblem variant="mark" cycle={1.8} />
        </div>
        <div>
          <h2>SCOUT is reading your XI</h2>
          <p>Checking balance, the experience mix and what the side is missing. This takes a few seconds.</p>
        </div>
      </section>
    );
  }

  if (status === "error" || !report) {
    return (
      <section ref={ref} id="aq-report" className="aq-report aq-report--pending" role="alert">
        <div style={{ width: 72, height: 72 }} aria-hidden>
          <ScoutEmblem variant="mark" paused />
        </div>
        <div>
          <h2>The report did not come through</h2>
          <p>{error ?? "SCOUT could not write the report."}</p>
          <span style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <button type="button" className="aq-btn" onClick={() => void generateReport(true)}>
              Try again
            </button>
            <button type="button" className="aq-btn" onClick={() => void resetWithFlight()}>
              <RotateCcw aria-hidden className="h-4 w-4" />
              Reset
            </button>
          </span>
        </div>
      </section>
    );
  }

  const { metrics } = report;

  return (
    <motion.section
      ref={ref}
      id="aq-report"
      className="aq-report"
      aria-label="SCOUT team analysis report"
      initial={reduced ? false : { y: 24 }}
      animate={{ y: 0 }}
      transition={{ type: "spring", stiffness: 160, damping: 22 }}
    >
      <div className="aq-report__hero">
        <motion.div
          className="aq-grade"
          style={{ ["--grade" as string]: GRADE_COLOUR[report.grade] }}
          initial={reduced ? false : { scale: 1.6, rotate: -8 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 14, delay: 0.1 }}
          aria-label={`Grade ${report.grade}, ${report.score} out of 100`}
        >
          {report.grade}
          <small>{report.score}/100</small>
        </motion.div>
        <div>
          <h2 className="aq-report__headline">{report.headline}</h2>
          <p className="aq-report__summary">{report.summary}</p>
          <span className="aq-badge">
            <span
              className="aq-dot"
              style={{ ["--tier" as string]: report.mode === "llm" ? "var(--aq-pr)" : "var(--aq-dim)" }}
              aria-hidden
            />
            {report.mode === "llm" ? "SCOUT analysis" : "Rule-based analysis"}
            {report.team_name ? ` for ${report.team_name}` : ""}
          </span>
        </div>
      </div>

      <div className="aq-report__reset">
        <ResetCta />
      </div>

      <div className="aq-report__grid">
        {[report.balance, report.experience].map((section) => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            <p className="aq-verdict">{section.verdict}</p>
            <p className="aq-body">{section.body}</p>
          </section>
        ))}
      </div>

      <div className="aq-report__lists">
        <section>
          <h3>What works</h3>
          <Points items={report.strengths} mark="var(--aq-turf)" none="Nothing stands out yet." />
        </section>
        <section>
          <h3>Missing links</h3>
          <Points items={report.missing_links} mark="var(--aq-mq)" none="No gaps: every role is covered." />
        </section>
        <section>
          <h3>What could have been avoided</h3>
          <Points items={report.avoidable} mark="var(--aq-alarm)" none="No pick here is a clear mistake." />
        </section>
      </div>

      <div className="aq-report__foot">
        <span>
          {metrics.total_matches.toLocaleString("en-IN")} IPL matches between them, {metrics.avg_matches} a head.{" "}
          {report.notes.join(" ")}
        </span>
        <button type="button" className="aq-btn" onClick={() => void generateReport(true)}>
          Write it again
        </button>
      </div>
    </motion.section>
  );
}
