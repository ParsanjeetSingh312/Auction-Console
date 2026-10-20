/**
 * WaitingRoomSection.tsx
 * The waiting room, inside the Send passes dialog when it is opened for a room.
 *
 * Passes sent from here are invites to that room (api/routes_ecosystem.py).
 * Each invitee moves along four steps -- pass sent, claimed, seated,
 * acknowledged -- and the auction cannot start until every one of them has
 * acknowledged the rules (accounts/invites.py, enforced in auction/room.py).
 * Once the auctioneer has opened the waiting room, the last acknowledgement
 * starts the auction for everyone.
 *
 * The list polls every few seconds while the dialog is open: claims and
 * seats happen on other people's screens, and this is where the auctioneer
 * watches them land.
 */
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, X } from "lucide-react";

import { fetchWaitingRoom, removeInvitee } from "../../console/ecosystemStore";
import type { InviteState, WaitingRoomStatus } from "../../console/ecosystemStore";

const STEPS: { state: InviteState; label: string }[] = [
  { state: "sent", label: "Pass sent" },
  { state: "claimed", label: "Claimed" },
  { state: "seated", label: "Seated" },
  { state: "acknowledged", label: "Acknowledged" },
];
const RANK: Record<InviteState, number> = { sent: 0, claimed: 1, seated: 2, acknowledged: 3, returned: -1 };
const POLL_MS = 4000;

interface Props {
  code: string;
  /** Bumped by the dialog after a send, to refresh at once. */
  refreshKey: number;
}

export default function WaitingRoomSection({ code, refreshKey }: Props) {
  const [data, setData] = useState<WaitingRoomStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchWaitingRoom(code));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the waiting room.");
    }
  }, [code]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, refreshKey]);

  const ready = data?.invitees.filter((p) => p.state === "acknowledged").length ?? 0;
  const total = data?.invitees.filter((p) => p.state !== "returned").length ?? 0;

  return (
    <section aria-label="Waiting room" className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h3 className="font-tech text-[10px] font-semibold uppercase tracking-[0.2em] text-[#94a3b8]">
            Waiting room · {code}
          </h3>
          <p className="mt-0.5 font-ui text-[11.5px] text-[#cbd5e1]">
            {total === 0
              ? "Send Delegate passes below. Everyone you invite must claim, sit down and acknowledge the rules before the auction starts."
              : data?.phase === "live"
                ? "The auction is running. Delegates cannot leave their seats until it finishes."
                : data?.ready
                  ? "Everyone is ready. Start the auction from the control panel."
                  : `${ready} of ${total} ready. The auction starts once everyone has acknowledged.`}
          </p>
        </div>
        {total > 0 && (
          <span
            className={`shrink-0 rounded-full border px-2.5 py-1 font-tech text-[10.5px] font-semibold uppercase tracking-[0.12em] ${
              data?.ready ? "border-[#34D399] text-[#34D399]" : "border-[#F6C45A]/60 text-[#F6C45A]"
            }`}
          >
            {data?.ready ? "Ready" : `${ready}/${total}`}
          </span>
        )}
      </header>

      {error && <p className="mt-2 font-ui text-[11.5px] text-[#f87171]">{error}</p>}

      {data && data.invitees.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          <AnimatePresence initial={false}>
            {data.invitees.map((person) => {
              const rank = RANK[person.state];
              return (
                <motion.li
                  key={person.account_id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md bg-white/[0.03] px-2.5 py-2"
                >
                  <span className="min-w-0 flex-1 truncate font-ui text-[12.5px] text-[#f8fafc]">
                    {person.name}
                    {person.team_code && (
                      <span className="ml-1.5 font-tech text-[10px] uppercase tracking-[0.1em] text-[#94a3b8]">
                        {person.team_code}
                      </span>
                    )}
                  </span>
                  {person.state === "returned" ? (
                    <span className="font-ui text-[11px] text-[#94a3b8]">Pass expired unclaimed</span>
                  ) : (
                    <ol className="flex items-center gap-1" aria-label={`${person.name}: ${person.state}`}>
                      {STEPS.map((step, i) => {
                        const done = rank >= i;
                        return (
                          <li key={step.state} className="flex items-center gap-1">
                            {i > 0 && <span aria-hidden className={`h-px w-3 ${done ? "bg-[#34D399]" : "bg-white/15"}`} />}
                            <motion.span
                              title={step.label}
                              initial={false}
                              animate={{ scale: done ? 1 : 0.85, opacity: done ? 1 : 0.55 }}
                              className={`grid h-5 w-5 place-items-center rounded-full border text-[9px] ${
                                done ? "border-[#34D399] bg-[#34D399]/15 text-[#34D399]" : "border-white/20 text-[#94a3b8]"
                              }`}
                            >
                              {done ? <Check size={11} /> : i + 1}
                            </motion.span>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  {data.phase !== "live" && data.phase !== "finished" && person.state !== "acknowledged" && (
                    <button
                      type="button"
                      aria-label={`Remove ${person.name} from the invite list`}
                      title="Remove from the invite list"
                      onClick={async () => {
                        await removeInvitee(code, person.account_id);
                        void load();
                      }}
                      className="grid h-6 w-6 place-items-center rounded-md text-[#94a3b8] hover:bg-white/10 hover:text-[#f8fafc]"
                    >
                      <X size={12} />
                    </button>
                  )}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}

      {data && data.invitees.length > 0 && (
        <p className="mt-2 font-ui text-[10.5px] text-[#94a3b8]">
          Steps: pass sent → claimed → seated → acknowledged.
        </p>
      )}
    </section>
  );
}
