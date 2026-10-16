"use client";

// v29: the Client Manager's invoices: their own signature and signing password, the invoices of their clients that
// wait for a signature (sign them here; they go to the client once signed), and the latest ones.
import Link from "next/link";
import { useRef, useState } from "react";
import { formatINR, INVOICE_IMAGE_MAX_BYTES, INVOICE_IMAGE_TYPES, invoiceKindLabels, type CmInvoiceRow, type SigningProfileView } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle } from "@/components/ui";
import { useActionsMaybe } from "@/components/actions/actions-provider";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { SignInvoiceDialog } from "./sign-invoice-dialog";

const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export function CmInvoices() {
  const profile = useLoad(() => api.service.mySigning(), { live: false });
  const list = useLoad(() => api.service.cmInvoices(), { live: ["Invoice"] });
  const actions = useActionsMaybe();
  const [signing, setSigning] = useState<CmInvoiceRow | null>(null);
  const [msg, setMsg] = useState<string>();
  const ready = profile.data?.ready ?? false;
  return (
    <>
      <PageTitle
        title="Invoices"
        subtitle="Create invoices for your clients (+ New → Invoice) and sign them with your own signature and signing password. A signed invoice carries your signature, “Client Manager” and the company seal."
        action={
          actions ? (
            <Button onClick={() => actions.openNew("invoice")} data-testid="cm-new-invoice">
              New invoice
            </Button>
          ) : undefined
        }
      />
      {msg && (
        <p className="mb-4 border border-border bg-surface-raised px-4 py-2 text-sm" role="status">
          {msg}
        </p>
      )}
      <div className="space-y-8">
        {profile.data ? <MySigning initial={profile.data} onChange={profile.reload} /> : <LoadState loading={profile.loading} error={profile.error} />}
        {!list.data ? (
          <LoadState loading={list.loading} error={list.error} />
        ) : (
          <>
            {list.data.requireSignature && (
              <Panel title={`Waiting for your signature (${list.data.waiting.length})`} subtitle="These invoices go to the client only after they are signed." flush>
                <Rows rows={list.data.waiting} empty="Nothing waiting." onSign={ready ? setSigning : undefined} />
              </Panel>
            )}
            <Panel title="Recent invoices" subtitle="Your clients' latest invoices." flush>
              <Rows rows={list.data.recent} empty="No invoices yet." onSign={ready ? setSigning : undefined} />
            </Panel>
          </>
        )}
      </div>
      {signing && (
        <SignInvoiceDialog
          invoice={{ id: signing.id, number: signing.number, totalPaise: signing.totalPaise, client: signing.client }}
          onClose={() => setSigning(null)}
          onSigned={(m) => {
            setMsg(m);
            list.reload();
          }}
        />
      )}
    </>
  );
}

function Rows({ rows, empty, onSign }: { rows: CmInvoiceRow[]; empty: string; onSign?: (r: CmInvoiceRow) => void }) {
  if (!rows.length) return <p className="px-5 py-6 text-center text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-border" data-testid="cm-invoice-rows">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
          <span className="min-w-0">
            <Link href={`/team/invoices/${r.id}`} className="font-medium underline">
              {r.number}
            </Link>
            <span className="text-ink-muted">
              {" "}
              · {r.client} · {invoiceKindLabels[r.kind] ?? r.kind} · {formatINR(r.totalPaise)} · due {day.format(new Date(r.dueDate))}
            </span>
          </span>
          <span className="flex items-center gap-2">
            {r.status === "draft" ? <Badge>Draft</Badge> : r.held ? <Badge tone="amber">Waiting for signature</Badge> : r.signed ? <Badge tone="green">Signed{r.signedBy ? ` by ${r.signedBy}` : ""}</Badge> : <Badge>Sent</Badge>}
            {!r.signed && r.status !== "draft" && onSign && (
              <Button variant="secondary" onClick={() => onSign(r)} data-testid="cm-sign">
                Sign
              </Button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The Client Manager's own signature and signing password. */
function MySigning({ initial, onChange }: { initial: SigningProfileView; onChange: () => void }) {
  const [p, setP] = useState(initial);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [changing, setChanging] = useState(!initial.passwordSet);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean }>();
  const input = useRef<HTMLInputElement>(null);
  const run = async (fn: () => Promise<SigningProfileView>, ok: string) => {
    setBusy(true);
    setMsg(undefined);
    try {
      setP(await fn());
      setMsg({ text: ok, error: false });
      onChange();
      return true;
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="My signature and signing password" subtitle={`Printed on invoices you sign: your signature, “${p.name}” and “${p.designation}”, with the company seal.`}>
      <div className="grid gap-6 md:grid-cols-2" data-testid="my-signing">
        <div className="min-w-0">
          <p className="text-sm font-medium">My signature</p>
          <div className="mt-2 flex h-32 items-center justify-center border border-dashed border-border bg-[#ffffff]">
            {/* eslint-disable-next-line @next/next/no-img-element -- signed-in image from the API, not optimisable */}
            {p.signature ? <img src={p.signature.url} alt="My signature" className="max-h-28 max-w-[90%] object-contain" /> : <span className="text-xs text-[#6b7280]">Not uploaded yet</span>}
          </div>
          <p className="mt-1 text-xs text-ink-muted">Sign on white paper, photograph or scan it and crop close. PNG with a transparent background looks best (2 MB max).</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              ref={input}
              type="file"
              accept={INVOICE_IMAGE_TYPES.join(",")}
              className="hidden"
              aria-label="Upload my signature"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                if (!INVOICE_IMAGE_TYPES.includes(f.type)) return setMsg({ text: "Use a PNG, JPG or WebP image", error: true });
                if (f.size > INVOICE_IMAGE_MAX_BYTES) return setMsg({ text: "The image must be 2 MB or smaller", error: true });
                void run(() => api.service.uploadMySignature(f), "Signature saved.");
              }}
            />
            <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()} data-testid="upload-my-signature">
              {p.signature ? "Change" : "Upload"}
            </Button>
            {p.signature && (
              <Button variant="ghost" disabled={busy} onClick={() => window.confirm("Remove your signature?") && run(() => api.service.removeMySignature(), "Signature removed.")}>
                Remove
              </Button>
            )}
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium">My signing password</p>
          <p className="mt-1 text-xs text-ink-muted">Only you know it. You enter it each time you sign an invoice. Stored encrypted; change it any time.</p>
          {changing ? (
            <div className="mt-3 space-y-2">
              <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" aria-label="My new signing password" />
              <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type it again" aria-label="Confirm my signing password" />
              <div className="flex gap-2">
                <Button
                  disabled={busy || pw.length < 8 || pw !== confirm}
                  data-testid="save-my-password"
                  onClick={async () => {
                    if (await run(() => api.service.setMySigningPassword(pw, confirm), p.passwordSet ? "Signing password changed." : "Signing password set.")) {
                      setPw("");
                      setConfirm("");
                      setChanging(false);
                    }
                  }}
                >
                  Save password
                </Button>
                {p.passwordSet && (
                  <Button variant="ghost" onClick={() => setChanging(false)}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-3 text-sm">
              <span>Your signing password is set.</span>
              <Button variant="secondary" onClick={() => setChanging(true)}>
                Change password
              </Button>
            </div>
          )}
        </div>
      </div>
      <p className={`mt-4 text-sm ${p.ready ? "text-[#4a6e0c]" : "text-ink-muted"}`}>
        {p.ready ? "Ready: you can sign your clients' invoices." : !p.companySeal ? "Waiting for a Founder to upload the company seal." : "Upload your signature and set your signing password to sign invoices."}
      </p>
      {msg && <p className={`mt-2 text-sm ${msg.error ? "text-red" : "text-ink-muted"}`}>{msg.text}</p>}
    </Panel>
  );
}
