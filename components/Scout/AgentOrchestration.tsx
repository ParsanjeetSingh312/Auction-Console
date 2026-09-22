/**
 * AgentOrchestration.tsx
 * The graph, while it is running.
 *
 * Three nodes on a rail — Supervisor, Data Researcher, Cricket Advisor — each
 * lighting up because the server said it started, not because a timer said it
 * should have. The distinction matters: a simulated pipeline is a progress bar
 * wearing a costume, and it lies the moment the backend is slow, fails, or
 * takes the branch the animation did not predict.
 *
 * **The rail is drawn vertically.** The brief's sketch runs left to right, and
 * that is the right shape on a full-width page; inside a 26.5rem drawer it
 * gives each node about seven characters of label. Vertical keeps the titles,
 * the status lines and the per-node notes all readable, and notes are the half
 * of this that carries information rather than reassurance.
 *
 * **Nodes can run more than once and the display has to admit it.** The graph
 * has one cyclic edge: the advisor can send the turn back to the researcher for
 * fresher data. When that happens the Researcher lights a second time and its
 * run counter appears. Hiding that would make a genuinely slower answer look
 * like a stuck one.
 *
 * All motion is GSAP. The pulse in particular has to stop when a node finishes,
 * which is a state CSS cannot see without duplicating the status onto a class
 * and animating from a keyframe that cannot be interrupted mid-cycle.
 */
import { useRef } from "react";

import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import type { AgentStep } from "../../console/scoutOrchestrator";

gsap.registerPlugin(useGSAP);

/** Tailwind classes per status, so the tone lives in one place. */
const TONE: Record<
  AgentStep["status"],
  { dot: string; ring: string; title: string; text: string }
> = {
  idle: {
    dot: "bg-white/20",
    ring: "border-white/10",
    title: "text-auctiq-dim",
    text: "text-auctiq-dim/70",
  },
  running: {
    dot: "bg-cyan-300",
    ring: "border-cyan-400/60",
    title: "text-cyan-200",
    text: "text-cyan-200/80",
  },
  done: {
    dot: "bg-auctiq-win",
    ring: "border-auctiq-win/45",
    title: "text-auctiq-text",
    text: "text-auctiq-dim",
  },
  failed: {
    dot: "bg-auctiq-out",
    ring: "border-auctiq-out/50",
    title: "text-auctiq-out",
    text: "text-auctiq-out/80",
  },
  // Dimmer than idle, because "not needed" should recede rather than look
  // like something still to come.
  skipped: {
    dot: "bg-white/12",
    ring: "border-white/[0.07]",
    title: "text-auctiq-dim/55",
    text: "text-auctiq-dim/45",
  },
};

export interface AgentOrchestrationProps {
  steps: AgentStep[];
  /** Request-level notes — those not attributable to any one agent. */
  notes?: string[];
}

export default function AgentOrchestration({
  steps,
  notes = [],
}: AgentOrchestrationProps) {
  const container = useRef<HTMLDivElement>(null);

  /*
    The signature is what drives the tween, not `steps` itself.

    `steps` is a fresh array on every event, including the note events that
    change no status at all. Depending on it would rebuild the pulse several
    times per node and restart it mid-cycle, which reads as a stutter. The
    joined statuses change only when something genuinely transitioned.
  */
  const signature = steps.map((step) => `${step.id}:${step.status}`).join("|");

  useGSAP(
    () => {
      const media = gsap.matchMedia();

      media.add("(prefers-reduced-motion: no-preference)", () => {
        // The working node breathes. One timeline for however many are
        // running — in this graph always exactly one, but the selector does
        // not need to assume that.
        gsap.to('[data-agent-status="running"] .agent-halo', {
          scale: 1.9,
          opacity: 0,
          duration: 1.5,
          ease: "sine.out",
          repeat: -1,
          stagger: 0.2,
        });

        gsap.to('[data-agent-status="running"] .agent-dot', {
          opacity: 0.55,
          duration: 0.85,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
        });
      });

      // A node that has just finished settles once, in every motion mode —
      // a reduced-motion user still gets the state change, just instantly.
      gsap.from('[data-agent-status="done"] .agent-dot', {
        scale: 1.6,
        duration: 0.42,
        ease: "back.out(1.7)",
      });

      return () => media.revert();
    },
    { dependencies: [signature], scope: container },
  );

  /*
    Entrance for the rail as a whole, the first time it appears.

    Keyed on whether there are steps at all rather than on their contents, so
    it plays once per run instead of on every event.
  */
  useGSAP(
    () => {
      if (steps.length === 0) return;
      gsap.from(".agent-row", {
        x: -8,
        autoAlpha: 0,
        duration: 0.38,
        ease: "power3.out",
        stagger: 0.07,
      });
    },
    { dependencies: [steps.length > 0], scope: container },
  );

  if (steps.length === 0) return null;

  return (
    <div
      ref={container}
      className="rounded-xl border border-white/10 bg-black/20 p-3"
      role="status"
      aria-live="polite"
    >
      <div className="mb-2.5 font-tech text-[9.5px] uppercase tracking-[0.18em] text-auctiq-dim/70">
        Agent pipeline
      </div>

      <ol className="space-y-0">
        {steps.map((step, index) => {
          const tone = TONE[step.status];
          const isLast = index === steps.length - 1;

          return (
            <li
              key={step.id}
              data-agent-status={step.status}
              className="agent-row relative grid grid-cols-[18px_1fr] gap-x-2.5"
            >
              {/* The rail: a dot, its halo, and the connector to the next
                  node. The connector is drawn on every row but the last, and
                  tints once the node above it has finished — so the rail
                  fills downward as the graph progresses. */}
              <div className="relative flex flex-col items-center">
                <span className={`relative mt-1 grid h-[18px] w-[18px] place-items-center rounded-full border ${tone.ring}`}>
                  <span
                    className="agent-halo absolute inset-0 rounded-full border border-cyan-400/50"
                    style={{ opacity: step.status === "running" ? 1 : 0 }}
                    aria-hidden
                  />
                  <span className={`agent-dot h-[7px] w-[7px] rounded-full ${tone.dot}`} />
                </span>

                {!isLast && (
                  <span
                    className={`w-px flex-1 ${
                      step.status === "done"
                        ? "bg-auctiq-win/35"
                        : step.status === "failed"
                          ? "bg-auctiq-out/35"
                          : "bg-white/10"
                    }`}
                    aria-hidden
                  />
                )}
              </div>

              <div className={isLast ? "pb-0.5" : "pb-3"}>
                <div className="flex items-baseline gap-2">
                  <span className={`font-tech text-[11.5px] font-semibold tracking-[0.04em] ${tone.title}`}>
                    {step.title}
                  </span>

                  {/* Only shown once a node has genuinely run twice. */}
                  {step.runs > 1 && (
                    <span className="rounded-full border border-auctiq-gold/35 px-1.5 font-tech text-[9px] tracking-[0.1em] text-auctiq-gold">
                      RUN {step.runs}
                    </span>
                  )}
                </div>

                <p className={`mt-0.5 font-tech text-[10.5px] leading-snug ${tone.text}`}>
                  {step.status === "failed"
                    ? step.detail || "This agent failed."
                    : step.status === "done"
                      ? step.done
                      : step.status === "running"
                        ? step.running
                        : "Waiting"}
                </p>

                {/* What the agent actually reported. Every fallback, every
                    source that refused, every cycle that ran out of time —
                    the same rule the rest of the product follows, so a
                    degraded answer arrives looking degraded. */}
                {step.notes.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 border-l border-white/10 pl-2">
                    {step.notes.map((note, noteIndex) => (
                      <li
                        key={noteIndex}
                        className="font-tech text-[10px] leading-snug text-auctiq-dim/80"
                      >
                        {note}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {notes.length > 0 && (
        <ul className="mt-2.5 space-y-0.5 border-t border-white/10 pt-2">
          {notes.map((note, index) => (
            <li
              key={index}
              className="font-tech text-[10px] leading-snug text-auctiq-dim/80"
            >
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
