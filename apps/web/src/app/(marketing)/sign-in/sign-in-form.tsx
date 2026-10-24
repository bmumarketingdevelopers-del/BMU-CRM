"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { startAuthentication } from "@simplewebauthn/browser";
import { homePathFor, needsSecondFactor, type Me, type SecondFactorChallenge } from "@bmu/shared";
import { Button, Input } from "@/components/ui";
import { api } from "@/lib/api";

type Demo = { name: string; email: string; role: string };

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams()!; // never null in the App Router (src/pages only holds the API route)
  // Only same-site paths: never send someone to another website after sign-in.
  const rawNext = params.get("next");
  const next = rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//") && !rawNext.startsWith("/sign-in") ? rawNext : null;
  const expired = params.get("expired") === "1";
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"identify" | "code" | "second">("identify");
  const [challenge, setChallenge] = useState<SecondFactorChallenge>();
  const [second, setSecond] = useState("");
  const [devCode, setDevCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<Demo[]>([]);
  const [apiDown, setApiDown] = useState(false);
  const [googleOn, setGoogleOn] = useState(false);
  // After "Continue with Google" with two-factor on, where to go comes back in the #fragment instead of ?next.
  const [hashNext, setHashNext] = useState<string | null>(null);

  useEffect(() => {
    api.auth
      .demoAccounts()
      .then(setDemo)
      .catch(() => setApiDown(true));
    api.auth
      .methods()
      .then((m) => setGoogleOn(m.google))
      .catch(() => setGoogleOn(false));
  }, []);

  // Coming back from Google: signed in, needs the second step, or an error to explain.
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const pending = hash.get("second");
    if (pending) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setIdentifier(hash.get("email") ?? "your Google account");
      setChallenge({ needsSecondFactor: true, challenge: pending, methods: (hash.get("methods") ?? "totp").split(",") as SecondFactorChallenge["methods"] });
      const n = hash.get("next");
      setHashNext(n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/sign-in") ? n : null);
      setStep("second");
      return;
    }
    if (params.get("google") === "done") {
      setBusy(true);
      api.auth
        .me()
        .then(go)
        .catch(() => {
          setError("Google sign-in did not finish. Try again, or use an email code.");
          setBusy(false);
        });
      return;
    }
    const reason = params.get("google_error");
    if (reason) setError(googleErrors(reason, params.get("email")));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on arrival
  }, []);

  async function requestCode(id = identifier) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.auth.requestOtp(id);
      setIdentifier(id);
      setDevCode(res.devCode);
      setCode(res.devCode ?? "");
      setStep("code");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function go(me: Me) {
    // A saved link from another surface (e.g. /admin for a client) falls back to their own home.
    const home = homePathFor(me);
    const target = next ?? hashNext;
    const allowed = target && (target.startsWith(home) || (me.type === "staff" && (target.startsWith("/team") || target.startsWith("/admin"))));
    router.push(allowed ? target : home);
    router.refresh();
  }

  /** Continue with Google: Google confirms the email, then BMU checks the account, two-factor and permissions as usual. */
  function google() {
    setBusy(true);
    window.location.href = `/api/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.auth.verifyOtp(identifier, code);
      if (needsSecondFactor(r)) {
        // v20: two-factor is on for this person: ask for the app code, a recovery code or their passkey.
        setChallenge(r);
        setSecond("");
        setStep("second");
        setBusy(false);
        return;
      }
      go(r.me);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function verifySecond(e: React.FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.signIn.secondFactor(challenge.challenge, second.replace(/\s/g, ""));
      go(r.me);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  /** v20 passkey: sign in with Face ID, a fingerprint or a security key (also works as the second step). */
  async function passkey() {
    setBusy(true);
    setError(undefined);
    try {
      const { options, token } = await api.signIn.passkeyOptions();
      const response = await startAuthentication({ optionsJSON: options as never });
      const r = await api.signIn.passkey(token, response, challenge?.challenge);
      go(r.me);
    } catch (e) {
      const m = (e as Error).message;
      setError(/NotAllowed|abort|cancel/i.test(m + (e as Error).name) ? "Passkey sign-in was cancelled." : m);
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-8">
      {expired && step === "identify" && (
        <p className="border border-amber bg-amber/20 px-3 py-2 text-sm">Your session has ended. Sign in again to carry on where you were.</p>
      )}
      {step === "identify" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            requestCode();
          }}
          className="grid gap-4"
        >
          <Input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="Email or mobile number"
            autoComplete="username"
            required
          />
          <Button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send code"}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={passkey}>
            Sign in with a passkey
          </Button>
          {googleOn && (
            <>
              <p className="text-center text-xs uppercase tracking-[0.18em] text-ink-muted">or</p>
              <Button type="button" variant="secondary" disabled={busy} onClick={google} data-testid="google-sign-in">
                <span className="inline-flex items-center justify-center gap-2">
                  <svg aria-hidden width="16" height="16" viewBox="0 0 48 48">
                    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.2-.1-2.3-.4-3.5z" />
                    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
                    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.2 44 33 44 24c0-1.2-.1-2.3-.4-3.5z" />
                  </svg>
                  Continue with Google
                </span>
              </Button>
              <p className="text-xs text-ink-muted">Use the Google account with the same email BMU has on file for you.</p>
            </>
          )}
        </form>
      ) : step === "second" ? (
        <form onSubmit={verifySecond} className="grid gap-4">
          <p className="text-sm">
            Two-step sign-in is on for <strong>{identifier}</strong>. Enter the 6-digit code from your authenticator app, or one of your recovery codes.
          </p>
          <Input
            value={second}
            onChange={(e) => setSecond(e.target.value)}
            placeholder="Authenticator or recovery code"
            aria-label="Authenticator or recovery code"
            autoComplete="one-time-code"
            maxLength={20}
            autoFocus
            required
          />
          <Button type="submit" disabled={busy}>
            {busy ? "Checking…" : "Continue"}
          </Button>
          {challenge?.methods.includes("passkey") && (
            <Button type="button" variant="secondary" disabled={busy} onClick={passkey}>
              Use my passkey instead
            </Button>
          )}
          <button
            type="button"
            className="text-left text-sm underline"
            onClick={() => {
              setStep("identify");
              setChallenge(undefined);
              setError(undefined);
            }}
          >
            Start again
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="grid gap-4">
          <p className="text-sm">
            Code sent to <strong>{identifier}</strong>.{" "}
            <button
              type="button"
              className="underline"
              onClick={() => {
                setStep("identify");
                setError(undefined);
              }}
            >
              Change
            </button>{" "}
            ·{" "}
            <button type="button" className="underline" disabled={busy} onClick={() => requestCode(identifier)}>
              Send a new code
            </button>
          </p>
          {devCode && (
            <p className="border border-amber bg-amber/20 px-3 py-2 text-sm">
              Development mode: your code is <strong>{devCode}</strong> (filled in for you).
            </p>
          )}
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
          />
          <Button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      )}
      {error && <p className="text-sm text-red">{error}</p>}

      {apiDown && process.env.NODE_ENV !== "production" && (
        <div className="border border-border bg-surface-raised px-3 py-2 text-sm">
          <p className="font-semibold">Demo logins (work once the server is running)</p>
          <p className="mt-1 text-ink-muted">founder@bmu.demo · admin@bmu.demo · am@bmu.demo · finance@bmu.demo · hr@bmu.demo · producer@bmu.demo · video@bmu.demo · script@bmu.demo · social@bmu.demo · dev@bmu.demo · uxui@bmu.demo · design@bmu.demo · pm@bmu.demo · client@sunrise.demo · creator@bmu.demo</p>
        </div>
      )}
      {apiDown && (
        <p className="border border-red bg-red/10 px-3 py-2 text-sm">
          The BMU Hub server isn&apos;t answering, so sign-in can&apos;t work yet. Check the VS Code terminal running <code>pnpm dev</code> for a red error
          (it can take up to a minute after <code>pnpm dev</code> starts; refresh this page once it says the API started).
        </p>
      )}

      {demo.length > 0 && step === "identify" && (
        <div>
          <h2 className="text-sm font-semibold">Demo accounts (development only)</h2>
          <p className="mb-3 text-xs text-ink-muted">Click one to sign in as that role. Mobile sign-in works too: try 98000 00003 (HR) or 98000 00010 (client).</p>
          <div className="grid grid-cols-1 gap-1">
            {demo.map((d) => (
              <button
                key={d.email}
                onClick={() => requestCode(d.email)}
                title={`${d.name} · ${d.role} · ${d.email}`}
                className="flex w-full min-w-0 items-center justify-between gap-3 border border-border bg-surface-raised px-3 py-2 text-left text-sm hover:border-ink"
              >
                <span className="min-w-0">
                  <span className="block truncate">{d.name}</span>
                  <span className="block truncate text-xs text-ink-muted">{d.email}</span>
                </span>
                <span className="max-w-[50%] shrink-0 truncate text-right text-xs text-ink-muted">{d.role}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Why a Google sign-in did not go through (shown on the sign-in page). */
function googleErrors(reason: string, email: string | null): string {
  switch (reason) {
    case "no_account":
      return `No BMU account uses ${email ?? "that Google email"}. Choose the Google account with the email BMU has on file for you, or sign in with an email code.`;
    case "other_google":
      return "Your BMU account is tied to a different Google account. Choose that Google account, or sign in with an email code and unlink Google in Profile > Security.";
    case "unverified":
      return "Google could not confirm that email address. Sign in with an email code instead.";
    case "cancelled":
      return "Google sign-in was cancelled.";
    case "expired":
      return "That Google sign-in took too long or was opened twice. Try again.";
    case "too_many":
      return "Too many sign-in attempts. Try again in a few minutes.";
    case "off":
      return "Google sign-in is not set up yet. Sign in with an email code.";
    default:
      return "Google sign-in did not work. Try again, or sign in with an email code.";
  }
}
