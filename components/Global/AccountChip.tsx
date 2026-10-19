/**
 * AccountChip.tsx
 * The account's place in the header.
 *
 * Signed out: "Log in". Signed in: the account as one compact control -- an
 * initial in a circle, the name, and after it the account type (Auctioneer,
 * Delegate, Member, or Admin), with a chevron that opens a small menu: the
 * account page, Live Bidding, and log out.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { logOut, useAccount } from "../../console/accountStore";
import { openSendPasses, useEcosystem } from "../../console/ecosystemStore";
import AuctionPass from "../Passes/AuctionPass";
import type { Account } from "../../console/accountStore";

const TYPE_LABEL: Record<Account["role"], string> = {
  auctioneer: "Auctioneer",
  delegate: "Delegate",
  member: "Member",
};

function typeOf(account: Account): string {
  return account.admin ? "Admin" : TYPE_LABEL[account.role];
}

/** The account type's colour, shared by the type label and the avatar ring. */
function toneOf(account: Account): string {
  if (account.admin) return "#E8C547";
  if (account.role === "auctioneer") return "var(--color-neon-orange, #fb923c)";
  if (account.role === "delegate") return "var(--color-neon-cyan, #22d3ee)";
  return "rgba(226, 232, 240, 0.7)";
}

export default function AccountChip() {
  const { status, account } = useAccount();
  const { balances, capabilities } = useEcosystem();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Close on a click elsewhere, and on Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (status === "loading") return null;

  if (!account) {
    return (
      <Link
        to="/login"
        data-testid="nav-log-in"
        className="flex min-h-[38px] items-center whitespace-nowrap rounded-[6px] border border-white/20 bg-auctiq-void/70 px-3 font-tech text-[11px] font-semibold uppercase tracking-[0.14em] text-auctiq-text backdrop-blur-sm transition-colors duration-200 hover:border-white/40"
      >
        Log in
      </Link>
    );
  }

  const tone = toneOf(account);
  const initial = (account.name.trim()[0] ?? account.email[0] ?? "?").toUpperCase();
  const item =
    "block w-full px-3.5 py-2 text-left font-ui text-[12.5px] text-auctiq-text transition-colors hover:bg-white/[0.06]";

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-testid="nav-account"
        aria-haspopup="menu"
        aria-expanded={open}
        title={account.email}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[38px] max-w-[240px] items-center gap-2 rounded-[8px] border border-white/15 bg-auctiq-void/70 py-1 pl-1.5 pr-2 backdrop-blur-sm transition-colors duration-200 hover:border-white/30"
      >
        <span
          aria-hidden
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/10 font-ui text-[12px] font-semibold text-auctiq-text"
          style={{ boxShadow: `inset 0 0 0 1.5px ${tone}` }}
        >
          {initial}
        </span>
        <span className="min-w-0 truncate font-ui text-[13px] font-medium text-auctiq-text">
          {account.name}
          <span className="font-normal" style={{ color: tone }}>
            {" "}
            · {typeOf(account)}
          </span>
        </span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className={`h-3 w-3 shrink-0 text-auctiq-dim transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-56 overflow-hidden rounded-[10px] border border-white/12 bg-[#0b1020]/95 py-1 shadow-2xl backdrop-blur-md"
        >
          <div className="border-b border-white/10 px-3.5 py-2.5">
            <div className="truncate font-ui text-[12.5px] font-medium text-auctiq-text">{account.name}</div>
            <div className="truncate font-ui text-[11px] text-auctiq-dim">{account.email}</div>
          </div>
          {/* The wallet, at a glance. */}
          <div className="flex items-center gap-3 border-b border-white/10 px-3.5 py-2.5">
            <AuctionPass kind="A" size="xs" count={balances.A} tilt={false} />
            <AuctionPass kind="D" size="xs" count={balances.D} tilt={false} />
            <span className="font-tech text-[10px] uppercase leading-tight tracking-[0.14em] text-auctiq-dim">
              Passes
            </span>
          </div>
          <Link role="menuitem" to="/account" className={item} onClick={() => setOpen(false)}>
            Account
          </Link>
          <Link role="menuitem" to="/auction/live" className={item} onClick={() => setOpen(false)}>
            Live Bidding
          </Link>
          <Link role="menuitem" to="/connections" className={item} onClick={() => setOpen(false)}>
            Connections
          </Link>
          {(capabilities?.send.length ?? 0) > 0 && (
            <button
              role="menuitem"
              type="button"
              className={item}
              onClick={() => {
                setOpen(false);
                openSendPasses();
              }}
            >
              Send passes
            </button>
          )}
          <button
            role="menuitem"
            type="button"
            className={`${item} border-t border-white/10`}
            onClick={async () => {
              setOpen(false);
              await logOut();
              navigate("/");
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
