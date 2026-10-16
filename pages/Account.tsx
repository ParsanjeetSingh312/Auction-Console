/**
 * Account.tsx
 * The `/account` route: who is signed in, wearing which tag.
 *
 * The tag -- AUCTIONEER, DELEGATE or MEMBER -- is what the account may do in
 * Live Bidding, and the server enforces it (console/accountStore.ts). Signed
 * out, this sends the visitor to log in and brings them back.
 */
import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";

import { ADMIN_BLURB, logOut, ROLE_BLURB, ROLE_TAG, useAccount } from "../console/accountStore";
import { cardVariants, gridVariants } from "../console/motion";
import StadiumBackdrop from "../components/Sections/StadiumBackdrop";
import { RoleTag } from "./Login";

import "../console/console.css";

const BUTTON =
  "rounded-lg border border-line bg-surface-card px-3.5 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink";
const PRIMARY =
  "rounded-lg bg-slate-ink px-4 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-white transition-opacity hover:opacity-90";

export default function Account() {
  const { status, account } = useAccount();
  const navigate = useNavigate();

  useEffect(() => {
    document.title = "AUCTONIQ · Account";
  }, []);

  useEffect(() => {
    if (status === "ready" && !account) navigate("/login?next=/account", { replace: true });
  }, [status, account, navigate]);

  const since = account ? new Date(account.created_at * 1000).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
  const next =
    account?.role === "auctioneer" || account?.admin
      ? { to: "/auction/live", label: "Create an auction room" }
      : account?.role === "delegate"
        ? { to: "/auction/live", label: "Join an auction room" }
        : { to: "/data", label: "Open the data room" };

  return (
    <div className="console-dark">
      <StadiumBackdrop variant="console" />
      <div className="min-h-screen bg-surface bg-dots px-5 py-10">
        <motion.div className="mx-auto w-full max-w-xl" variants={gridVariants} initial="initial" animate="animate">
          <motion.header className="mb-6 flex items-start justify-between gap-4" variants={cardVariants}>
            <div>
              <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
                AUCTONIQ account
              </span>
              <h1 className="mt-1 font-head text-[28px] font-bold leading-tight text-slate-ink">Your account</h1>
            </div>
            <Link to="/" className={BUTTON}>
              ← AUCTONIQ
            </Link>
          </motion.header>

          {account ? (
            <motion.section
              variants={cardVariants}
              className="rounded-xl border border-line bg-surface-card p-6 shadow-soft"
              aria-label="Account details"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-head text-[22px] font-bold leading-tight text-slate-ink">{account.name}</h2>
                  <p className="mt-1 truncate font-ui text-[12.5px] text-slate-muted">{account.email}</p>
                </div>
                {account.admin ? (
                  <span className="inline-flex items-center rounded-md border border-[#E8C547]/80 px-2.5 py-1 font-tech text-[12px] font-semibold uppercase tracking-[0.16em] text-[#E8C547]">
                    ADMIN
                  </span>
                ) : (
                  <RoleTag role={account.role} large />
                )}
              </div>

              <p className="mt-4 border-t border-line pt-4 font-ui text-[12.5px] leading-relaxed text-slate-body">
                {account.admin ? ADMIN_BLURB : ROLE_BLURB[account.role]}
              </p>
              {account.admin && (
                <p className="mt-1 font-ui text-[11px] text-slate-faint">
                  Registered as {ROLE_TAG[account.role]}.
                </p>
              )}
              <p className="mt-1.5 font-ui text-[11px] text-slate-faint">Member since {since}</p>

              <div className="mt-5 flex flex-wrap gap-2">
                <Link to={next.to} className={PRIMARY}>
                  {next.label} →
                </Link>
                <button
                  type="button"
                  onClick={async () => {
                    await logOut();
                    navigate("/login", { replace: true });
                  }}
                  className={BUTTON}
                >
                  Log out
                </button>
              </div>
            </motion.section>
          ) : (
            <motion.p variants={cardVariants} className="font-ui text-[12.5px] text-slate-muted">
              Loading your account…
            </motion.p>
          )}
        </motion.div>
      </div>
    </div>
  );
}
