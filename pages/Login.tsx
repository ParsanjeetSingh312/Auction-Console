/**
 * Login.tsx
 * The `/login` route: log in, or create an account.
 *
 * Creating an account means choosing what it is for -- Auctioneer, Delegate or
 * Member -- because that is what the account may do in Live Bidding, and the
 * server holds every account to it (console/accountStore.ts). On success the
 * visitor goes where they were headed (`?next=`), or to their account.
 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";

import { logIn, register, ROLE_BLURB, ROLE_TAG, useAccount } from "../console/accountStore";
import type { Role } from "../console/accountStore";
import { cardVariants, gridVariants } from "../console/motion";
import StadiumBackdrop from "../components/Sections/StadiumBackdrop";
import LightSweep from "../components/UI/LightSweep";

import "../console/console.css";

const LABEL = "font-ui text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-body";
const INPUT =
  "mt-1 w-full rounded-lg border border-line bg-surface-sunken px-3 py-2.5 font-ui text-[13px] text-slate-ink outline-none transition-colors focus:border-slate-faint";
const PRIMARY =
  "w-full rounded-lg bg-slate-ink px-4 py-2.5 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

const ROLES: Role[] = ["auctioneer", "delegate", "member"];

/** Only paths on this site, so `?next=` cannot send anyone elsewhere. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/account";
}

export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));
  const { status, account } = useAccount();
  const [mode, setMode] = useState<"login" | "register">(params.get("mode") === "register" ? "register" : "login");

  useEffect(() => {
    document.title = mode === "login" ? "AUCTONIQ · Log in" : "AUCTONIQ · Create account";
  }, [mode]);

  // Already signed in: nothing to do here.
  useEffect(() => {
    if (status === "ready" && account) navigate(next, { replace: true });
  }, [status, account, next, navigate]);

  return (
    <div className="console-dark">
      <StadiumBackdrop variant="console" />
      <div className="min-h-screen bg-surface bg-dots px-5 py-10">
        <motion.div className="mx-auto w-full max-w-md" variants={gridVariants} initial="initial" animate="animate">
          <motion.header className="mb-6 flex items-start justify-between gap-4" variants={cardVariants}>
            <div>
              <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
                AUCTONIQ account
              </span>
              <h1 className="mt-1 font-head text-[28px] font-bold leading-tight text-slate-ink">
                {mode === "login" ? "Log in" : "Create your account"}
              </h1>
            </div>
            <Link
              to="/"
              className="shrink-0 rounded-lg border border-line bg-surface-card px-3 py-1.5 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
            >
              ← AUCTONIQ
            </Link>
          </motion.header>

          <motion.div
            variants={cardVariants}
            className="mb-4 grid grid-cols-2 gap-1 rounded-lg border border-line bg-surface-sunken p-1"
            role="tablist"
            aria-label="Log in or create an account"
          >
            {(["login", "register"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={mode === key}
                onClick={() => setMode(key)}
                className={`rounded-md px-3 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors ${
                  mode === key ? "bg-surface-card text-slate-ink shadow-chip" : "text-slate-muted hover:text-slate-ink"
                }`}
              >
                {key === "login" ? "Log in" : "Create account"}
              </button>
            ))}
          </motion.div>

          {mode === "login" ? (
            <LoginForm onDone={() => navigate(next, { replace: true })} />
          ) : (
            <RegisterForm onDone={() => navigate(next, { replace: true })} />
          )}
        </motion.div>
      </div>
    </div>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mt-3 rounded-lg border border-[#C0453A]/40 bg-[#C0453A]/10 px-3 py-2 font-ui text-[11.5px] leading-relaxed text-[#C0453A]"
    >
      {message}
    </p>
  );
}

function LoginForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await logIn(email, password);
      onDone();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not log in.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.form
      variants={cardVariants}
      onSubmit={submit}
      className="seat-chair relative overflow-hidden rounded-xl border border-line p-5"
      aria-label="Log in"
    >
      <span aria-hidden className="seat-chair__rule" />
      <LightSweep />
      <label className="block">
        <span className={LABEL}>Email</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
          className={INPUT}
        />
      </label>
      <label className="mt-3 block">
        <span className={LABEL}>Password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
          className={INPUT}
        />
      </label>
      <ErrorLine message={error} />
      <button type="submit" disabled={busy || !email || !password} className={`${PRIMARY} mt-5`}>
        {busy ? "Logging in…" : "Log in"}
      </button>
    </motion.form>
  );
}

function RegisterForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!role) {
      setError("Choose what the account is for.");
      return;
    }
    if (password.length < 8) {
      setError("Use a password of at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await register({ name, email, password, role });
      onDone();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not create the account.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.form
      variants={cardVariants}
      onSubmit={submit}
      className="seat-chair relative overflow-hidden rounded-xl border border-line p-5"
      aria-label="Create account"
    >
      <span aria-hidden className="seat-chair__rule" />
      <LightSweep />
      <fieldset>
        <legend className={LABEL}>I am joining as</legend>
        <div className="mt-2 grid gap-2">
          {ROLES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={role === option}
              onClick={() => setRole(option)}
              className={`rounded-lg border px-3.5 py-3 text-left transition-colors ${
                role === option
                  ? "border-slate-ink bg-surface-sunken"
                  : "border-line bg-surface-card hover:border-slate-faint/60"
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <RoleTag role={option} />
                <span
                  aria-hidden
                  className={`h-3.5 w-3.5 rounded-full border ${
                    role === option ? "border-slate-ink bg-slate-ink" : "border-line"
                  }`}
                />
              </span>
              <span className="mt-1.5 block font-ui text-[11.5px] leading-relaxed text-slate-muted">
                {ROLE_BLURB[option]}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      <label className="mt-4 block">
        <span className={LABEL}>Full name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          maxLength={60}
          required
          className={INPUT}
        />
      </label>
      <label className="mt-3 block">
        <span className={LABEL}>Email</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
          className={INPUT}
        />
      </label>
      <label className="mt-3 block">
        <span className={LABEL}>Password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
          className={INPUT}
        />
        <span className="mt-1 block font-ui text-[10.5px] text-slate-faint">At least 8 characters.</span>
      </label>
      <ErrorLine message={error} />
      <button type="submit" disabled={busy || !name || !email || !password} className={`${PRIMARY} mt-5`}>
        {busy ? "Creating account…" : "Create account"}
      </button>
    </motion.form>
  );
}

/** The tag an account wears, in its role's colour. */
export function RoleTag({ role, large = false }: { role: Role; large?: boolean }) {
  const tone =
    role === "auctioneer"
      ? "border-neon-orange/60 text-neon-orange"
      : role === "delegate"
        ? "border-neon-cyan/60 text-neon-cyan"
        : "border-line text-slate-body";
  return (
    <span
      className={`inline-flex items-center rounded-md border font-tech font-semibold uppercase ${tone} ${
        large ? "px-2.5 py-1 text-[12px] tracking-[0.16em]" : "px-2 py-0.5 text-[10px] tracking-[0.14em]"
      }`}
    >
      {ROLE_TAG[role]}
    </span>
  );
}
