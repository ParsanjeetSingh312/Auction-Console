/**
 * Connections.tsx
 * The `/connections` route: find people, answer friend requests, and send
 * passes to the people you are connected with.
 *
 * At the top, the order passes travel in -- ADMIN > AUCTIONEER > DELEGATE >
 * FREE -- with this account's place marked, and a gold then a blue token
 * running down it (GSAP) to show which way each pass goes. The server
 * enforces that order (accounts/passes.py); the ladder only explains it.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Check, Search, Send, UserMinus, UserPlus, X } from "lucide-react";

import AuctiqNav from "../components/Global/AuctiqNav";
import StadiumBackdrop from "../components/Sections/StadiumBackdrop";
import AuctionPass from "../components/Passes/AuctionPass";
import { useAccount } from "../console/accountStore";
import type { Account } from "../console/accountStore";
import { openSendPasses, useEcosystem } from "../console/ecosystemStore";
import {
  removeConnection,
  requestConnection,
  respondConnection,
  searchPeople,
  tierLabel,
  toneOf,
  useConnections,
} from "../console/connectionsApi";
import type { Connection, Person, SearchHit } from "../console/connectionsApi";

gsap.registerPlugin(useGSAP);

const PANEL = "rounded-[14px] border border-white/10 bg-[#0a0f1f]/80 p-5 backdrop-blur-md sm:p-6";
const H2 = "font-tech text-[12px] font-semibold uppercase tracking-[0.18em] text-auctiq-dim";

export default function Connections() {
  const { status, account } = useAccount();

  useEffect(() => {
    document.title = "AUCTONIQ · Connections";
  }, []);

  return (
    <div className="auctiq relative min-h-screen overflow-x-clip bg-auctiq-void text-auctiq-text">
      <StadiumBackdrop variant="console" />
      <div className="auctiq-stadium" aria-hidden />
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0 bg-[radial-gradient(90vw_70vh_at_0%_0%,rgba(3,7,18,0.82),transparent_70%),linear-gradient(180deg,rgba(2,6,23,0.55),rgba(2,6,23,0.92))]" />
      {/* Content scrolls under the nav; this band keeps the nav legible over it. */}
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-20 h-[136px] bg-gradient-to-b from-[#020617] via-[#020617]/95 to-transparent sm:h-[84px]" />
      <AuctiqNav />

      <main className="relative z-10 mx-auto w-full max-w-[1100px] px-4 pb-24 pt-[150px] sm:px-8 sm:pt-[110px]">
        <motion.header initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <h1 className="font-auctiq text-[34px] leading-none tracking-[0.03em] sm:text-[44px]">Connections</h1>
          <p className="mt-3 max-w-[620px] font-ui text-[14px] leading-relaxed text-auctiq-dim">
            Connect with the people you auction with. Passes travel down the order, to connections only:
            administrators to anyone, Auctioneers to their Delegates and Free players.
          </p>
        </motion.header>

        {status === "loading" ? null : !account ? (
          <div className={`${PANEL} mt-8`}>
            <p className="font-ui text-[14px] text-auctiq-dim">
              <Link to="/login?next=/connections" className="text-neon-cyan hover:underline">
                Log in
              </Link>{" "}
              to see your connections.
            </p>
          </div>
        ) : (
          <Signed account={account} />
        )}
      </main>
    </div>
  );
}

function Signed({ account }: { account: Account }) {
  const { balances, capabilities } = useEcosystem();
  const { ready, data } = useConnections();
  const canSend = (capabilities?.send.length ?? 0) > 0;
  const allowed = new Set(capabilities?.send_to_roles ?? []);
  const sendable = (p: Person) => canSend && (account.admin || (!p.admin && allowed.has(p.role)));

  return (
    <>
      <Ladder account={account} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.25fr_1fr]">
        <div className="flex flex-col gap-6">
          <Finder />

          <AnimatePresence initial={false}>
            {data.incoming.length > 0 && (
              <motion.section
                key="incoming"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className={`${PANEL} overflow-hidden border-[#C084FC]/30`}
              >
                <h2 className={H2}>
                  Requests for you <span className="ml-1 text-[#C084FC]">{data.incoming.length}</span>
                </h2>
                <ul className="mt-3 flex flex-col gap-2">
                  <AnimatePresence initial={false}>
                    {data.incoming.map((p) => (
                      <PersonRow key={p.connection_id} person={p}>
                        <IconButton label="Accept" tone="#34D399" onClick={() => respondConnection(p.connection_id, true)}>
                          <Check size={15} />
                        </IconButton>
                        <IconButton label="Decline" tone="#94A3B8" onClick={() => respondConnection(p.connection_id, false)}>
                          <X size={15} />
                        </IconButton>
                      </PersonRow>
                    ))}
                  </AnimatePresence>
                </ul>
              </motion.section>
            )}
          </AnimatePresence>

          <section className={PANEL}>
            <div className="flex items-center justify-between gap-3">
              <h2 className={H2}>
                Your connections <span className="ml-1 text-auctiq-text">{data.friends.length}</span>
              </h2>
              {canSend && data.friends.some(sendable) && (
                <button
                  type="button"
                  onClick={() => openSendPasses()}
                  className="flex items-center gap-1.5 rounded-[7px] border border-white/15 px-3 py-1.5 font-tech text-[11px] font-semibold uppercase tracking-[0.14em] hover:border-white/40"
                >
                  <Send size={13} /> Send passes
                </button>
              )}
            </div>
            {!ready ? (
              <p className="mt-4 font-ui text-[13px] text-auctiq-dim">Loading…</p>
            ) : data.friends.length === 0 ? (
              <p className="mt-4 font-ui text-[13px] leading-relaxed text-auctiq-dim">
                No connections yet. Find people above and send them a request.
              </p>
            ) : (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                <AnimatePresence initial={false}>
                  {data.friends.map((p) => (
                    <PersonRow key={p.id} person={p} card>
                      {sendable(p) && (
                        <IconButton
                          label={`Send ${p.name} a pass`}
                          tone={capabilities?.send.includes("D") ? "#4D8DF6" : "#F6C45A"}
                          onClick={() => openSendPasses({ recipientIds: [p.id] })}
                        >
                          <Send size={14} />
                        </IconButton>
                      )}
                      <IconButton label={`Remove ${p.name}`} tone="#94A3B8" onClick={() => removeConnection(p.id)}>
                        <UserMinus size={14} />
                      </IconButton>
                    </PersonRow>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </section>

          {data.outgoing.length > 0 && (
            <section className={PANEL}>
              <h2 className={H2}>Waiting for an answer</h2>
              <ul className="mt-3 flex flex-col gap-2">
                <AnimatePresence initial={false}>
                  {data.outgoing.map((p) => (
                    <PersonRow key={p.connection_id} person={p} faded>
                      <IconButton label={`Withdraw request to ${p.name}`} tone="#94A3B8" onClick={() => removeConnection(p.id)}>
                        <X size={14} />
                      </IconButton>
                    </PersonRow>
                  ))}
                </AnimatePresence>
              </ul>
            </section>
          )}
        </div>

        {/* The wallet, beside the people it can go to. */}
        <aside className={`${PANEL} h-fit lg:sticky lg:top-[100px]`}>
          <h2 className={H2}>Your wallet</h2>
          <div className="mt-4 flex flex-col items-center gap-5">
            <AuctionPass kind="A" size="md" count={balances.A} />
            <AuctionPass kind="D" size="md" count={balances.D} />
          </div>
          <p className="mt-5 font-ui text-[12.5px] leading-relaxed text-auctiq-dim">
            {account.admin
              ? "As an administrator you generate and send both kinds without limit."
              : account.role === "auctioneer"
                ? "Gold passes come from administrators, in your notifications. Generate Delegate passes for your players from Send passes."
                : account.role === "delegate"
                  ? "A blue pass takes a franchise seat or opens a delegate room. More come from your Auctioneer."
                  : "A blue pass takes a franchise seat in an Auctioneer's room. Your Auctioneer sends them."}
          </p>
          {canSend && (
            <button
              type="button"
              onClick={() => openSendPasses()}
              className="mt-4 w-full rounded-[8px] py-2.5 font-tech text-[12px] font-bold uppercase tracking-[0.16em] text-[#020617]"
              style={{ background: "linear-gradient(180deg,#cfe2ff,#4d8df6)" }}
            >
              Send passes
            </button>
          )}
        </aside>
      </div>
    </>
  );
}

/* ------------------------------------------------------------ the ladder -- */

const RUNGS = [
  { key: "admin", label: "Admin", tone: "#E8C547", note: "A + D, unlimited" },
  { key: "auctioneer", label: "Auctioneer", tone: "#FB923C", note: "Makes D passes" },
  { key: "delegate", label: "Delegate", tone: "#22D3EE", note: "Receives D" },
  { key: "member", label: "Free", tone: "#94A3B8", note: "Receives D" },
] as const;

function Ladder({ account }: { account: Account }) {
  const root = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const mine = account.admin ? "admin" : account.role;

  useGSAP(
    () => {
      gsap.from(".rung", { y: 14, autoAlpha: 0, stagger: 0.08, duration: 0.5, ease: "power3.out" });
      gsap.from(".rung-link", { scaleX: 0, transformOrigin: "left center", stagger: 0.08, duration: 0.5, ease: "power2.out", delay: 0.2 });
      if (reduce) return;
      // A gold token runs Admin -> Auctioneer, then a blue one runs on down.
      const track = root.current!.querySelector<HTMLElement>(".rung-track")!;
      const width = track.getBoundingClientRect().width;
      gsap
        .timeline({ repeat: -1, repeatDelay: 1.2, delay: 0.9 })
        .fromTo(".token-a", { x: 0, autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 })
        .to(".token-a", { x: width / 3, duration: 1, ease: "power2.inOut" })
        .to(".token-a", { autoAlpha: 0, scale: 0.4, duration: 0.25 })
        .fromTo(".token-d", { x: width / 3, autoAlpha: 0, scale: 0.4 }, { autoAlpha: 1, scale: 1, duration: 0.25 }, "<")
        .to(".token-d", { x: width, duration: 1.4, ease: "power2.inOut" })
        .to(".token-d", { autoAlpha: 0, duration: 0.25 });
    },
    { scope: root, dependencies: [mine] },
  );

  return (
    <div ref={root} className={`${PANEL} mt-8`}>
      <div className="flex items-center justify-between">
        <h2 className={H2}>The order passes travel</h2>
        <span className="hidden font-ui text-[11.5px] text-auctiq-dim sm:inline">Passes go down, never up or sideways</span>
      </div>
      <div className="relative mt-5 sm:px-[6%]">
        <div className="rung-track absolute left-[12.5%] right-[12.5%] top-[19px] h-[2px]">
          {[0, 1, 2].map((i) => (
            <span key={i} className="rung-link absolute top-0 h-full bg-white/15" style={{ left: `${(i * 100) / 3}%`, width: `${100 / 3}%` }} />
          ))}
          <span className="token-a absolute -left-[9px] -top-[6px] h-[14px] w-[18px] rounded-[3px] opacity-0 shadow-[0_0_14px_#F6C45A]" style={{ background: "linear-gradient(128deg,#8c6212,#ffe08a,#b8860b)" }} />
          <span className="token-d absolute -left-[9px] -top-[6px] h-[14px] w-[18px] rounded-[3px] opacity-0 shadow-[0_0_14px_#4D8DF6]" style={{ background: "linear-gradient(128deg,#0a2e78,#9cc2ff,#1d4fbf)" }} />
        </div>
        <ol className="relative grid grid-cols-4">
          {RUNGS.map((r) => {
            const here = r.key === mine;
            return (
              <li key={r.key} className="rung flex flex-col items-center text-center">
                <span
                  className="grid h-10 w-10 place-items-center rounded-full bg-[#0a0f1f] font-auctiq text-[14px]"
                  style={{
                    color: r.tone,
                    boxShadow: here ? `0 0 0 2px ${r.tone}, 0 0 22px -2px ${r.tone}` : `inset 0 0 0 1.5px ${r.tone}88`,
                  }}
                >
                  {r.label[0]}
                </span>
                <span className="mt-2 font-tech text-[8.5px] font-semibold uppercase tracking-[0.02em] sm:text-[11.5px] sm:tracking-[0.14em]" style={{ color: r.tone }}>
                  {r.label}
                </span>
                <span className="mt-0.5 hidden font-ui text-[11px] text-auctiq-dim sm:block">{r.note}</span>
                {here && (
                  <span className="mt-1.5 rounded-full px-2 py-0.5 font-tech text-[9.5px] font-bold uppercase tracking-[0.16em] text-[#020617]" style={{ background: r.tone }}>
                    You
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- finding -- */

function Finder() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        setHits(await searchPeople(q));
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  const ask = async (hit: SearchHit) => {
    setError(null);
    try {
      const status = await requestConnection(hit.id);
      setHits((prev) => prev.map((h) => (h.id === hit.id ? { ...h, link: status === "accepted" ? "friends" : "outgoing" } : h)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the request.");
    }
  };

  return (
    <section className={PANEL}>
      <h2 className={H2}>Find people</h2>
      <div className="relative mt-3">
        <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-auctiq-dim" />
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="A name, or their exact email"
          className="h-11 w-full rounded-[10px] border border-white/15 bg-white/[0.03] pl-10 pr-3 font-ui text-[14px] text-auctiq-text outline-none placeholder:text-auctiq-dim/60 focus:border-neon-cyan/60"
        />
      </div>
      {error && <p className="mt-2 font-ui text-[12px] text-auctiq-out">{error}</p>}
      <ul className="mt-2 flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {hits.map((hit) => (
            <PersonRow key={hit.id} person={hit}>
              {hit.link === "friends" ? (
                <span className="font-tech text-[10.5px] uppercase tracking-[0.14em] text-auctiq-win">Connected</span>
              ) : hit.link === "outgoing" ? (
                <span className="font-tech text-[10.5px] uppercase tracking-[0.14em] text-auctiq-dim">Requested</span>
              ) : (
                <button
                  type="button"
                  onClick={() => ask(hit)}
                  className="flex items-center gap-1.5 rounded-[7px] border border-neon-cyan/60 px-3 py-1.5 font-tech text-[11px] font-semibold uppercase tracking-[0.14em] text-neon-cyan hover:bg-neon-cyan/10"
                >
                  <UserPlus size={13} /> {hit.link === "incoming" ? "Accept" : "Connect"}
                </button>
              )}
            </PersonRow>
          ))}
        </AnimatePresence>
      </ul>
      {q.trim().length >= 2 && !searching && hits.length === 0 && (
        <p className="mt-3 font-ui text-[12.5px] text-auctiq-dim">No one by that name. Try their exact email.</p>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- pieces -- */

function PersonRow({
  person,
  children,
  card = false,
  faded = false,
}: {
  person: Person | Connection;
  children?: React.ReactNode;
  card?: boolean;
  faded?: boolean;
}) {
  const tone = toneOf(person);
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: faded ? 0.7 : 1, y: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.2 } }}
      className={`flex items-center gap-3 rounded-[10px] px-3 py-2.5 ${card ? "border border-white/[0.08] bg-white/[0.02]" : "bg-white/[0.02]"}`}
    >
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/[0.06] font-ui text-[13px] font-semibold"
        style={{ boxShadow: `inset 0 0 0 1.5px ${tone}` }}
      >
        {(person.name.trim()[0] ?? "?").toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-ui text-[13.5px]">{person.name}</span>
        <span className="font-tech text-[10px] uppercase tracking-[0.14em]" style={{ color: tone }}>
          {tierLabel(person)}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">{children}</span>
    </motion.li>
  );
}

function IconButton({
  label,
  tone,
  onClick,
  children,
}: {
  label: string;
  tone: string;
  onClick: () => unknown;
  children: React.ReactNode;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.92 }}
      onClick={() => void onClick()}
      className="grid h-8 w-8 place-items-center rounded-full border"
      style={{ color: tone, borderColor: `${tone}66`, background: `${tone}14` }}
    >
      {children}
    </motion.button>
  );
}
