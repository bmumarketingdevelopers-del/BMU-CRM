"use client";

import Link from "next/link";
import { formatINR } from "@bmu/shared";
import { PayButton } from "@/components/pay-button";
import { when } from "@/components/request-bits";
import { Badge, Button, Card, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { useState } from "react";
import { ClientUploads } from "@/components/ops/client-uploads";
import { ViewOnlyViewer, canViewOnly } from "@/components/view-only";

/** Final delivery (Gate 5) and the file library. Final files unlock after sign-off and the final payment. */
export default function ClientFilesPage() {
  const delivery = useLoad(() => api.client.delivery());
  const files = useLoad(() => api.client.files());
  const [watching, setWatching] = useState<NonNullable<typeof files.data>[number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const reload = () => (delivery.reload(), files.reload());

  async function signOff(id: string) {
    setBusy(true);
    setError(undefined);
    try {
      await api.client.signOff(id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ready = delivery.data?.filter((d) => d.allApproved) ?? [];

  return (
    <>
      <PageTitle title="Files" subtitle="Every approved file in one place. Final files unlock once you sign off and the final invoice is paid." />
      <ClientUploads />

      {ready.length > 0 && (
        <div className="mb-10 grid gap-4 md:grid-cols-2">
          {ready.map((d) => (
            <Card key={d.engagementId} className={d.filesReleased ? "" : "border-amber"}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.12em] text-ink-muted">Final delivery</p>
                  <h2 className="mt-1 font-medium">{d.serviceName}</h2>
                </div>
                {d.filesReleased ? <Badge tone="green">Delivered</Badge> : <Badge tone="amber">{d.signedOffAt || d.balanceInvoice?.status === "paid" || !d.balanceInvoice ? "One step left" : "Two steps left"}</Badge>}
              </div>
              <ol className="mt-5 space-y-3 text-sm">
                <li className="flex items-center justify-between gap-3">
                  <span>{d.signedOffAt ? "✓" : "1."} Sign off the finished work</span>
                  {d.signedOffAt ? (
                    <span className="text-xs text-ink-muted">{when.format(new Date(d.signedOffAt))}</span>
                  ) : d.can.signOff ? (
                    <Button className="py-1.5" disabled={busy} onClick={() => signOff(d.engagementId)}>
                      Sign off
                    </Button>
                  ) : (
                    <span className="text-xs text-ink-muted">Your account owner signs off</span>
                  )}
                </li>
                <li className="flex items-center justify-between gap-3">
                  <span>
                    {d.balanceInvoice?.status === "paid" || !d.balanceInvoice ? "✓" : "2."} Pay the final invoice
                    {d.balanceInvoice && <span className="block text-xs text-ink-muted">{d.balanceInvoice.number}</span>}
                  </span>
                  {d.balanceInvoice && d.balanceInvoice.status !== "paid" && (
                    <PayButton invoiceId={d.balanceInvoice.id} amountPaise={d.balanceInvoice.totalPaise - d.balanceInvoice.paidPaise} onPaid={reload} />
                  )}
                  {d.balanceInvoice?.status === "paid" && <span className="text-xs text-ink-muted">{formatINR(d.balanceInvoice.totalPaise)} paid</span>}
                </li>
              </ol>
              <Link href={`/client/handover/${d.engagementId}`} className={`mt-5 inline-block text-sm ${d.filesReleased ? "bg-charcoal px-4 py-2 font-medium text-ivory" : "underline"}`}>
                {d.filesReleased ? "Open final delivery and download all" : "See what is in your handover pack"}
              </Link>
            </Card>
          ))}
        </div>
      )}
      {error && <p className="mb-4 text-sm text-red">{error}</p>}

      <LoadState loading={files.loading && !files.data} error={files.error} />
      {files.data && (
        <div className="border-t border-border">
          {files.data.map((f) => (
            <div key={f.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{f.deliverable}</p>
                <p className="text-xs text-ink-muted">
                  {f.serviceName} · v{f.version} · {f.name}
                </p>
              </div>
              <div className="flex items-center gap-4">
                {/* v39: before the final payment, a project's work is view only, in the in-app viewer. */}
                {f.preview ? (
                  canViewOnly(null, f.kind) && (
                    <button type="button" className="text-ink-muted underline hover:text-ink" onClick={() => setWatching(f)}>
                      {f.kind === "video" ? "Watch" : "View"}
                    </button>
                  )
                ) : (
                  <a href={f.url} target="_blank" rel="noreferrer" className="text-ink-muted underline hover:text-ink">
                    View
                  </a>
                )}
                {f.downloadUrl ? (
                  <a href={f.downloadUrl} className="font-medium underline">
                    Download
                  </a>
                ) : (
                  <span className="text-xs text-ink-muted" title="Unlocks after sign-off and final payment">
                    🔒 {f.preview ? (canViewOnly(null, f.kind) ? "View only until the final payment" : "Opens after the final payment") : "Locked"}
                  </span>
                )}
              </div>
            </div>
          ))}
          {watching && <ViewOnlyViewer file={{ url: watching.url, name: watching.name, kind: watching.kind }} onClose={() => setWatching(null)} />}
          {files.data.length === 0 && (
            <p className="py-8 text-center text-sm text-ink-muted">
              Approved work appears here. See drafts in <Link href="/client/reviews" className="underline">Review Studio</Link>.
            </p>
          )}
        </div>
      )}
    </>
  );
}
