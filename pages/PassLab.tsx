/**
 * PassLab.tsx
 * The design bench for the ecosystem's pieces: both passes at every size,
 * and buttons that fire each kind of popup without waiting on the server.
 * Not linked from anywhere, like the other labs.
 */
import { useState } from "react";

import AuctionPass from "../components/Passes/AuctionPass";
import { pushLocal } from "../console/ecosystemStore";
import type { Notice } from "../console/ecosystemStore";

let fake = -1;

function sample(kind: Notice["kind"]): Notice {
  const id = fake--;
  const now = Date.now() / 1000;
  const base = { id, kind, link: null, created_at: now, read: false, gift: null };
  switch (kind) {
    case "welcome":
      return {
        ...base,
        title: "Welcome to AUCTONIQ",
        body: "Here is 1 Auctioneer pass to open your first auction room.",
        gift: { id, kind: "A", quantity: 1, status: "pending", note: null, expires_at: now + 14 * 86400, sender: "AUCTONIQ" },
      };
    case "gift":
      return {
        ...base,
        title: "Demo Auctioneer One sent you 2 Delegate passes",
        body: "See you in room FRIDAY",
        gift: { id, kind: "D", quantity: 2, status: "pending", note: "See you in room FRIDAY", expires_at: now + 14 * 86400, sender: "Demo Auctioneer One" },
      };
    case "reminder":
      return { ...base, title: "Your auction starts in 10 minutes", body: "Room FRIDAY · Mega auction" };
    case "connection":
      return { ...base, title: "Demo Delegate 4 wants to connect", body: "A delegate account sent you a friend request.", link: "/connections" };
    default:
      return { ...base, title: "Mega auction this Friday", body: "Every franchise seat opens at 8 pm." };
  }
}

export default function PassLab() {
  const [round, setRound] = useState(0);
  const button =
    "rounded-[6px] border border-white/15 bg-white/[0.04] px-3 py-2 font-tech text-[11px] uppercase tracking-[0.14em] text-auctiq-text transition-colors hover:border-white/40";

  return (
    <main className="auctiq min-h-screen bg-auctiq-void px-6 pb-24 pt-10 text-auctiq-text sm:px-12">
      <h1 className="font-auctiq text-[28px] tracking-[0.06em]">Auction passes</h1>
      <p className="mt-1 font-tech text-[12px] uppercase tracking-[0.14em] text-auctiq-dim">
        Gold A · Auctioneer &nbsp;|&nbsp; Blue D · Delegate
      </p>

      <section key={round} className="mt-10 flex flex-wrap items-center gap-12">
        <AuctionPass kind="A" size="lg" intro count={3} serial="A-0001-GOLD" />
        <AuctionPass kind="D" size="lg" intro count={12} serial="D-0042-BLUE" />
      </section>

      <section className="mt-12 flex flex-wrap items-end gap-8">
        <AuctionPass kind="A" size="md" count={1} />
        <AuctionPass kind="D" size="md" count={0} />
        <AuctionPass kind="A" size="sm" count={5} />
        <AuctionPass kind="D" size="sm" />
        <AuctionPass kind="A" size="xs" count={2} />
        <AuctionPass kind="D" size="xs" count={9} />
      </section>

      <section className="mt-12 flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => setRound((r) => r + 1)}>
          Replay intro
        </button>
        {(["welcome", "gift", "reminder", "connection", "announcement"] as const).map((kind) => (
          <button key={kind} type="button" className={button} onClick={() => pushLocal(sample(kind))}>
            Pop {kind}
          </button>
        ))}
      </section>
    </main>
  );
}
