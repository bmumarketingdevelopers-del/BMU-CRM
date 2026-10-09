"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ServiceBillingRunLine, ServiceBillingRunPreview, ServiceBillingRunResult } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile, type Column } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { FormNote, fmtDateTime, inr } from "../../_insights/kit";

const thisMonth = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
const tone: Record<ServiceBillingRunLine["status"], "green" | "neutral" | "amber" | "dark"> = { ready: "dark", already_issued: "green", started_this_month: "neutral", no_price: "amber" };
const label: Record<ServiceBillingRunLine["status"], string> = { ready: "Ready", already_issued: "Already billed", started_this_month: "First month paid", no_price: "No price" };

export default function BillingRunPage() {
  const [period, setPeriod] = useState(thisMonth());
  const [preview, setPreview] = useState<ServiceBillingRunPreview>();
  const [loadError, setLoadError] = useState<string>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [due, setDue] = useState("7");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ServiceBillingRunResult>();
  const [error, setError] = useState<string | null>(null);
  const runs = useLoad(() => api.service.billingRuns());

  useEffect(() => {
    let alive = true;
    api.service.billingRunPreview(period).then(
      (p) => {
        if (!alive) return;
        setPreview(p);
        setLoadError(undefined);
        setPicked(new Set(p.lines.filter((l) => l.status === "ready").map((l) => l.engagementId)));
      },
      (e: Error) => alive && setLoadError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [period, result]);

  async function issue(ids: string[]) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.service.billingRunIssue({ period, engagementIds: ids, dueInDays: Number(due) || 7 });
      setResult(r);
      runs.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ready = preview?.lines.filter((l) => l.status === "ready") ?? [];
  const chosen = ready.filter((l) => picked.has(l.engagementId));
  const columns: Column<ServiceBillingRunLine>[] = [
    {
      key: "pick",
      header: "",
      cell: (l) =>
        l.status === "ready" ? (
          <input
            type="checkbox"
            aria-label={`Bill ${l.client} ${l.service}`}
            checked={picked.has(l.engagementId)}
            onChange={(e) => setPicked((s) => {
              const n = new Set(s);
              if (e.target.checked) n.add(l.engagementId);
              else n.delete(l.engagementId);
              return n;
            })}
          />
        ) : null,
    },
    { key: "client", header: "Client", cell: (l) => <Link href={`/team/clients/${l.clientId}`} className="hover:underline">{l.client}</Link> },
    { key: "service", header: "Retainer", cell: (l) => `${l.service} (${l.tier})` },
    { key: "amount", header: "Amount", align: "right", cell: (l) => inr(l.amountPaise) },
    { key: "gst", header: "GST", align: "right", cell: (l) => <span className="text-ink-muted">{inr(l.gstPaise)}</span> },
    { key: "total", header: "Total", align: "right", cell: (l) => <strong>{inr(l.totalPaise)}</strong> },
    {
      key: "status",
      header: "Status",
      cell: (l) => (
        <span className="flex flex-col gap-0.5">
          <Badge tone={tone[l.status]}>{label[l.status]}</Badge>
          {l.existingInvoice ? (
            <Link href={`/admin/finance/invoices/${l.existingInvoice.id}`} className="text-xs underline">
              {l.existingInvoice.number}
            </Link>
          ) : (
            l.status !== "ready" && <span className="text-xs text-ink-muted">{l.note}</span>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageTitle title="Billing run" subtitle="Issue this month's retainer invoices in one go. Retainers already billed for the month (here or when their cycle started) are skipped, so nobody is billed twice." />
      <div className="space-y-8">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-ink-muted">Month</span>
            <Input type="month" value={period} onChange={(e) => (setPeriod(e.target.value || thisMonth()), setResult(undefined))} />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-ink-muted">Due in (days)</span>
            <Input type="number" min={0} max={60} value={due} onChange={(e) => setDue(e.target.value)} className="w-24" />
          </label>
        </div>
        {!preview ? (
          <LoadState loading={!loadError} error={loadError} />
        ) : (
          <>
            <StatRow cols={4}>
              <StatTile label="Ready to bill" value={preview.readyCount} hint={inr(preview.readyTotalPaise)} />
              <StatTile label="Already billed" value={preview.lines.filter((l) => l.status === "already_issued").length} tone="good" />
              <StatTile label="First month (paid upfront)" value={preview.lines.filter((l) => l.status === "started_this_month").length} />
              <StatTile label="Need a price" value={preview.lines.filter((l) => l.status === "no_price").length} tone={preview.lines.some((l) => l.status === "no_price") ? "warn" : "default"} />
            </StatRow>
            <Panel
              className="min-w-0"
              title={`Active retainers · ${preview.periodLabel}`}
              subtitle="Untick anything you don't want to bill now."
              action={
                preview.canIssue && ready.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" disabled={busy || !chosen.length} onClick={() => issue(chosen.map((l) => l.engagementId))}>
                      Issue selected ({chosen.length})
                    </Button>
                    <Button disabled={busy} onClick={() => issue(ready.map((l) => l.engagementId))}>
                      {busy ? "Issuing…" : `Issue all ${ready.length}`}
                    </Button>
                  </div>
                ) : undefined
              }
              flush
            >
              <DataTable rows={preview.lines} columns={columns} rowKey={(l) => l.engagementId} empty="No active retainers." />
            </Panel>
            <FormNote error={error} />
            {result && (
              <div className="border border-green bg-green/5 p-4 text-sm" data-testid="billing-run-result">
                <p className="font-medium">
                  Issued {result.issued.length} invoice{result.issued.length === 1 ? "" : "s"}
                  {result.skipped.length ? `, skipped ${result.skipped.length}` : ""}. Clients were notified and emailed the tax invoice.
                </p>
                <ul className="mt-2 space-y-0.5">
                  {result.issued.map((i) => (
                    <li key={i.id}>
                      <Link href={`/admin/finance/invoices/${i.id}`} className="underline">
                        {i.number}
                      </Link>{" "}
                      · {i.client}
                    </li>
                  ))}
                  {result.skipped.map((s) => (
                    <li key={s.engagementId} className="text-ink-muted">
                      Skipped: {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        <Panel className="min-w-0" title="Past billing runs" flush>
          {runs.data ? (
            <DataTable
              rows={runs.data}
              rowKey={(r) => r.id}
              empty="No billing runs yet."
              columns={[
                { key: "at", header: "When", cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</span> },
                { key: "period", header: "Month", cell: (r) => r.period },
                { key: "by", header: "By", cell: (r) => r.by },
                { key: "issued", header: "Issued", align: "right", cell: (r) => r.issuedCount },
                { key: "skipped", header: "Skipped", align: "right", cell: (r) => r.skippedCount },
                { key: "total", header: "Total", align: "right", cell: (r) => inr(r.totalPaise) },
                { key: "inv", header: "Invoices", cell: (r) => <span className="text-xs text-ink-muted">{r.invoices.map((i) => i.number).join(", ") || "—"}</span> },
              ]}
            />
          ) : (
            <div className="p-5">
              <LoadState loading={runs.loading} error={runs.error} />
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
