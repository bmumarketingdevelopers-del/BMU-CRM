"use client";

import Link from "next/link";
import type { ApprovalCertificateView } from "@bmu/shared";
import { Logo } from "@/components/logo";
import { Button, LoadState } from "@/components/ui";
import { bytes } from "./asset-uploader";

const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Kolkata" });
const viaLabel: Record<string, string> = { portal: "Client portal", email: "Email link", whatsapp: "WhatsApp link", bmu: "BMU on the client's behalf" };

/** Printable record of who approved which exact file, when and how, sealed with a SHA-256 hash. */
export function Certificate({ c, loading, error, back }: { c?: ApprovalCertificateView; loading: boolean; error?: string; back: { href: string; label: string } }) {
  if (!c) return <LoadState loading={loading} error={error} />;
  return (
    <div>
      <div className="mb-4 flex justify-between print:hidden">
        <Link href={back.href} className="text-sm underline">
          {back.label}
        </Link>
        <Button variant="secondary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>
      <article className="mx-auto max-w-2xl border border-border bg-white p-8 text-sm print:border-0 print:p-0" data-testid="certificate">
        <div className="flex items-start justify-between gap-4">
          <Logo />
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">Approval certificate</p>
            <p className="font-mono text-sm font-semibold">{c.code}</p>
          </div>
        </div>
        <h1 className="mt-6 text-xl font-semibold">{c.deliverable.title}</h1>
        <p className="text-ink-muted">
          {c.client} · {c.service} · {c.deliverable.type}
        </p>

        <dl className="mt-6 grid grid-cols-[160px_1fr] gap-y-2">
          <dt className="text-ink-muted">Approved file</dt>
          <dd>
            Version {c.version.number}
            {c.version.name ? ` · ${c.version.name}` : ""}
            {c.version.sizeBytes ? ` · ${bytes(c.version.sizeBytes)}` : ""}
          </dd>
          <dt className="text-ink-muted">Uploaded</dt>
          <dd>{when.format(new Date(c.version.uploadedAt))}</dd>
          {c.version.checksum && (
            <>
              <dt className="text-ink-muted">File fingerprint</dt>
              <dd className="break-all font-mono text-xs">{c.version.checksum}</dd>
            </>
          )}
          <dt className="text-ink-muted">Internal check</dt>
          <dd>{c.internal ? `Passed by ${c.internal.by} on ${when.format(new Date(c.internal.at))}` : "Not recorded"}</dd>
          <dt className="text-ink-muted">Approval rule</dt>
          <dd>{c.rule}</dd>
          <dt className="text-ink-muted">Rounds</dt>
          <dd>
            {c.rounds} version{c.rounds === 1 ? "" : "s"}, {c.comments} comment{c.comments === 1 ? "" : "s"}
          </dd>
        </dl>

        <h2 className="mt-6 text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">Approved by</h2>
        <table className="mt-2 w-full text-left">
          <thead className="text-xs text-ink-muted">
            <tr>
              <th className="py-1 font-normal">Name</th>
              <th className="py-1 font-normal">When</th>
              <th className="py-1 font-normal">How</th>
            </tr>
          </thead>
          <tbody>
            {c.approvals.map((a, i) => (
              <tr key={i} className="border-t border-border">
                <td className="py-1.5">
                  {a.name}
                  {a.email && <span className="block text-xs text-ink-muted">{a.email}</span>}
                </td>
                <td className="py-1.5">{when.format(new Date(a.at))}</td>
                <td className="py-1.5">
                  {viaLabel[a.via] ?? a.via}
                  {a.ip && <span className="block text-xs text-ink-muted">from {a.ip}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className={`mt-6 border px-4 py-3 ${c.valid ? "border-green bg-green/10" : "border-red bg-red/10"}`} data-testid="certificate-valid">
          <p className="font-semibold">{c.valid ? "✓ Verified: nothing has changed since approval" : "✗ Something changed after approval"}</p>
          <p className="mt-1 text-xs text-ink-muted">
            {c.valid ? "The record and the file still match the seal below." : "The record or the file no longer matches its seal. Ask BMU before using this file."}
          </p>
          <p className="mt-2 break-all font-mono text-[11px] text-ink-muted">Seal (SHA-256): {c.hash}</p>
        </div>
        <p className="mt-4 text-xs text-ink-muted">Issued {when.format(new Date(c.issuedAt))} by BMU Hub.</p>
      </article>
    </div>
  );
}
