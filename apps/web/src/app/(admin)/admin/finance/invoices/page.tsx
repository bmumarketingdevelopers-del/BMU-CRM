"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { invoiceKindLabels, invoiceStatusLabels, type FinanceInvoiceList, type FinanceInvoiceRow, type InvoiceFilters } from "@bmu/shared";
import { Panel, StatRow, StatTile } from "@/components/dash";
import { Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useActions } from "@/components/actions/actions-provider";
import { BulkBar, BulkButton, useSelection } from "@/components/actions/bulk-bar";
import { RowMenu } from "@/components/actions/row-menu";
import { SavedViewsMenu } from "@/components/actions/saved-views-menu";
import { CsvButton } from "@/components/charts";
import { AddButton, EmptyAdd, errMsg } from "@/components/ops/kit";
import { DueDateDialog } from "@/components/ops/invoice-actions";
import { InvoiceStatus, fmtDate, inr } from "../../_insights/kit";

type OpsDraftInvoice = Awaited<ReturnType<typeof api.ops.finance.drafts>>[number];
const STATUSES = ["unpaid", "overdue", "issued", "partially_paid", "paid", "credit_noted", "void"] as const;

export default function InvoicesPage() {
  const [filters, setFilters] = useState<InvoiceFilters>({});
  const [q, setQ] = useState("");
  const [data, setData] = useState<FinanceInvoiceList>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [moving, setMoving] = useState<FinanceInvoiceRow | null>(null);
  const { openNew, canNew, notify, version, changed } = useActions();
  const reload = () => setTick((t) => t + 1);

  // Debounce the search box; reload whenever a filter changes.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      api.finance
        .invoices({ ...filters, q: q.trim() || undefined })
        .then((d) => live && (setData(d), setError(undefined)))
        .catch((e: Error) => live && setError(e.message))
        .finally(() => live && setLoading(false));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [filters, q, tick, version]);
  const [drafts, setDrafts] = useState<OpsDraftInvoice[]>([]);
  useEffect(() => {
    api.ops.finance.drafts().then(setDrafts, () => setDrafts([]));
  }, [tick, version]);
  const rows = data?.rows ?? [];
  const sel = useSelection(rows.map((r) => r.id));

  async function remind(list: FinanceInvoiceRow[]) {
    const due = list.filter((r) => r.balancePaise > 0 && r.status !== "draft" && r.status !== "void" && r.clientId);
    if (!due.length) return notify("None of these have anything due to remind about.", null, "error");
    let sent = 0;
    const failed: string[] = [];
    for (const r of due) {
      try {
        await api.finance.remind(r.id);
        sent++;
      } catch (e) {
        failed.push(`${r.number}: ${errMsg(e)}`);
      }
    }
    notify(failed.length ? `${sent} reminders sent. Not sent: ${failed.join("; ")}` : `${sent} payment reminder${sent === 1 ? "" : "s"} sent`, null, failed.length ? "error" : "ok");
    sel.clear();
    changed();
  }
  async function issue(r: { id: string }) {
    try {
      const x = await api.ops.finance.issue(r.id);
      notify(x.message);
      changed();
    } catch (e) {
      notify(errMsg(e), null, "error");
    }
  }
  const addInvoice = canNew("invoice") ? () => openNew("invoice", filters.clientId ? { clientId: filters.clientId } : undefined, reload) : null;


  const set = (k: keyof InvoiceFilters) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilters((f) => ({ ...f, [k]: e.target.value || undefined }));

  return (
    <>
      <PageTitle
        title="Invoices"
        subtitle="Every invoice we have raised, with what is paid and what is still due."
        action={
          <div className="flex flex-wrap items-center gap-2">
            {addInvoice && (
              <AddButton onClick={addInvoice} testId="add-invoice">
                + New invoice
              </AddButton>
            )}
            <CsvButton
              rows={sel.count ? rows.filter((r) => sel.has(r.id)) : rows}
              filename="invoices.csv"
              label="Export"
              columns={[
                { header: "Invoice", value: (r) => r.number },
                { header: "Client", value: (r) => r.client },
                { header: "For", value: (r) => invoiceKindLabels[r.kind] ?? r.kind },
                { header: "Raised", value: (r) => r.createdAt.slice(0, 10) },
                { header: "Due", value: (r) => r.dueDate.slice(0, 10) },
                { header: "Status", value: (r) => invoiceStatusLabels[r.status] },
                { header: "Taxable (₹)", value: (r) => r.subtotalPaise / 100 },
                { header: "GST (₹)", value: (r) => r.gstPaise / 100 },
                { header: "Total (₹)", value: (r) => r.totalPaise / 100 },
                { header: "Paid (₹)", value: (r) => r.paidPaise / 100 },
                { header: "Balance (₹)", value: (r) => r.balancePaise / 100 },
              ]}
            />
            <SavedViewsMenu entity="invoices" filters={{ ...filters, q }} onApply={(x) => {
              const { q: q2, ...rest } = x as InvoiceFilters & { q?: string };
              setFilters(rest);
              setQ(q2 ?? "");
            }} />
          </div>
        }
      />
      {data && (
        <div className="mb-8">
          <StatRow cols={4}>
            <StatTile label="Invoices shown" value={data.totals.count} />
            <StatTile label="Billed" value={inr(data.totals.totalPaise)} hint="including GST, after credit notes" />
            <StatTile label="Paid" value={inr(data.totals.paidPaise)} tone="good" />
            <StatTile label="Still due" value={inr(data.totals.balancePaise)} tone={data.totals.balancePaise ? "warn" : "default"} href="/admin/collections" />
          </StatRow>
        </div>
      )}
      {drafts.length > 0 && (
        <Panel className="mb-6 min-w-0" flush title={`Drafts ${drafts.length}`} subtitle="Not sent yet. Issuing emails the invoice to the client.">
          <ul className="divide-y divide-border text-sm" data-testid="invoice-drafts">
            {drafts.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5" data-draft={d.number}>
                <span>
                  <span className="font-medium">{d.number}</span> · {d.client}
                  <span className="block text-xs text-ink-muted">
                    Due {fmtDate(d.dueDate)} · drafted {fmtDate(d.createdAt)}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="tabular-nums">{inr(d.totalPaise)}</span>
                  <button type="button" className="bg-charcoal px-3 py-1 text-xs font-medium text-ivory" onClick={() => issue(d)} aria-label={`Issue ${d.number}`}>
                    Issue
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Panel className="min-w-0"
        flush
        title="All invoices"
        action={
          <div className="flex flex-wrap gap-2">
            <Input placeholder="Search number or client" value={q} onChange={(e) => setQ(e.target.value)} className="!w-56" aria-label="Search invoices" />
            <Select value={filters.status ?? ""} onChange={set("status")} aria-label="Status">
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === "unpaid" ? "Anything due" : invoiceStatusLabels[s]}
                </option>
              ))}
            </Select>
            <Select value={filters.kind ?? ""} onChange={set("kind")} aria-label="Kind">
              <option value="">Any kind</option>
              {Object.entries(invoiceKindLabels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Select value={filters.clientId ?? ""} onChange={set("clientId")} aria-label="Client">
              <option value="">Every client</option>
              {data?.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        {error && (
          <div className="p-5">
            <LoadState loading={false} error={error} />
          </div>
        )}
        {!data && !error && (
          <div className="p-5">
            <LoadState loading={loading} />
          </div>
        )}
        {data && (
          <div className={loading ? "opacity-60" : ""}>
            {data.rows.length === 0 ? (
              <div className="p-5">
                {Object.values(filters).some(Boolean) || q ? (
                  <p className="text-sm text-ink-muted">No invoices match these filters.</p>
                ) : (
                  <EmptyAdd title="No invoices yet" body="Invoices are raised when a client pays online, or by hand here." action={addInvoice ? <AddButton onClick={addInvoice}>+ New invoice</AddButton> : undefined} />
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm" data-testid="invoice-table">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                      <th className="w-8 px-3 py-2">
                        <input type="checkbox" className="accent-[#8BB72C]" aria-label="Select all invoices" checked={sel.allSelected} onChange={sel.toggleAll} />
                      </th>
                      <th className="px-3 py-2">Invoice</th>
                      <th className="px-3 py-2">Client</th>
                      <th className="px-3 py-2">For</th>
                      <th className="px-3 py-2">Raised</th>
                      <th className="px-3 py-2">Due</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Total</th>
                      <th className="px-3 py-2 text-right">Paid</th>
                      <th className="px-3 py-2 text-right">Balance</th>
                      <th className="w-10 px-3 py-2" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => {
                      const open = r.balancePaise > 0 && r.status !== "void";
                      return (
                        <tr key={r.id} className="border-b border-border" data-invoice={r.number}>
                          <td className="px-3 py-2">
                            <input type="checkbox" className="accent-[#8BB72C]" aria-label={`Select ${r.number}`} checked={sel.has(r.id)} onChange={() => sel.toggle(r.id)} />
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            <Link href={`/admin/finance/invoices/${r.id}`} className="font-medium underline-offset-2 hover:underline">
                              {r.number}
                            </Link>
                          </td>
                          <td className="px-3 py-2">{r.client}</td>
                          <td className="px-3 py-2 text-ink-muted">{invoiceKindLabels[r.kind] ?? r.kind}</td>
                          <td className="whitespace-nowrap px-3 py-2 text-ink-muted">{fmtDate(r.createdAt)}</td>
                          <td className="whitespace-nowrap px-3 py-2 text-ink-muted">{fmtDate(r.dueDate)}</td>
                          <td className="px-3 py-2">
                            <InvoiceStatus status={r.status} />
                          </td>
                          <td className={`px-3 py-2 text-right tabular-nums ${r.status === "void" ? "text-ink-muted line-through" : ""}`}>{inr(r.totalPaise)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{inr(r.paidPaise)}</td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">{r.balancePaise ? inr(r.balancePaise) : "—"}</td>
                          <td className="px-3 py-2">
                            <RowMenu
                              label={`More actions for ${r.number}`}
                              items={[
                                { key: "open", label: "Open", href: `/admin/finance/invoices/${r.id}` },
                                { key: "issue", label: "Issue to client", hidden: r.status !== "draft", onSelect: () => issue(r) },
                                { key: "due", label: "Change due date", hidden: !open || r.status === "draft", onSelect: () => setMoving(r) },
                                { key: "remind", label: "Send payment reminder", hidden: !open || r.status === "draft", disabledReason: r.clientId ? null : "No client on this invoice", onSelect: () => remind([r]) },
                                { key: "pay", label: "Record a payment", hidden: !open || r.status === "draft", href: `/admin/finance/invoices/${r.id}#record-payment` },
                                { key: "print", label: "Print / PDF", href: `/admin/finance/invoices/${r.id}/print` },
                                { key: "history", label: "History", href: `/admin/finance/invoices/${r.id}#history` },
                              ]}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {data.rows.length > 0 && (
              <div className="flex flex-wrap justify-end gap-x-8 gap-y-1 border-t border-border px-4 py-3 text-sm tabular-nums">
                <span className="text-ink-muted">Totals</span>
                <span>Billed {inr(data.totals.totalPaise)}</span>
                <span className="text-ink-muted">Paid {inr(data.totals.paidPaise)}</span>
                <span className="font-medium">Due {inr(data.totals.balancePaise)}</span>
              </div>
            )}
          </div>
        )}
      </Panel>
      <BulkBar count={sel.count} onClear={sel.clear} label="invoices">
        <BulkButton onClick={() => remind(rows.filter((r) => sel.has(r.id)))}>Send reminders</BulkButton>
      </BulkBar>
      {moving && <DueDateDialog invoice={moving} onClose={() => setMoving(null)} onDone={(m, undo) => (notify(m, undo), reload())} />}
    </>
  );
}
