"use client";

// v20 Profile → Security: authenticator app (TOTP) with recovery codes, passkeys and signed-in devices.
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { startRegistration } from "@simplewebauthn/browser";
import type { SecurityOverview, TotpSetup } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { Badge, Button, Input, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
type Msg = { ok: boolean; text: string } | undefined;

function Note({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <p className={`mt-3 text-sm ${msg.ok ? "text-ink" : "text-red"}`}>{msg.text}</p>;
}

export function SecurityPanels({ required = false }: { required?: boolean }) {
  const sec = useLoad(() => api.security.me(), { live: false });
  if (!sec.data) return <LoadState loading={sec.loading} error={sec.error} />;
  const s = sec.data;
  return (
    <div className="grid gap-6">
      {required && !s.totp.enabled && !s.passkeys.length && (
        <p className="border border-amber bg-amber/20 px-3 py-2 text-sm">Your role must use two-step sign-in. Turn on an authenticator app or add a passkey below to carry on.</p>
      )}
      <TotpPanel s={s} onChange={sec.reload} />
      <PasskeyPanel s={s} onChange={sec.reload} />
      <GooglePanel s={s} onChange={sec.reload} />
      <SessionsPanel s={s} onChange={sec.reload} />
    </div>
  );
}

function TotpPanel({ s, onChange }: { s: SecurityOverview; onChange: () => void }) {
  const [setup, setSetup] = useState<TotpSetup>();
  const [qr, setQr] = useState<string>();
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>();

  useEffect(() => {
    if (setup) void QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 180, color: { dark: "#121F2F", light: "#FFFFFF" } }).then(setQr);
  }, [setup]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMsg(undefined);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Authenticator app"
      subtitle="A 6-digit code from Google Authenticator, Microsoft Authenticator or similar, asked for after your sign-in code."
      action={s.totp.enabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}
    >
      {codes ? (
        <div>
          <p className="text-sm font-semibold">Save these recovery codes somewhere safe.</p>
          <p className="text-sm text-ink-muted">Each works once if you lose your phone. They will not be shown again.</p>
          <pre className="mt-3 grid grid-cols-2 gap-1 border border-border bg-surface p-3 font-mono text-sm sm:grid-cols-5">{codes.map((c) => <span key={c}>{c}</span>)}</pre>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))}>
              Copy
            </Button>
            <Button onClick={() => (setCodes(undefined), onChange())}>I have saved them</Button>
          </div>
        </div>
      ) : s.totp.enabled ? (
        <form
          className="grid max-w-sm gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.security.totpDisable(code);
              setCode("");
              setMsg({ ok: true, text: "Authenticator app turned off." });
              onChange();
            });
          }}
        >
          <p className="text-sm">{s.totp.recoveryCodesLeft} recovery codes left.</p>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Current 6-digit code to turn off" inputMode="numeric" maxLength={6} />
          <Button variant="secondary" type="submit" disabled={busy || code.length !== 6}>
            Turn off
          </Button>
        </form>
      ) : setup ? (
        <form
          className="grid gap-3 sm:grid-cols-[180px_1fr]"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await api.security.totpEnable(code);
              setCodes(r.recoveryCodes);
              setSetup(undefined);
              setCode("");
            });
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a generated data: URL */}
          {qr ? <img src={qr} alt="QR code to scan with your authenticator app" width={180} height={180} className="border border-border" /> : <div className="size-[180px] border border-border" />}
          <div className="grid content-start gap-3">
            <p className="text-sm">Scan the code with your authenticator app, or type this key:</p>
            <code className="break-all border border-border bg-surface px-2 py-1 text-sm">{setup.secret}</code>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code from the app" inputMode="numeric" maxLength={6} autoFocus />
            <Button type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Turn on"}
            </Button>
          </div>
        </form>
      ) : (
        <Button disabled={busy} onClick={() => void run(async () => setSetup(await api.security.totpSetup()))}>
          Set up authenticator app
        </Button>
      )}
      <Note msg={msg} />
    </Panel>
  );
}

function PasskeyPanel({ s, onChange }: { s: SecurityOverview; onChange: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>();

  async function add() {
    setBusy(true);
    setMsg(undefined);
    try {
      const { options, token } = await api.security.passkeyOptions();
      const response = await startRegistration({ optionsJSON: options as never });
      await api.security.addPasskey(token, response, name.trim() || guessDevice());
      setName("");
      setMsg({ ok: true, text: "Passkey added. You can now sign in with it from the sign-in page." });
      onChange();
    } catch (e) {
      const err = e as Error;
      setMsg({ ok: false, text: /NotAllowed|abort/i.test(err.name + err.message) ? "Adding the passkey was cancelled." : err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Passkeys" subtitle="Sign in with Face ID, a fingerprint, Windows Hello or a security key, with no code to type. A passkey also counts as two-step sign-in.">
      {s.passkeys.length > 0 && (
        <ul className="mb-4 divide-y divide-border border border-border">
          {s.passkeys.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span>
                <span className="font-medium">{p.name}</span>
                <span className="block text-xs text-ink-muted">
                  Added {fmt.format(new Date(p.createdAt))}
                  {p.lastUsedAt ? ` · last used ${fmt.format(new Date(p.lastUsedAt))}` : " · not used yet"}
                </span>
              </span>
              <Button
                variant="ghost"
                className="px-3 py-1.5"
                onClick={() => {
                  if (confirm(`Remove the passkey "${p.name}"?`)) void api.security.removePasskey(p.id).then(onChange, (e: Error) => setMsg({ ok: false, text: e.message }));
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex max-w-md flex-wrap gap-2">
        <Input className="min-w-0 flex-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Work laptop" aria-label="Passkey name" maxLength={60} />
        <Button disabled={busy} onClick={add}>
          {busy ? "Waiting…" : "Add a passkey"}
        </Button>
      </div>
      <Note msg={msg} />
    </Panel>
  );
}

const methodLabel = (m: string) => {
  if (m.startsWith("passkey")) return "Passkey";
  if (m.startsWith("api")) return "API";
  const first = m.startsWith("google") ? "Google" : "Sign-in code";
  return m.includes("totp") ? `${first} + authenticator` : m.includes("recovery") ? `${first} + recovery code` : m.includes("passkey") ? `${first} + passkey` : first;
};

function guessDevice() {
  if (typeof navigator === "undefined") return "Passkey";
  const ua = navigator.userAgent;
  return /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android phone" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : "Passkey";
}

function SessionsPanel({ s, onChange }: { s: SecurityOverview; onChange: () => void }) {
  const [msg, setMsg] = useState<Msg>();
  const others = s.sessions.filter((x) => !x.current).length;
  return (
    <Panel
      title="Signed-in devices"
      subtitle="Where your account is signed in now. Sign out any device you do not recognise."
      action={
        others > 0 ? (
          <Button
            variant="secondary"
            className="px-3 py-1.5"
            onClick={() => void api.security.signOutOthers().then((r) => (setMsg({ ok: true, text: `Signed out ${r.signedOut} other device${r.signedOut === 1 ? "" : "s"}.` }), onChange()))}
          >
            Sign out all others
          </Button>
        ) : undefined
      }
      flush
    >
      <ul className="divide-y divide-border">
        {s.sessions.map((x) => (
          <li key={x.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{x.device}</span> {x.current && <Badge tone="green">This device</Badge>}
              <span className="block text-xs text-ink-muted">
                {methodLabel(x.method)} · since {fmt.format(new Date(x.createdAt))} · last active {fmt.format(new Date(x.lastSeenAt))}
                {x.expiresAt ? ` · ends ${fmt.format(new Date(x.expiresAt))}` : ""}
                {x.ip ? ` · ${x.ip}` : ""}
              </span>
            </span>
            {!x.current && (
              <Button variant="ghost" className="px-3 py-1.5" onClick={() => void api.security.revokeSession(x.id).then(onChange, (e: Error) => setMsg({ ok: false, text: e.message }))}>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="px-4 pb-3">
        <Note msg={msg} />
      </div>
    </Panel>
  );
}

/** v42: "Continue with Google" is tied to the Google account it was first used with; unlink to use another one. */
function GooglePanel({ s, onChange }: { s: SecurityOverview; onChange: () => void }) {
  const [msg, setMsg] = useState<Msg>();
  return (
    <Panel title="Google sign-in" subtitle="Continue with Google works only with the Google account you first used it with, so nobody else can use your email's Google account.">
      {s.google ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span>
            Tied to the Google account <strong>{s.google.email}</strong>
          </span>
          <Button
            variant="ghost"
            className="px-3 py-1.5"
            onClick={() => {
              if (confirm("Unlink Google? Your next Continue with Google will tie your account to the Google account you choose then."))
                void api.security.unlinkGoogle().then(
                  () => {
                    setMsg({ ok: true, text: "Google unlinked." });
                    onChange();
                  },
                  (e: Error) => setMsg({ ok: false, text: e.message }),
                );
            }}
          >
            Unlink
          </Button>
        </div>
      ) : (
        <p className="text-sm text-ink-muted">Not used yet. The first time you choose Continue with Google on the sign-in page, your account is tied to that Google account.</p>
      )}
      <Note msg={msg} />
    </Panel>
  );
}
