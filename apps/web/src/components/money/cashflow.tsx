"use client";
// v18 13-week cash-flow forecast with the settings it starts from.
import { Fragment, useState } from "react";
import { Button, Input, LoadState, PageTitle } from "@/components/ui";
import { Panel, StatRow, StatTile } from "@/components/dash";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { day, Field, inr, Note, toPaise, todayIst } from "./kit";

export function CashflowDesk() {
  const view = useLoad(() => api.money.cashflow(), { live: ["Invoice", "Payment", "Expense", "InvoiceSchedule"] });
  const settings = useLoad(() => api.settings.all(), { live: false });
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const cf = settings.data?.cashflow;
  const [f, setF] = useState<{ opening: string; payroll: string; overheads: string } | null>(null);
  const [msg, setMsg] = useState<{ error?: string; ok?: string }>({});
  if (!view.data) return <LoadState loading={view.loading} error={view.error} />;
  const v = view.data;
  const max = Math.max(1, ...v.weeks.map((w) => Math.abs(w.closingPaise)));
  const form = f ?? { opening: String((cf?.openingBalancePaise ?? 0) / 100), payroll: String((cf?.monthlyPayrollPaise ?? 0) / 100), overheads: String((cf?.monthlyOverheadsPaise ?? 0) / 100) };
  const save = () =>
    api.settings
      .save("cashflow", { openingBalancePaise: toPaise(form.opening), monthlyPayrollPaise: toPaise(form.payroll), monthlyOverheadsPaise: toPaise(form.overheads), asOf: todayIst() })
      .then(() => { setMsg({ ok: "Saved." }); setEdit(false); settings.reload(); view.reload(); })
      .catch((e: Error) => setMsg({ error: e.message }));
  return (
    <>
      <PageTitle title="Cash flow" subtitle="The next 13 weeks: money expected in from invoices and instalments, money going out on bills, payouts and salaries." action={<Button variant="secondary" onClick={() => setEdit(!edit)} data-testid="cashflow-settings">Starting numbers</Button>} />
      <div className="space-y-6">
        {edit && (
          <Panel title="Starting numbers" subtitle="Bank balance today and the fixed monthly costs that are not entered as bills.">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Bank balance today (₹)"><Input value={form.opening} onChange={(e) => setF({ ...form, opening: e.target.value })} inputMode="decimal" /></Field>
              <Field label="Salaries per month (₹)"><Input value={form.payroll} onChange={(e) => setF({ ...form, payroll: e.target.value })} inputMode="decimal" /></Field>
              <Field label="Rent, tools, other fixed costs (₹)"><Input value={form.overheads} onChange={(e) => setF({ ...form, overheads: e.target.value })} inputMode="decimal" /></Field>
              <div className="flex items-end gap-2"><Button onClick={save}>Save</Button></div>
            </div>
            <Note {...msg} />
          </Panel>
        )}
        <StatRow cols={4}>
          <StatTile label={`Bank today (${day(v.asOf)})`} value={inr(v.openingPaise)} />
          <StatTile label="Coming in (13 weeks)" value={inr(v.weeks.reduce((s, w) => s + w.inPaise, 0))} tone="good" />
          <StatTile label="Going out (13 weeks)" value={inr(v.weeks.reduce((s, w) => s + w.outPaise, 0))} />
          <StatTile label="Lowest point" value={inr(v.lowestPaise)} hint={`week of ${day(v.lowestWeek)}`} tone={v.lowestPaise < 0 ? "bad" : "default"} />
        </StatRow>
        <Panel title="Balance by week" subtitle="Click a week to see what moves.">
          <div className="flex h-40 items-end gap-1" data-testid="cashflow-chart">
            {v.weeks.map((w) => (
              <button key={w.weekStart} onClick={() => setOpen(open === w.weekStart ? null : w.weekStart)} className="flex h-full flex-1 flex-col justify-end" title={`${day(w.weekStart)}: ${inr(w.closingPaise)}`}>
                <span className={`block w-full ${w.closingPaise < 0 ? "bg-[#b4432c]" : open === w.weekStart ? "bg-green" : "bg-charcoal"}`} style={{ height: `${Math.max(2, (Math.abs(w.closingPaise) / max) * 100)}%` }} />
              </button>
            ))}
          </div>
          <div className="mt-1 flex gap-1 text-[10px] text-ink-muted">
            {v.weeks.map((w) => <span key={w.weekStart} className="flex-1 truncate text-center">{day(w.weekStart)}</span>)}
          </div>
        </Panel>
        <Panel flush title="Week by week">
          <table className="w-full text-sm">
            <thead className="text-xs text-ink-muted">
              <tr className="border-b border-border"><th className="px-5 py-2 text-left font-normal">Week of</th><th className="px-3 py-2 text-right font-normal">In</th><th className="px-3 py-2 text-right font-normal">Out</th><th className="px-5 py-2 text-right font-normal">Bank at week end</th></tr>
            </thead>
            <tbody>
              {v.weeks.map((w) => (
                <Fragment key={w.weekStart}>
                  <tr className="cursor-pointer border-b border-border hover:bg-canvas/50" onClick={() => setOpen(open === w.weekStart ? null : w.weekStart)} data-testid="cashflow-week">
                    <td className="px-5 py-2">{day(w.weekStart)}</td>
                    <td className="px-3 py-2 text-right text-[#5f8a12]">{w.inPaise ? inr(w.inPaise) : "—"}</td>
                    <td className="px-3 py-2 text-right">{w.outPaise ? inr(w.outPaise) : "—"}</td>
                    <td className={`px-5 py-2 text-right font-medium ${w.closingPaise < 0 ? "text-[#b4432c]" : ""}`}>{inr(w.closingPaise)}</td>
                  </tr>
                  {open === w.weekStart && (
                    <tr className="border-b border-border bg-canvas/40">
                      <td colSpan={4} className="px-5 py-2">
                        {w.items.length ? (
                          <ul className="space-y-1 text-xs">
                            {w.items.map((i, n) => (
                              <li key={n} className="flex justify-between gap-3"><span>{i.label}</span><span className={i.amountPaise < 0 ? "" : "text-[#5f8a12]"}>{inr(i.amountPaise)}</span></li>
                            ))}
                          </ul>
                        ) : <p className="text-xs text-ink-muted">Nothing expected this week.</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Assumptions">
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-muted">{v.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </Panel>
      </div>
    </>
  );
}
