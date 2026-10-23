/**
 * FranchiseManager.tsx
 * The auctioneer's franchise list, and the way to add sides of their own.
 *
 * Every room opens with the ten IPL franchises. Before the auction starts the
 * auctioneer may add as many fictional franchises as they like -- a name, a
 * two-to-four letter code and a colour -- and take any of those out again. The
 * ten stay. This replaced the two retired IPL names (Kochi, Pune) a mini room
 * used to hard-code as its eleventh and twelfth seats.
 *
 * Fire-and-forget like every socket intent: the room's next state frame is
 * the confirmation (the new side appears in the list), and a refusal -- a
 * taken name, a bad code -- arrives as the usual error toast.
 *
 * Motion: Framer Motion owns the panel and the list's layout (a removed side
 * closes its gap, a new one slides in); GSAP staggers the chips in when the
 * panel opens, which is a one-shot timeline rather than state.
 */
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { Plus, Shield, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AuctionSocket } from "../../../hooks/useAuctionSocket";

/** Offered first; any colour can still be typed. Kept clear of the ten IPL kits. */
const SWATCHES = ["#E07A1F", "#3B4BA0", "#0F9D8A", "#B03A9C", "#7A8B1F", "#C2185B", "#00838F", "#8D5524"];

/** "Goa Gladiators" -> "GG", "Shimla" -> "SHI": a starting suggestion only. */
function suggestCode(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z ]/g, "").split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 3).map((w) => w[0]).join("");
  return (words[0] ?? "").slice(0, 3);
}

export default function FranchiseManager({ socket }: { socket: AuctionSocket }) {
  const state = socket.state;
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [color, setColor] = useState(SWATCHES[0]);
  const listRef = useRef<HTMLUListElement>(null);

  const teams = state?.teams ?? [];
  const fictional = teams.filter((t) => t.fictional).length;
  const editable =
    socket.seat?.role === "auctioneer" &&
    (state?.phase === "lobby" || state?.phase === "waiting") &&
    (state?.supports?.includes("add_franchise") ?? false);

  // The next unused swatch, so adding several in a row gives distinct colours.
  useEffect(() => {
    const used = new Set(teams.map((t) => t.color.toUpperCase()));
    setColor(SWATCHES.find((s) => !used.has(s.toUpperCase())) ?? SWATCHES[fictional % SWATCHES.length]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams.length]);

  useEffect(() => {
    if (!open || reduce || !listRef.current) return;
    const ctx = gsap.context(() => {
      gsap.from("[data-chip]", { y: 8, autoAlpha: 0, duration: 0.28, stagger: 0.025, ease: "power2.out" });
    }, listRef);
    return () => ctx.revert();
  }, [open, reduce]);

  const codeValue = codeTouched ? code : suggestCode(name);
  const problem = useMemo(() => {
    const n = name.trim();
    if (!n) return null;
    if (n.length < 2 || n.length > 28) return "Name is 2–28 characters.";
    if (!/^[A-Z]{2,4}$/.test(codeValue)) return "Code is 2–4 letters.";
    if (teams.some((t) => t.name.toLowerCase() === n.toLowerCase())) return "That name is taken.";
    if (teams.some((t) => t.code === codeValue)) return `${codeValue} is taken.`;
    return null;
  }, [name, codeValue, teams]);

  if (!state || socket.seat?.role !== "auctioneer") return null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || problem) return;
    socket.addFranchise(name.trim(), codeValue, color);
    setName("");
    setCode("");
    setCodeTouched(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="franchise-manager"
        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-sunken px-2.5 py-1 font-ui text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-body transition-colors hover:text-slate-ink"
      >
        <Shield size={12} />
        Franchises · {teams.length}
        {fictional > 0 && <span className="text-slate-faint">({fictional} added)</span>}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.2, 0.7, 0.2, 1] }}
            className="absolute left-0 top-[calc(100%+8px)] z-40 w-[360px] max-w-[calc(100vw-32px)] rounded-xl border border-line bg-surface-card p-3.5 shadow-soft-lg"
            role="dialog"
            aria-label="Franchises in this room"
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="font-head text-[12px] font-bold tracking-[0.08em] text-slate-ink">
                FRANCHISES IN THIS ROOM
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-slate-faint hover:text-slate-ink"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            <ul ref={listRef} className="flex max-h-[220px] flex-wrap gap-1.5 overflow-y-auto pb-1">
              <AnimatePresence initial={false}>
                {teams.map((team) => (
                  <motion.li
                    key={team.id}
                    layout={!reduce}
                    data-chip
                    initial={reduce ? false : { opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    transition={{ type: "spring", stiffness: 520, damping: 34 }}
                    className="flex items-center gap-1.5 rounded-md border border-line bg-surface-sunken py-1 pl-1.5 pr-2"
                    title={team.name}
                  >
                    <span className="h-3 w-3 rounded-sm" style={{ background: team.color }} aria-hidden />
                    <span className="font-ui text-[10.5px] font-bold tracking-[0.06em] text-slate-ink">{team.code}</span>
                    <span className="max-w-[110px] truncate font-ui text-[10px] text-slate-muted">{team.name}</span>
                    {team.fictional && editable && (
                      <button
                        type="button"
                        onClick={() => socket.removeFranchise(team.id)}
                        disabled={team.connected}
                        className="ml-0.5 rounded text-slate-faint hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label={`Remove ${team.name}`}
                        title={team.connected ? "Being played — the seat must be empty first" : `Remove ${team.name}`}
                      >
                        <X size={11} />
                      </button>
                    )}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>

            {editable ? (
              <form onSubmit={submit} className="mt-3 border-t border-line pt-3">
                <div className="mb-2 font-ui text-[9.5px] font-semibold uppercase tracking-[0.12em] text-slate-faint">
                  Add a fictional franchise · no limit
                </div>
                <div className="flex gap-2">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Name, e.g. Goa Gladiators"
                    maxLength={28}
                    className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 py-1.5 font-ui text-[12px] text-slate-ink outline-none focus:border-slate-faint"
                    data-testid="franchise-name"
                  />
                  <input
                    value={codeValue}
                    onChange={(e) => {
                      setCodeTouched(true);
                      setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4));
                    }}
                    placeholder="CODE"
                    aria-label="Franchise code"
                    className="w-[62px] rounded-md border border-line bg-surface px-2 py-1.5 text-center font-ui text-[12px] font-bold tracking-[0.08em] text-slate-ink outline-none focus:border-slate-faint"
                    data-testid="franchise-code"
                  />
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  {SWATCHES.map((swatch) => (
                    <button
                      key={swatch}
                      type="button"
                      onClick={() => setColor(swatch)}
                      aria-label={`Colour ${swatch}`}
                      className="relative h-5 w-5 rounded-full"
                      style={{ background: swatch }}
                    >
                      {color === swatch && (
                        <motion.span
                          layoutId="franchise-swatch"
                          className="absolute -inset-[3px] rounded-full border-2 border-slate-ink"
                          transition={{ type: "spring", stiffness: 600, damping: 36 }}
                        />
                      )}
                    </button>
                  ))}
                  <label className="ml-1 flex items-center" title="Any colour">
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value.toUpperCase())}
                      className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
                      aria-label="Custom colour"
                    />
                  </label>
                  <motion.button
                    type="submit"
                    whileTap={reduce ? undefined : { scale: 0.96 }}
                    disabled={!name.trim() || !!problem}
                    className="ml-auto inline-flex items-center gap-1 rounded-md bg-slate-ink px-3 py-1.5 font-ui text-[10.5px] font-semibold uppercase tracking-[0.1em] text-white disabled:opacity-40"
                    data-testid="franchise-add"
                  >
                    <Plus size={12} /> Add
                  </motion.button>
                </div>
                <div className="mt-1.5 min-h-[14px] font-ui text-[10px] text-red-500">{problem}</div>
              </form>
            ) : (
              <p className="mt-2 font-ui text-[10.5px] text-slate-faint">
                Franchises are set before the auction starts.
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
