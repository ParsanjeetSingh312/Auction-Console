/**
 * WalletPanel.tsx
 * The account page's wallet: both passes at full size, what the account can
 * do with them, and the ledger -- every pass that came in or went out, and
 * why. For administrators, a second panel: grant passes to anyone, and send
 * an announcement to every bell.
 *
 * Styled with the account page's own tokens (seat-chair card, slate type) so
 * it reads as part of that page rather than a dark island dropped onto it.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";

import type { Account } from "../../console/accountStore";
import { broadcast, ledger, openSendPasses, useEcosystem } from "../../console/ecosystemStore";
import type { LedgerEntry } from "../../console/ecosystemStore";
import { cardVariants } from "../../console/motion";
import FlipPass from "../Passes/FlipPass";

const BUTTON =
  "rounded-lg border border-line bg-surface-card px-3.5 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink";
const PRIMARY =
  "rounded-lg bg-slate-ink px-4 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-white transition-opacity hover:opacity-90 disabled:opacity-40";

const REASON: Record<string, string> = {
  generate: "Generated",
  gift_out: "Sent to",
  claim: "Received from",
  spend: "Spent on",
  refund: "Refunded",
  gift_returned: "Came back from",
  demo_top_up: "Demo top-up",
};

function describe(entry: LedgerEntry): string {
  const what = REASON[entry.reason] ?? entry.reason;
  if (entry.reason === "spend" || entry.reason === "refund") {
    const [, code, , action] = (entry.ref ?? "").split(":");
    return `${what} ${action === "create" ? "opening room" : "a seat in room"} ${code ?? ""}`.trim();
  }
  if (entry.reason === "claim" && !entry.counterpart) return "Received from AUCTONIQ";
  return entry.counterpart ? `${what} ${entry.counterpart}` : what;
}

export default function WalletPanel({ account }: { account: Account }) {
  const { balances, capabilities } = useEcosystem();
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const canSend = (capabilities?.send.length ?? 0) > 0;
  const tier = account.admin ? "admin" : account.role;

  useEffect(() => {
    let live = true;
    ledger(15)
      .then((rows) => live && setEntries(rows))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [balances.A, balances.D]);

  return (
    <>
      <motion.section
        variants={cardVariants}
        className="seat-chair relative mt-5 overflow-hidden rounded-xl border border-line p-6"
        aria-label="Wallet"
      >
        <span aria-hidden className="seat-chair__rule" />
        <h2 className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">Wallet</h2>
        {/* Two-sided cards: click to turn one over and read its powers. */}
        <div className="mt-4 flex flex-wrap justify-center gap-8">
          <FlipPass kind="A" size="lg" count={balances.A} tier={tier} intro />
          <FlipPass kind="D" size="lg" count={balances.D} tier={tier} intro />
        </div>
        <p className="mt-5 font-ui text-[12.5px] leading-relaxed text-slate-body">
          {account.admin
            ? "Administrators open rooms free, and generate and send both passes without limit."
            : account.role === "auctioneer"
              ? "A gold pass opens one auctioneer room. Generate blue passes for your Delegates and Free players and send them from here."
              : account.role === "delegate"
                ? "A blue pass takes a franchise seat in an Auctioneer's room, or opens a delegate room of your own."
                : "A blue pass takes a franchise seat in an Auctioneer's room. Connect with your Auctioneer to receive one."}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {canSend && (
            <button type="button" className={PRIMARY} onClick={() => openSendPasses()}>
              Send passes →
            </button>
          )}
          <Link to="/connections" className={BUTTON}>
            Connections
          </Link>
        </div>

        <h3 className="mt-6 border-t border-line pt-4 font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
          History
        </h3>
        {entries === null ? (
          <p className="mt-2 font-ui text-[12px] text-slate-muted">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="mt-2 font-ui text-[12px] text-slate-muted">No passes have moved yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2">
                <span
                  className="grid h-6 w-8 shrink-0 place-items-center rounded-[4px] font-auctiq text-[11px] text-[#020617]"
                  style={{ background: entry.kind === "A" ? "linear-gradient(128deg,#e3a92c,#ffe08a)" : "linear-gradient(128deg,#3b7cf0,#cfe2ff)" }}
                >
                  {entry.kind}
                </span>
                <span className="min-w-0 flex-1 truncate font-ui text-[12.5px] text-slate-body">{describe(entry)}</span>
                <span
                  className={`font-num text-[15px] font-bold ${entry.delta > 0 ? "text-[#34D399]" : "text-slate-muted"}`}
                >
                  {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                </span>
                <span className="hidden w-[78px] text-right font-ui text-[10.5px] text-slate-faint sm:block">
                  {new Date(entry.created_at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </motion.section>

      {account.admin && <AdminPanel />}
    </>
  );
}

function AdminPanel() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [roles, setRoles] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field =
    "mt-1 w-full rounded-lg border border-line bg-surface-sunken px-3 py-2 font-ui text-[13px] text-slate-ink outline-none focus:border-slate-faint";

  return (
    <motion.section
      variants={cardVariants}
      className="seat-chair relative mt-5 overflow-hidden rounded-xl border border-[#E8C547]/40 p-6"
      aria-label="Administrator tools"
    >
      <h2 className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-[#E8C547]">Administrator</h2>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="font-ui text-[12.5px] text-slate-body">Grant gold or blue passes to any account.</p>
        <button type="button" className={PRIMARY} onClick={() => openSendPasses()}>
          Grant passes →
        </button>
      </div>

      <form
        className="mt-5 border-t border-line pt-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setResult(null);
          try {
            const sent = await broadcast({ title, body, roles: roles.size ? [...roles] : undefined });
            setResult(`Sent to ${sent} account${sent === 1 ? "" : "s"}.`);
            setTitle("");
            setBody("");
          } catch (e) {
            setResult(e instanceof Error ? e.message : "Could not send.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <h3 className="font-ui text-[12.5px] font-semibold text-slate-ink">Announcement</h3>
        <p className="font-ui text-[11.5px] text-slate-muted">Lands in every chosen bell, and pops up for anyone online.</p>
        <label className="mt-3 block font-ui text-[11px] text-slate-muted">
          Title
          <input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className={field} placeholder="Mega auction this Friday" />
        </label>
        <label className="mt-3 block font-ui text-[11px] text-slate-muted">
          Message
          <textarea maxLength={600} rows={3} value={body} onChange={(e) => setBody(e.target.value)} className={field} placeholder="Every franchise seat opens at 8 pm." />
        </label>
        <fieldset className="mt-3 flex flex-wrap gap-2">
          <legend className="mb-1 font-ui text-[11px] text-slate-muted">To (none chosen: everyone)</legend>
          {(
            [
              ["auctioneer", "Auctioneers"],
              ["delegate", "Delegates"],
              ["member", "Free"],
            ] as const
          ).map(([role, label]) => {
            const on = roles.has(role);
            return (
              <button
                key={role}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setRoles((prev) => {
                    const next = new Set(prev);
                    if (on) next.delete(role);
                    else next.add(role);
                    return next;
                  })
                }
                className={`rounded-md border px-2.5 py-1 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] ${
                  on ? "border-slate-ink bg-slate-ink text-white" : "border-line text-slate-body"
                }`}
              >
                {label}
              </button>
            );
          })}
        </fieldset>
        <div className="mt-4 flex items-center gap-3">
          <button type="submit" disabled={busy || !title.trim()} className={PRIMARY}>
            {busy ? "Sending…" : "Send announcement"}
          </button>
          {result && <span className="font-ui text-[12px] text-slate-muted">{result}</span>}
        </div>
      </form>
    </motion.section>
  );
}
