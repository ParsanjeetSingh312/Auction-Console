/**
 * AddToCalendar.tsx
 * "Add to calendar" for one scheduled auction: no Google sign-in.
 *
 *   Google Calendar   opens Google's own pre-filled "new event" page
 *   Apple / Outlook   downloads an .ics file every calendar app imports
 *   Copy link         the public auction page (/calendar/<token>), to paste
 *                     anywhere -- WhatsApp, a group, an email
 *   Share             (the auctioneer only) a bell notification to chosen
 *                     connections, which opens that same page
 *
 * Used on the Account page's schedule (with sharing) and on the public
 * auction page delegates open (without).
 */
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarPlus, Check, Copy, Download, Send } from "lucide-react";

import { googleCalendarUrl, icsUrl, sharePageUrl } from "../../console/calendarLinks";
import type { CalendarEvent } from "../../console/calendarLinks";
import { useConnections } from "../../console/connectionsApi";
import { shareEntry } from "../../console/scheduleApi";

const BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-card px-3 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink disabled:opacity-40";
const PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg bg-slate-ink px-3.5 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.08em] text-white transition-opacity hover:opacity-90 disabled:opacity-40";

interface Props {
  event: CalendarEvent;
  /** The auction's share token; null while it is being fetched. */
  token: string | null;
  /** Set on the auctioneer's own schedule: shows Copy link and Share. */
  entryId?: number;
}

export default function AddToCalendar({ event, token, entryId }: Props) {
  const [copied, setCopied] = useState(false);
  const [picking, setPicking] = useState(false);

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <a href={googleCalendarUrl(event)} target="_blank" rel="noreferrer" className={PRIMARY}>
          <CalendarPlus size={13} /> Google Calendar
        </a>
        <a
          href={token ? icsUrl(token) : undefined}
          aria-disabled={!token}
          className={`${BUTTON} ${token ? "" : "pointer-events-none opacity-40"}`}
          title="Apple Calendar, Outlook or any calendar app"
        >
          <Download size={13} /> Apple / Outlook (.ics)
        </a>
        {entryId !== undefined && (
          <>
            <button
              type="button"
              className={BUTTON}
              disabled={!token}
              onClick={async () => {
                if (!token) return;
                try {
                  await navigator.clipboard.writeText(sharePageUrl(token));
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1800);
                } catch {
                  window.prompt("Copy this link", sharePageUrl(token));
                }
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy link"}
            </button>
            <button type="button" className={BUTTON} onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
              <Send size={13} /> Share with delegates
            </button>
          </>
        )}
      </div>

      <AnimatePresence>
        {picking && entryId !== undefined && (
          <motion.div
            key="picker"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <SharePicker entryId={entryId} onDone={() => setPicking(false)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Tick connections, send: each gets a bell notification with the auction's page. */
function SharePicker({ entryId, onDone }: { entryId: number; onDone: () => void }) {
  const { data } = useConnections();
  const people = useMemo(() => data.friends.filter((p) => !p.admin), [data.friends]);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  return (
    <div className="mt-3 rounded-lg border border-line bg-white/[0.02] p-3">
      <p className="font-ui text-[11.5px] text-slate-muted">
        Each person gets a notification that opens this auction, where they can add it to their own calendar.
      </p>
      {people.length === 0 ? (
        <p className="mt-2 font-ui text-[12px] text-slate-muted">
          No connections yet. Connect with your delegates first, or use Copy link and send it yourself.
        </p>
      ) : (
        <>
          <div className="mt-2 flex items-center justify-between">
            <span className="font-ui text-[10.5px] text-slate-faint">{chosen.size} chosen</span>
            <button
              type="button"
              className="font-ui text-[11px] text-slate-muted underline underline-offset-2 hover:text-slate-ink"
              onClick={() => setChosen(chosen.size === people.length ? new Set() : new Set(people.map((p) => p.id)))}
            >
              {chosen.size === people.length ? "Clear" : "Choose all"}
            </button>
          </div>
          <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto">
            {people.map((p) => {
              const on = chosen.has(p.id);
              return (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-white/[0.04]">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setChosen((prev) => {
                          const next = new Set(prev);
                          if (on) next.delete(p.id);
                          else next.add(p.id);
                          return next;
                        })
                      }
                    />
                    <span className="flex-1 font-ui text-[12.5px] text-slate-body">{p.name}</span>
                    <span className="font-ui text-[10.5px] text-slate-faint">
                      {p.role === "member" ? "Free" : p.role === "delegate" ? "Delegate" : "Auctioneer"}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={PRIMARY}
          disabled={busy || chosen.size === 0}
          onClick={async () => {
            setBusy(true);
            setNote(null);
            try {
              const result = await shareEntry(entryId, [...chosen]);
              setNote({ tone: "ok", text: `Sent to ${result.shared} ${result.shared === 1 ? "person" : "people"}.` });
              setChosen(new Set());
            } catch (e) {
              setNote({ tone: "err", text: e instanceof Error ? e.message : "Could not share." });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Sending…" : "Send"}
        </button>
        <button type="button" className={BUTTON} onClick={onDone}>
          Close
        </button>
        {note && (
          <span className={`font-ui text-[12px] ${note.tone === "err" ? "text-[var(--unsold)]" : "text-[var(--sold)]"}`}>
            {note.text}
          </span>
        )}
      </div>
    </div>
  );
}
