"use client";

import { useState } from "react";
import Link from "next/link";
import type { ProofRoundView } from "@bmu/shared";
import { Badge, Button, Card } from "@/components/ui";

const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const viaLabel: Record<string, string> = { portal: "client portal", email: "email link", whatsapp: "WhatsApp link", bmu: "BMU (no client sign-off)" };

/** Each version's round: the internal check first, then the client. Clients see only that it was checked. */
export function ProofRounds({ rounds, certificate, certificateHref, client = false }: { rounds: ProofRoundView[]; certificate?: { code: string } | null; certificateHref?: string; client?: boolean }) {
  if (!rounds.length) return null;
  return (
    <Card>
      <h3 className="mb-2 text-sm font-semibold">Approval rounds</h3>
      <ol className="space-y-3 text-sm">
        {rounds
          .slice()
          .reverse()
          .map((r) => (
            <li key={r.versionId} className="border-l-2 border-border pl-3">
              <p className="font-semibold">
                Version {r.number} <span className="font-normal text-ink-muted">· {r.uploadedBy}</span>
              </p>
              <p className="text-xs">
                1. Internal check:{" "}
                {r.internal ? (
                  client ? (
                    <span className="text-green">checked by BMU</span>
                  ) : (
                    <span className={r.internal.result === "pass" ? "text-green" : "text-red"}>
                      {r.internal.result === "pass" ? "passed" : "failed"}
                      {r.internal.by ? ` by ${r.internal.by}` : ""} · {when.format(new Date(r.internal.at))}
                    </span>
                  )
                ) : (
                  <span className="text-ink-muted">waiting</span>
                )}
              </p>
              <p className="text-xs">
                2. Client:{" "}
                {r.client ? (
                  <span className={r.client.decision === "approved" ? "font-semibold text-green" : "text-red"}>
                    {r.client.decision === "approved" ? "approved" : "asked for changes"} by {r.client.by} · {when.format(new Date(r.client.at))}
                    {r.client.via ? ` · via ${viaLabel[r.client.via] ?? r.client.via}` : ""}
                  </span>
                ) : r.sentAt ? (
                  <span className="text-amber">with the client since {when.format(new Date(r.sentAt))}</span>
                ) : (
                  <span className="text-ink-muted">not sent yet</span>
                )}
              </p>
              <p className="text-xs text-ink-muted">
                {r.comments} comment{r.comments === 1 ? "" : "s"}, {r.openComments} open{r.carriedOver ? `, ${r.carriedOver} carried over` : ""}
              </p>
            </li>
          ))}
      </ol>
      {certificate && certificateHref && (
        <Link href={certificateHref} className="mt-3 block border border-green bg-green/10 px-3 py-2 text-sm">
          <span className="font-semibold">Approval certificate</span> <span className="font-mono text-xs">{certificate.code}</span>
          <span className="block text-xs text-ink-muted">Who approved which exact file, when and how. Open to print or verify.</span>
        </Link>
      )}
    </Card>
  );
}

/** Post caption, kept with the deliverable so the calendar and the publisher use the same words. */
export function CaptionEditor({ caption, onSave, disabled }: { caption: string | null; onSave: (caption: string | null) => Promise<void>; disabled?: boolean }) {
  const [text, setText] = useState(caption ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Card>
      <h3 className="mb-1 text-sm font-semibold">Caption</h3>
      <textarea
        className="w-full border border-border bg-surface-raised px-3 py-2 text-sm"
        rows={4}
        maxLength={5000}
        value={text}
        disabled={disabled}
        onChange={(e) => (setText(e.target.value), setSaved(false))}
        placeholder="Caption, hashtags and any first comment"
      />
      <div className="mt-1 flex items-center justify-between text-xs text-ink-muted">
        <span>{text.length} characters</span>
        {!disabled && (
          <Button
            variant="secondary"
            className="py-1 text-xs"
            disabled={busy || text === (caption ?? "")}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await onSave(text.trim() || null);
                setSaved(true);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {saved ? "Saved" : "Save caption"}
          </Button>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red">{error}</p>}
    </Card>
  );
}

export function ApproveForPublishing({ number, busy, onApprove }: { number: number; busy: boolean; onApprove: () => void }) {
  return (
    <Card className="border-green">
      <div className="flex items-center gap-2">
        <p className="font-semibold">Approve for publishing</p>
        <Badge tone="green">Client allows BMU sign-off</Badge>
      </div>
      <p className="mt-1 text-sm text-ink-muted">This client does not review every post. Approving v{number} records you as the approver, issues a certificate and puts it on the content calendar.</p>
      <Button className="mt-3" disabled={busy} onClick={onApprove}>
        Approve v{number} for publishing
      </Button>
    </Card>
  );
}
