/**
 * SendPassesDialog.tsx
 * Send passes to connections: choose the pass, tick the people, pick how
 * many each, add a note (the room code, say), send.
 *
 * Mounted once, in App, and opened from anywhere with openSendPasses() --
 * the account menu, a connection's card, the room code in an auctioneer's
 * control bar. Only the passes this account may send are offered
 * (capabilities from the server); only connections it may send them to are
 * listed. Administrators can also look up any account by name or email.
 *
 * Generating is here too, for those who may: an Auctioneer's Delegate passes
 * (within the daily cap) and an administrator's either kind. A send that
 * needs more than the wallet holds generates the difference first, when the
 * account is allowed to.
 *
 * Framer Motion opens and closes the dialog and settles the list; GSAP deals
 * the passes, one chip flying from the chosen card into each recipient's row.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Check, Minus, Plus, Search, X } from "lucide-react";

import { useAccount } from "../../console/accountStore";
import {
  closeSendPasses,
  generate,
  sendPasses,
  useEcosystem,
  useSendIntent,
} from "../../console/ecosystemStore";
import type { PassKind, SendIntent } from "../../console/ecosystemStore";
import { searchPeople, tierLabel, toneOf, useConnections } from "../../console/connectionsApi";
import type { Person } from "../../console/connectionsApi";
import AuctionPass from "../Passes/AuctionPass";

gsap.registerPlugin(useGSAP);

export default function SendPassesDialog() {
  const intent = useSendIntent();
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {intent && (
        <motion.div
          key="send-passes"
          className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-[#020617]/80 px-3 py-6 backdrop-blur-sm sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onPointerDown={(event) => event.target === event.currentTarget && closeSendPasses()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Send passes"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 360, damping: 30 }}
            className="auctiq relative w-full max-w-[560px] rounded-[14px] border border-white/12 bg-[#0a0f1f]/97 text-auctiq-text shadow-[0_30px_80px_-20px_rgba(0,0,0,0.85)]"
          >
            <Body intent={intent} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Body({ intent }: { intent: SendIntent }) {
  const { account } = useAccount();
  const { balances, capabilities } = useEcosystem();
  const { data } = useConnections();
  const root = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLDivElement>(null);

  const kinds = capabilities?.send ?? [];
  const [kind, setKind] = useState<PassKind>(kinds.includes("D") ? "D" : (kinds[0] ?? "D"));
  const [selected, setSelected] = useState<Set<number>>(() => new Set(intent.recipientIds ?? []));
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState(intent.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [extra, setExtra] = useState<Person[]>([]);
  const [genAmount, setGenAmount] = useState(5);

  useEffect(() => {
    if (kinds.length && !kinds.includes(kind)) setKind(kinds[0]);
  }, [kinds, kind]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && closeSendPasses();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const allowed = new Set(capabilities?.send_to_roles ?? []);
  const people = useMemo(() => {
    const byId = new Map<number, Person>();
    for (const p of [...data.friends, ...extra]) {
      if (p.id === account?.id) continue;
      // An auctioneer sends to Delegates and Free accounts; an admin to anyone.
      if (!account?.admin && (p.admin || !allowed.has(p.role))) continue;
      byId.set(p.id, p);
    }
    return [...byId.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.friends, extra, account?.id, account?.admin, capabilities]);

  const chosen = people.filter((p) => selected.has(p.id));
  const needed = quantity * chosen.length;
  const have = balances[kind];
  const canGenerate = capabilities?.generate.includes(kind) ?? false;
  const short = Math.max(0, needed - have);

  const { contextSafe } = useGSAP({ scope: root });

  /** One chip per recipient, dealt from the chosen card into their row. */
  const deal = contextSafe((ids: number[]) => {
    const from = source.current?.getBoundingClientRect();
    if (!from) return;
    const layer = document.createElement("div");
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:95";
    document.body.appendChild(layer);
    const timeline = gsap.timeline({ onComplete: () => layer.remove() });
    ids.forEach((id, i) => {
      const row = root.current?.querySelector(`[data-recipient="${id}"] .deal-target`);
      if (!row) return;
      const to = row.getBoundingClientRect();
      const chip = document.createElement("div");
      chip.style.cssText = `position:absolute;left:${from.left + from.width / 2 - 22}px;top:${from.top + from.height / 2 - 14}px;width:44px;height:28px;border-radius:5px;background:${
        kind === "A"
          ? "linear-gradient(128deg,#8c6212,#ffe08a 48%,#b8860b)"
          : "linear-gradient(128deg,#0a2e78,#9cc2ff 48%,#1d4fbf)"
      };box-shadow:0 0 16px ${kind === "A" ? "rgba(246,196,90,.8)" : "rgba(77,141,246,.8)"}`;
      layer.appendChild(chip);
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      timeline
        .to(chip, { x: dx, duration: 0.6, ease: "power2.inOut" }, i * 0.09)
        .to(chip, { y: dy, rotation: gsap.utils.random(-25, 25), duration: 0.6, ease: "back.in(1.2)" }, i * 0.09)
        .to(chip, { scale: 0.2, autoAlpha: 0, duration: 0.18 }, i * 0.09 + 0.55)
        .fromTo(row, { scale: 0.4, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.35, ease: "back.out(3)" }, i * 0.09 + 0.6);
    });
  });

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendPasses({
        recipient_ids: chosen.map((p) => p.id),
        kind,
        quantity,
        note: note.trim() || undefined,
        generate_missing: canGenerate,
      });
      setSent(needed);
      deal(chosen.map((p) => p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send.");
    } finally {
      setBusy(false);
    }
  };

  if (!account || !capabilities) {
    return <p className="p-6 font-ui text-[13px] text-auctiq-dim">Loading your wallet…</p>;
  }

  if (!kinds.length) {
    return (
      <div className="p-6">
        <Head />
        <p className="mt-4 font-ui text-[13px] leading-relaxed text-auctiq-dim">
          Passes are sent by Auctioneers and administrators. Your account receives them: ask your Auctioneer
          to send you one.
        </p>
      </div>
    );
  }

  return (
    <div ref={root} className="p-5 sm:p-6">
      <Head />

      {/* Which pass. */}
      <div className="mt-5 flex flex-wrap items-center gap-4">
        {(["A", "D"] as PassKind[]).map((k) => {
          const enabled = kinds.includes(k);
          const active = k === kind;
          return (
            <motion.button
              key={k}
              type="button"
              disabled={!enabled}
              onClick={() => setKind(k)}
              whileHover={enabled ? { y: -3 } : undefined}
              animate={{ opacity: enabled ? (active ? 1 : 0.55) : 0.22, scale: active ? 1 : 0.94 }}
              className="relative rounded-[12px] p-1 outline-none disabled:cursor-not-allowed"
              style={{
                boxShadow: active
                  ? `0 0 0 2px ${k === "A" ? "#F6C45A" : "#4D8DF6"}, 0 0 30px -6px ${k === "A" ? "#F6C45A" : "#4D8DF6"}`
                  : "none",
              }}
              aria-pressed={active}
              title={enabled ? undefined : "Only an administrator can send Auctioneer passes"}
            >
              <div ref={active ? source : undefined}>
                <AuctionPass kind={k} size="sm" count={balances[k]} tilt={false} greyWhenEmpty={false} />
              </div>
            </motion.button>
          );
        })}
        <div className="min-w-[170px] flex-1 font-ui text-[12px] leading-relaxed text-auctiq-dim">
          {kind === "A" ? "Opens one auctioneer room." : "One franchise seat, or one delegate room."}
          <br />
          You hold <span className="text-auctiq-text">{have}</span>
          {capabilities.unlimited ? " · unlimited" : ""}.
        </div>
      </div>

      {/* Who to. */}
      <section className="mt-5">
        <div className="flex items-baseline justify-between">
          <h3 className="font-tech text-[11px] font-semibold uppercase tracking-[0.16em] text-auctiq-dim">
            Send to · {chosen.length} chosen
          </h3>
          {people.length > 1 && (
            <button
              type="button"
              className="font-tech text-[10.5px] uppercase tracking-[0.12em] text-neon-cyan"
              onClick={() =>
                setSelected(chosen.length === people.length ? new Set() : new Set(people.map((p) => p.id)))
              }
            >
              {chosen.length === people.length ? "Clear" : "Select all"}
            </button>
          )}
        </div>
        {account.admin && <AdminLookup onAdd={(p) => {
          setExtra((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
          setSelected((prev) => new Set(prev).add(p.id));
        }} />}
        <motion.ul layout className="mt-2 max-h-[240px] overflow-y-auto rounded-[10px] border border-white/10">
          {people.length === 0 && (
            <li className="px-4 py-6 text-center font-ui text-[12.5px] text-auctiq-dim">
              No one to send to yet.{" "}
              <Link to="/connections" onClick={closeSendPasses} className="text-neon-cyan underline-offset-2 hover:underline">
                Connect with Delegates and Free accounts
              </Link>{" "}
              first.
            </li>
          )}
          {people.map((p) => {
            const on = selected.has(p.id);
            const tone = toneOf(p);
            return (
              <motion.li layout key={p.id} data-recipient={p.id} className="border-b border-white/[0.06] last:border-b-0">
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-white/[0.04]">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.id)) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      })
                    }
                    className="sr-only"
                  />
                  <span
                    className="grid h-5 w-5 place-items-center rounded-[5px] border transition-colors"
                    style={{ borderColor: on ? tone : "rgba(255,255,255,.25)", background: on ? `${tone}33` : "transparent" }}
                  >
                    {on && <Check size={13} color={tone} strokeWidth={3} />}
                  </span>
                  <span
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/[0.06] font-ui text-[12.5px] font-semibold"
                    style={{ boxShadow: `inset 0 0 0 1.5px ${tone}` }}
                  >
                    {(p.name.trim()[0] ?? "?").toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-ui text-[13px]">{p.name}</span>
                  <span className="font-tech text-[10px] uppercase tracking-[0.14em]" style={{ color: tone }}>
                    {tierLabel(p)}
                  </span>
                  <span
                    className="deal-target grid h-6 w-6 place-items-center rounded-full opacity-0"
                    style={{ background: kind === "A" ? "#F6C45A" : "#4D8DF6" }}
                    aria-hidden
                  >
                    <Check size={13} color="#020617" strokeWidth={3} />
                  </span>
                </label>
              </motion.li>
            );
          })}
        </motion.ul>
      </section>

      {/* How many, and a note. */}
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div>
          <div className="font-tech text-[11px] font-semibold uppercase tracking-[0.16em] text-auctiq-dim">Each</div>
          <div className="mt-1.5 flex items-center rounded-[8px] border border-white/15">
            <button type="button" aria-label="Fewer" className="grid h-9 w-9 place-items-center text-auctiq-dim hover:text-auctiq-text" onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
              <Minus size={14} />
            </button>
            <span className="w-8 text-center font-num text-[18px] font-bold">{quantity}</span>
            <button type="button" aria-label="More" className="grid h-9 w-9 place-items-center text-auctiq-dim hover:text-auctiq-text" onClick={() => setQuantity((q) => Math.min(20, q + 1))}>
              <Plus size={14} />
            </button>
          </div>
        </div>
        <label className="min-w-[180px] flex-1">
          <span className="font-tech text-[11px] font-semibold uppercase tracking-[0.16em] text-auctiq-dim">Note</span>
          <input
            value={note}
            maxLength={200}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Room code, auction time…"
            className="mt-1.5 h-9 w-full rounded-[8px] border border-white/15 bg-white/[0.03] px-3 font-ui text-[13px] text-auctiq-text outline-none placeholder:text-auctiq-dim/60 focus:border-neon-cyan/60"
          />
        </label>
      </div>

      {/* Generate, for those who may. */}
      {canGenerate && !capabilities.unlimited && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[10px] border border-white/10 bg-white/[0.02] px-3 py-2.5">
          <span className="font-ui text-[12px] text-auctiq-dim">
            Generate Delegate passes · up to {capabilities.generate_cap} a day
          </span>
          <input
            type="number"
            min={1}
            max={capabilities.generate_cap ?? 50}
            value={genAmount}
            onChange={(event) => setGenAmount(Math.max(1, Number(event.target.value) || 1))}
            className="ml-auto h-8 w-16 rounded-[6px] border border-white/15 bg-transparent px-2 text-center font-num text-[15px] font-bold text-auctiq-text outline-none"
          />
          <button
            type="button"
            onClick={async () => {
              setError(null);
              try {
                await generate(kind, genAmount);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not generate.");
              }
            }}
            className="h-8 rounded-[6px] border border-[#4D8DF6]/60 px-3 font-tech text-[11px] font-semibold uppercase tracking-[0.14em] text-[#93BBFF] hover:bg-[#4D8DF6]/15"
          >
            Generate
          </button>
        </div>
      )}

      {/* The sum, and send. */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
        <p className="font-ui text-[12.5px] text-auctiq-dim">
          {chosen.length === 0 ? (
            "Choose who to send to."
          ) : (
            <>
              <span className="text-auctiq-text">
                {needed} {kind === "A" ? "Auctioneer" : "Delegate"} pass{needed === 1 ? "" : "es"}
              </span>{" "}
              to {chosen.length} {chosen.length === 1 ? "person" : "people"}
              {short > 0 && (canGenerate ? ` · ${short} will be generated` : ` · you are ${short} short`)}
            </>
          )}
        </p>
        <AnimatePresence mode="wait" initial={false}>
          {sent !== null ? (
            <motion.div
              key="sent"
              initial={{ scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="flex items-center gap-2"
            >
              <span className="font-tech text-[12px] font-semibold uppercase tracking-[0.14em] text-auctiq-win">
                ✓ Sent {sent}
              </span>
              <button
                type="button"
                onClick={() => {
                  setSent(null);
                  setSelected(new Set());
                }}
                className="h-10 rounded-[8px] border border-white/15 px-4 font-tech text-[11px] uppercase tracking-[0.14em] text-auctiq-text hover:border-white/35"
              >
                Send more
              </button>
            </motion.div>
          ) : (
            <motion.button
              key="send"
              type="button"
              disabled={busy || chosen.length === 0 || (short > 0 && !canGenerate)}
              onClick={send}
              whileTap={{ scale: 0.96 }}
              className="h-10 rounded-[8px] px-5 font-tech text-[12px] font-bold uppercase tracking-[0.16em] text-[#020617] disabled:opacity-40"
              style={{
                background: kind === "A" ? "linear-gradient(180deg,#ffe7a3,#e3b23c)" : "linear-gradient(180deg,#cfe2ff,#4d8df6)",
              }}
            >
              {busy ? "Sending…" : "Send passes"}
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      {error && <p className="mt-2 font-ui text-[12px] text-auctiq-out">{error}</p>}
    </div>
  );
}

function Head() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="font-auctiq text-[20px] tracking-[0.04em]">Send passes</h2>
        <p className="mt-0.5 font-ui text-[12px] text-auctiq-dim">
          They arrive in each person's notifications, to claim within 14 days.
        </p>
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={closeSendPasses}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-auctiq-dim hover:bg-white/10 hover:text-auctiq-text"
      >
        <X size={16} />
      </button>
    </div>
  );
}

/** Administrators send to anyone: find them by name or email. */
function AdminLookup({ onAdd }: { onAdd: (person: Person) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Person[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        setHits(await searchPeople(q));
      } catch {
        setHits([]);
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [q]);
  return (
    <div className="relative mt-2">
      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-auctiq-dim" />
      <input
        value={q}
        onChange={(event) => setQ(event.target.value)}
        placeholder="Admin: find any account by name or email"
        className="h-9 w-full rounded-[8px] border border-white/15 bg-white/[0.03] pl-8 pr-3 font-ui text-[12.5px] text-auctiq-text outline-none placeholder:text-auctiq-dim/60 focus:border-[#E8C547]/60"
      />
      {hits.length > 0 && (
        <ul className="absolute inset-x-0 top-[calc(100%+4px)] z-10 overflow-hidden rounded-[8px] border border-white/12 bg-[#0b1020] shadow-xl">
          {hits.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => {
                  onAdd(p);
                  setQ("");
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-left font-ui text-[12.5px] hover:bg-white/[0.06]"
              >
                {p.name}
                <span className="font-tech text-[10px] uppercase tracking-[0.14em]" style={{ color: toneOf(p) }}>
                  {tierLabel(p)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
