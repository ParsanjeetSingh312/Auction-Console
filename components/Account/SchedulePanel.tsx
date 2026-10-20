/**
 * SchedulePanel.tsx
 * The auctioneer's schedule: a month view, a form to schedule or change an
 * auction, the upcoming list, and the Google Calendar link.
 *
 * The schedule lives in AUCTONIQ (accounts/schedule.py) and always works.
 * Connecting Google Calendar signs the auctioneer in with Google once; from
 * then on every auction saved here is copied into their Google Calendar, and
 * changed or removed there when it changes here. The server reports each copy
 * (`sync`), and a failed copy is shown without losing the saved entry.
 *
 * Coming back from Google's consent screen lands on /account?google=...,
 * which this panel reads once, shows, and clears from the address bar.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarCheck, ChevronLeft, ChevronRight, RefreshCw, Unlink } from "lucide-react";

import {
  createEntry,
  deleteEntry,
  disconnectGoogle,
  fetchSchedule,
  googleConnectUrl,
  syncGoogle,
  updateEntry,
} from "../../console/scheduleApi";
import type { GoogleStatus, RoomType, ScheduleEntry, SyncResult } from "../../console/scheduleApi";
import UpcomingAuctionsCard from "../UI/UpcomingAuctionsCard";

const LABEL = "font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint";
const FIELD =
  "mt-1 w-full rounded-lg border border-line bg-surface-sunken px-3 py-2 font-ui text-[13px] text-slate-ink outline-none focus:border-slate-faint";
const BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-card px-3 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink disabled:opacity-40";
const PRIMARY =
  "rounded-lg bg-slate-ink px-4 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-white transition-opacity hover:opacity-90 disabled:opacity-40";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DURATIONS = [60, 90, 120, 180, 240];

interface Draft {
  id: number | null;
  title: string;
  date: string; // yyyy-mm-dd, local
  time: string; // hh:mm, local
  duration_min: number;
  room_type: RoomType;
  notes: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function blankDraft(day?: Date): Draft {
  const when = day ? new Date(day) : new Date(Date.now() + 24 * 3600 * 1000);
  return { id: null, title: "", date: dateKey(when), time: "19:00", duration_min: 120, room_type: "auctioneer", notes: "" };
}

function draftFrom(entry: ScheduleEntry): Draft {
  const d = new Date(entry.starts_at * 1000);
  return {
    id: entry.id,
    title: entry.title,
    date: dateKey(d),
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    duration_min: entry.duration_min,
    room_type: entry.room_type,
    notes: entry.notes,
  };
}

/** The draft's start as epoch seconds, read in the viewer's local time. */
function startsAt(draft: Draft): number {
  const [y, m, d] = draft.date.split("-").map(Number);
  const [hh, mm] = draft.time.split(":").map(Number);
  return Math.floor(new Date(y, m - 1, d, hh, mm).getTime() / 1000);
}

function syncMessage(sync: SyncResult, google: GoogleStatus | null): string | null {
  if (sync.state === "error") return sync.error ?? "Could not copy it to Google Calendar.";
  if (sync.state === "synced") return "Saved, and copied to your Google Calendar.";
  return google?.connected ? null : "Saved in AUCTONIQ.";
}

export default function SchedulePanel() {
  const [entries, setEntries] = useState<ScheduleEntry[] | null>(null);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [params, setParams] = useSearchParams();

  const load = useCallback(async () => {
    try {
      const data = await fetchSchedule();
      setEntries(data.entries);
      setGoogle(data.google);
    } catch (e) {
      setEntries([]);
      setNote({ tone: "err", text: e instanceof Error ? e.message : "Could not load your schedule." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The return trip from Google's consent screen.
  useEffect(() => {
    const result = params.get("google");
    if (!result) return;
    setNote(
      result === "connected"
        ? { tone: "ok", text: "Google Calendar connected. Your upcoming auctions were copied across." }
        : { tone: "err", text: params.get("reason") || "Google Calendar could not be connected." },
    );
    const next = new URLSearchParams(params);
    next.delete("google");
    next.delete("reason");
    setParams(next, { replace: true });
    void load();
  }, [params, setParams, load]);

  /** Entries by local date, for the dots on the month view. */
  const byDay = useMemo(() => {
    const map = new Map<string, ScheduleEntry[]>();
    for (const entry of entries ?? []) {
      const key = dateKey(new Date(entry.starts_at * 1000));
      map.set(key, [...(map.get(key) ?? []), entry]);
    }
    return map;
  }, [entries]);

  const cells = useMemo(() => {
    const first = new Date(month);
    const lead = (first.getDay() + 6) % 7; // Monday first
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);

  const today = dateKey(new Date());

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setNote(null);
    const input = {
      title: draft.title,
      starts_at: startsAt(draft),
      duration_min: draft.duration_min,
      notes: draft.notes,
      room_type: draft.room_type,
    };
    try {
      const result = draft.id === null ? await createEntry(input) : await updateEntry(draft.id, input);
      const text = syncMessage(result.sync, google);
      setNote(text ? { tone: result.sync.state === "error" ? "err" : "ok", text } : null);
      setDraft(null);
      await load();
    } catch (e) {
      setNote({ tone: "err", text: e instanceof Error ? e.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft || draft.id === null) return;
    setBusy(true);
    try {
      const result = await deleteEntry(draft.id);
      setNote(
        result.sync.state === "error"
          ? { tone: "err", text: result.sync.error ?? "Removed here, but not from Google Calendar." }
          : { tone: "ok", text: "Removed from your schedule." },
      );
      setDraft(null);
      await load();
    } catch (e) {
      setNote({ tone: "err", text: e instanceof Error ? e.message : "Could not remove it." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {/* ---- Google Calendar link ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-white/[0.02] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <CalendarCheck size={18} className={google?.connected ? "text-[var(--sold)]" : "text-slate-faint"} />
          <div className="min-w-0">
            <p className="font-ui text-[12.5px] font-semibold text-slate-ink">Google Calendar</p>
            <p className="truncate font-ui text-[11.5px] text-slate-muted">
              {!google
                ? "Checking…"
                : google.connected
                  ? `Synced to ${google.email ?? "your Google account"}`
                  : google.configured
                    ? "Sign in with Google to copy every scheduled auction into your calendar."
                    : "Not set up on this server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). The schedule still works here."}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {google?.connected ? (
            <>
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await syncGoogle();
                    setNote(
                      r.errors.length
                        ? { tone: "err", text: r.errors[0] }
                        : { tone: "ok", text: `${r.synced} auction${r.synced === 1 ? "" : "s"} synced.` },
                    );
                    await load();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RefreshCw size={12} /> Sync now
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={async () => {
                  setGoogle(await disconnectGoogle());
                  setNote({ tone: "ok", text: "Google Calendar disconnected. Events already copied stay in it." });
                }}
              >
                <Unlink size={12} /> Disconnect
              </button>
            </>
          ) : (
            google?.configured && (
              <a href={googleConnectUrl()} className={PRIMARY}>
                Connect Google Calendar
              </a>
            )
          )}
        </div>
      </div>

      <AnimatePresence>
        {note && (
          <motion.p
            key={note.text}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`mt-3 font-ui text-[12px] ${note.tone === "err" ? "text-[var(--unsold)]" : "text-[var(--sold)]"}`}
            role="status"
          >
            {note.text}
          </motion.p>
        )}
      </AnimatePresence>

      <div className="mt-5 grid gap-5 md:grid-cols-[minmax(0,1fr)_260px]">
        {/* ---- month view ---- */}
        <div>
          <div className="flex items-center justify-between">
            <h3 className={LABEL}>
              {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </h3>
            <div className="flex gap-1">
              <button
                type="button"
                aria-label="Previous month"
                className="grid h-7 w-7 place-items-center rounded-md border border-line text-slate-muted hover:text-slate-ink"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                aria-label="Next month"
                className="grid h-7 w-7 place-items-center rounded-md border border-line text-slate-muted hover:text-slate-ink"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-7 gap-1 text-center">
            {WEEKDAYS.map((d) => (
              <span key={d} className="py-1 font-ui text-[9.5px] font-semibold uppercase tracking-[0.1em] text-slate-faint">
                {d}
              </span>
            ))}
            {cells.map((day) => {
              const key = dateKey(day);
              const inMonth = day.getMonth() === month.getMonth();
              const items = byDay.get(key) ?? [];
              const past = key < today;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={past}
                  onClick={() => setDraft(items[0] ? draftFrom(items[0]) : blankDraft(day))}
                  title={items.map((e) => e.title).join(", ") || (past ? undefined : "Schedule an auction")}
                  className={`relative flex h-11 flex-col items-center justify-center rounded-md border font-ui text-[12px] transition-colors ${
                    key === today ? "border-[var(--teal)]" : "border-transparent"
                  } ${inMonth ? "text-slate-body" : "text-slate-faint/50"} ${
                    past ? "cursor-default opacity-50" : "hover:border-line hover:bg-white/[0.04]"
                  } ${draft && draft.date === key ? "bg-[var(--teal-tint)]" : ""}`}
                >
                  {day.getDate()}
                  {items.length > 0 && (
                    <span className="mt-0.5 flex gap-0.5" aria-label={`${items.length} scheduled`}>
                      {items.slice(0, 3).map((e) => (
                        <i key={e.id} className="h-1.5 w-1.5 rounded-full bg-[#C084FC]" />
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {!draft && (
            <button type="button" className={`${PRIMARY} mt-3`} onClick={() => setDraft(blankDraft())}>
              Schedule an auction
            </button>
          )}
        </div>

        {/* ---- upcoming ---- */}
        <UpcomingAuctionsCard entries={entries ?? []} limit={5} onSelect={(e) => setDraft(draftFrom(e))} />
      </div>

      {/* ---- the form ---- */}
      <AnimatePresence>
        {draft && (
          <motion.form
            key="draft"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="mt-5 border-t border-line pt-4">
              <h3 className={LABEL}>{draft.id === null ? "Schedule an auction" : "Change this auction"}</h3>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <label className="block font-ui text-[11px] text-slate-muted sm:col-span-2">
                  Name
                  <input
                    required
                    maxLength={120}
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    className={FIELD}
                    placeholder="Mega auction · Season 2"
                  />
                </label>
                <label className="block font-ui text-[11px] text-slate-muted">
                  Date
                  <input
                    required
                    type="date"
                    min={today}
                    value={draft.date}
                    onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                    className={FIELD}
                  />
                </label>
                <label className="block font-ui text-[11px] text-slate-muted">
                  Start time
                  <input
                    required
                    type="time"
                    value={draft.time}
                    onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                    className={FIELD}
                  />
                </label>
                <label className="block font-ui text-[11px] text-slate-muted">
                  Length
                  <select
                    value={draft.duration_min}
                    onChange={(e) => setDraft({ ...draft, duration_min: Number(e.target.value) })}
                    className={FIELD}
                  >
                    {DURATIONS.map((m) => (
                      <option key={m} value={m}>
                        {m < 60 ? `${m} min` : `${m / 60} hour${m === 60 ? "" : "s"}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block font-ui text-[11px] text-slate-muted">
                  Room
                  <select
                    value={draft.room_type}
                    onChange={(e) => setDraft({ ...draft, room_type: e.target.value as RoomType })}
                    className={FIELD}
                  >
                    <option value="auctioneer">Auctioneer room</option>
                    <option value="delegate">Delegate room</option>
                  </select>
                </label>
                <label className="block font-ui text-[11px] text-slate-muted sm:col-span-2">
                  Notes for the calendar
                  <textarea
                    rows={2}
                    maxLength={600}
                    value={draft.notes}
                    onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                    className={FIELD}
                    placeholder="Ten franchises. Room code sent on the day."
                  />
                </label>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button type="submit" className={PRIMARY} disabled={busy || !draft.title.trim()}>
                  {busy ? "Saving…" : draft.id === null ? "Schedule" : "Save changes"}
                </button>
                <button type="button" className={BUTTON} onClick={() => setDraft(null)}>
                  Cancel
                </button>
                {draft.id !== null && (
                  <button type="button" className={`${BUTTON} ml-auto hover:!border-[var(--unsold)] hover:!text-[var(--unsold)]`} disabled={busy} onClick={() => void remove()}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
