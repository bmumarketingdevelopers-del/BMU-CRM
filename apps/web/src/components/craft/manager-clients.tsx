"use client";
// v10 craft: the manager's client portfolio, the "Today" list and the team view.
import { useState } from "react";
import Link from "next/link";
import { CRAFT_NOTE_KINDS, type CraftClientCard, type CraftManagerView, type CraftNoteKind, type CraftTodayItem } from "@bmu/shared";
import { CsvButton, Heatmap } from "@/components/charts";
import { DataTable, Empty, Meter, Panel } from "@/components/dash";
import { Badge, Button, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { ErrorLine, dueLabel, fmtDay, fmtTime, useAction } from "./craft-bits";

const healthTone = (h: string) => (h === "red" ? "red" : h === "amber" ? "amber" : "green");
const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
const todayLabel: Record<CraftTodayItem["kind"], string> = {
  blocked: "Blocked",
  overdue: "Overdue",
  qc_failed: "QC failed",
  client_reply: "Reply",
  approval: "Approval",
  invoice: "Invoice",
  reminder: "Reminder",
  unassigned: "No owner",
};
const todayTone = (k: CraftTodayItem["kind"]) => (["blocked", "overdue", "qc_failed"].includes(k) ? "red" : k === "client_reply" || k === "reminder" ? "amber" : k === "unassigned" ? "dark" : "neutral");

function ago(iso: string) {
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** Nudge button shared by the Today list and client cards (one reminder per deliverable per 24 hours). */
function Nudge({ deliverableId, canNudge, onChanged }: { deliverableId: string; canNudge: boolean; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const [sent, setSent] = useState(false);
  if (sent) return <span className="text-xs text-[#5f8a12]">✓ Nudged</span>;
  return (
    <span>
      <Button
        variant="secondary"
        className="px-2 py-0.5 text-xs"
        disabled={!canNudge || !!busy}
        title={canNudge ? "Post a polite reminder on the client's thread" : "Already nudged in the last 24 hours"}
        onClick={async () => {
          const r = await run("n", () => api.craft.nudge(deliverableId));
          if (r) {
            setSent(true);
            onChanged();
          }
        }}
        data-nudge={deliverableId}
      >
        {busy ? "Sending…" : canNudge ? "Nudge" : "Nudged today"}
      </Button>
      <ErrorLine error={error} />
    </span>
  );
}

export function TodayList({ v, onChanged }: { v: CraftManagerView; onChanged: () => void }) {
  const [kind, setKind] = useState<"all" | "team" | "clients">("all");
  const team = ["blocked", "overdue", "qc_failed", "unassigned"];
  const rows = v.today.filter((t) => kind === "all" || (kind === "team" ? team.includes(t.kind) : !team.includes(t.kind)));
  return (
    <Panel
      title="Today"
      subtitle="Team blockers, clients waiting on a reply and approvals to chase, most urgent first."
      action={
        <div className="flex border border-border text-xs">
          {(["all", "team", "clients"] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)} className={`px-2.5 py-1 ${kind === k ? "bg-charcoal text-ivory" : "text-ink-muted hover:text-ink"}`}>
              {k === "all" ? "All" : k === "team" ? "Team" : "Clients"}
            </button>
          ))}
        </div>
      }
      flush
    >
      {rows.length ? (
        <ul className="divide-y divide-border" data-today>
          {rows.map((t) => (
            <li key={t.id} className="flex items-start gap-3 px-5 py-3" data-today-kind={t.kind}>
              <span className="w-[74px] shrink-0 pt-0.5">
                <Badge tone={todayTone(t.kind)}>{todayLabel[t.kind]}</Badge>
              </span>
              <div className="min-w-0 flex-1">
                <Link href={t.href} className="block truncate text-sm font-medium hover:underline">
                  {t.title}
                </Link>
                <p className="text-xs text-ink-muted">
                  {t.client ? `${t.client} · ` : ""}
                  {t.detail}
                </p>
              </div>
              {t.kind === "approval" && t.deliverableId && <Nudge deliverableId={t.deliverableId} canNudge={!!t.canNudge} onChanged={onChanged} />}
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-5 pb-5">
          <Empty>Nothing needs you right now.</Empty>
        </div>
      )}
    </Panel>
  );
}

export function ClientPortfolio({ v, onChanged }: { v: CraftManagerView; onChanged: () => void }) {
  return (
    <Panel title="My clients" subtitle="Health, where each service is, what is waiting on the client and when you last spoke.">
      {v.clients.length ? (
        <div className="grid gap-4 xl:grid-cols-2" data-clients>
          {v.clients.map((c) => (
            <ClientCard key={c.id} c={c} onChanged={onChanged} />
          ))}
        </div>
      ) : (
        <Empty>No clients in your portfolio yet.</Empty>
      )}
    </Panel>
  );
}

function ClientCard({ c, onChanged }: { c: CraftClientCard; onChanged: () => void }) {
  const [noting, setNoting] = useState(false);
  const [notes, setNotes] = useState(c.notes);
  return (
    <article className="border border-border p-4" data-client={c.id}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link href={c.href} className="text-base font-semibold hover:underline">
            {c.name}
          </Link>
          <p className="text-xs text-ink-muted">
            {c.am ? `CM ${c.am} · ` : ""}
            {c.lastContact ? `Last contact ${ago(c.lastContact.at)} (${c.lastContact.by === "client" ? `from ${c.lastContact.author}` : "you replied"})` : "No messages yet"}
          </p>
        </div>
        <Badge tone={healthTone(c.health)}>Health: {c.health}</Badge>
      </header>

      <ul className="mb-3 space-y-2">
        {c.services.map((s) => (
          <li key={s.engagementId}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <Link href={s.href} className="truncate hover:underline">
                {s.service}
              </Link>
              <span className="shrink-0 text-xs text-ink-muted">
                Gate {s.gate} · {s.progress.done}/{s.progress.total} delivered
              </span>
            </div>
            <Meter value={s.progress.total ? (s.progress.done / s.progress.total) * 100 : 0} tone={s.progress.total && s.progress.done === s.progress.total ? "good" : "default"} />
            {s.milestone && <p className="mt-0.5 text-[11px] text-ink-muted">Next: {s.milestone}</p>}
          </li>
        ))}
      </ul>

      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <section>
          <h4 className="mb-1 text-[11px] uppercase tracking-[0.1em] text-ink-muted">Waiting on the client</h4>
          {c.approvals.length ? (
            <ul className="space-y-1.5">
              {c.approvals.slice(0, 4).map((a) => (
                <li key={a.deliverableId} className="flex items-center justify-between gap-2">
                  <Link href={a.href} className="min-w-0 truncate text-xs hover:underline">
                    {a.title}
                    <span className={`block ${a.daysWaiting >= 3 ? "text-red" : "text-ink-muted"}`}>
                      {a.daysWaiting} day{a.daysWaiting === 1 ? "" : "s"} waiting
                    </span>
                  </Link>
                  <Nudge deliverableId={a.deliverableId} canNudge={a.canNudge} onChanged={onChanged} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-muted">Nothing waiting.</p>
          )}
        </section>
        <section>
          <h4 className="mb-1 text-[11px] uppercase tracking-[0.1em] text-ink-muted">Open requests</h4>
          {c.requests.length ? (
            <ul className="space-y-1.5">
              {c.requests.slice(0, 4).map((r) => (
                <li key={r.id}>
                  <Link href={r.href} className="block truncate text-xs hover:underline">
                    {r.description}
                  </Link>
                  <span className={`text-[11px] ${r.overdue ? "font-medium text-red" : "text-ink-muted"}`}>
                    {r.replied ? r.status.replace(/_/g, " ") : r.overdue ? `Reply ${Math.abs(r.hoursLeft ?? 0)}h overdue` : r.hoursLeft !== null ? `Reply due in ${r.hoursLeft}h` : "Needs a reply"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-muted">No open requests.</p>
          )}
        </section>
        <section>
          <h4 className="mb-1 text-[11px] uppercase tracking-[0.1em] text-ink-muted">Next deliverables</h4>
          {c.nextDue.length ? (
            <ul className="space-y-1">
              {c.nextDue.map((d) => (
                <li key={d.deliverableId} className="flex justify-between gap-2 text-xs">
                  <Link href={d.href} className="truncate hover:underline">
                    {d.title}
                  </Link>
                  <span className="shrink-0 text-ink-muted">{dueLabel(d.due)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-muted">Nothing scheduled.</p>
          )}
        </section>
        <section>
          <h4 className="mb-1 text-[11px] uppercase tracking-[0.1em] text-ink-muted">Money</h4>
          {c.overdueInvoices.length ? (
            <ul className="space-y-1">
              {c.overdueInvoices.map((i) => (
                <li key={i.id} className="text-xs">
                  <span className="font-medium text-red">{i.number} overdue</span> · {rupees(i.totalPaise)} · {i.daysOverdue} days
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-muted">No overdue invoices.</p>
          )}
        </section>
      </div>

      {notes.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-border pt-2">
          {notes.slice(0, 2).map((n) => (
            <li key={n.id} className="text-xs">
              <span className="text-ink-muted">
                {n.kind === "call" ? "Call" : n.kind === "meeting" ? "Meeting" : "Note"} · {fmtDay(n.at)}
                {n.remindAt ? ` · reminder ${fmtDay(n.remindAt)} ${fmtTime(n.remindAt)}` : ""}:
              </span>{" "}
              {n.body}
            </li>
          ))}
        </ul>
      )}

      <footer className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3 text-xs">
        {c.threadId && (
          <Link href={`/team/messages/${c.threadId}`} className="border border-border px-2.5 py-1 hover:border-ink">
            Message client
          </Link>
        )}
        <Link href={c.href} className="border border-border px-2.5 py-1 hover:border-ink">
          Client 360
        </Link>
        <button className="border border-border px-2.5 py-1 hover:border-ink" onClick={() => setNoting((x) => !x)} data-log-note={c.id}>
          {noting ? "Close" : "Log call / note / meeting"}
        </button>
      </footer>
      {noting && (
        <NoteForm
          clientId={c.id}
          onDone={(n) => {
            setNotes((xs) => [n, ...xs]);
            setNoting(false);
            onChanged();
          }}
        />
      )}
    </article>
  );
}

function NoteForm({ clientId, onDone }: { clientId: string; onDone: (n: CraftClientCard["notes"][number]) => void }) {
  const [kind, setKind] = useState<CraftNoteKind>("call");
  const [body, setBody] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const { busy, error, run } = useAction();
  return (
    <form
      className="mt-3 grid gap-2 bg-canvas/40 p-3"
      data-note-form
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run("note", () => api.craftManager.addClientNote(clientId, { kind, body, remindAt: remindAt ? new Date(remindAt).toISOString() : null }));
        if (r) onDone(r);
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Select value={kind} onChange={(e) => setKind(e.target.value as CraftNoteKind)} aria-label="Note type">
          {CRAFT_NOTE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k === "call" ? "Call note" : k === "meeting" ? "Meeting reminder" : "Note"}
            </option>
          ))}
        </Select>
        {(kind === "meeting" || remindAt) && (
          <Input type="datetime-local" className="w-auto" required={kind === "meeting"} value={remindAt} onChange={(e) => setRemindAt(e.target.value)} aria-label="Remind me at" />
        )}
        {kind !== "meeting" && !remindAt && (
          <button type="button" className="text-xs text-ink-muted underline" onClick={() => setRemindAt(new Date(Date.now() + 86_400_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16))}>
            + reminder
          </button>
        )}
      </div>
      <textarea
        required
        minLength={2}
        maxLength={2000}
        rows={2}
        className="w-full border border-border bg-surface-raised px-3 py-2 text-sm"
        placeholder={kind === "meeting" ? "What is the meeting about?" : "What was discussed, what was promised?"}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="Note"
      />
      <div>
        <Button type="submit" className="px-3 py-1.5 text-xs" disabled={!!busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

export function TeamView({ v }: { v: CraftManagerView }) {
  const rows = v.team.rows;
  const busiest = rows
    .map((r) => ({ r, total: r.heat.reduce<number>((s, x) => s + (x ?? 0), 0) }))
    .sort((a, b) => b.total - a.total)[0];
  return (
    <Panel
      title="Team · next 2 weeks"
      subtitle="Planned hours per day (open tasks × 4h on their due day; overdue work counts today). Grey cells are approved leave."
      action={
        <CsvButton
          rows={rows}
          filename="team-workload"
          columns={[
            { header: "Person", value: (r) => r.name },
            { header: "Job role", value: (r) => r.specialtyLabel },
            ...v.team.dates.map((d, i) => ({ header: d, value: (r: (typeof rows)[number]) => (r.heat[i] === null ? "leave" : r.heat[i]) })),
            { header: "On-time %", value: (r) => r.onTimePct ?? "" },
            { header: "QC first pass %", value: (r) => r.qcFirstPassPct ?? "" },
          ]}
        />
      }
    >
      {rows.length ? (
        <>
          <Heatmap rows={rows.map((r) => r.name)} cols={v.team.days} values={rows.map((r) => r.heat)} format={(n) => `${n}`} cellTitle={(ri, ci, val) => `${rows[ri].name}, ${v.team.days[ci]}: ${val === null ? "on leave" : `${val}h planned${(val ?? 0) > 8 ? " (over a full day)" : ""}`}`} />
          {busiest && busiest.total > 0 && (
            <p className="mt-3 text-sm text-ink-muted">
              {busiest.r.name} has the most planned work ({busiest.total}h over 14 days). Spread new tasks to people with lighter rows.
            </p>
          )}
          <div className="-mx-5 mt-4 border-t border-border">
            <DataTable
              rows={rows}
              rowKey={(r) => r.userId}
              rowHref={(r) => r.href}
              columns={[
                { key: "n", header: "Person", cell: (r) => <span className="font-medium">{r.name}</span> },
                { key: "s", header: "Job role", cell: (r) => <span className="text-ink-muted">{r.specialtyLabel}</span> },
                { key: "o", header: "On-time (30d)", align: "right", cell: (r) => (r.onTimePct === null ? "—" : `${r.onTimePct}%`) },
                { key: "q", header: "QC first pass", align: "right", cell: (r) => (r.qcFirstPassPct === null ? "—" : `${r.qcFirstPassPct}%`) },
                { key: "d", header: "Done (30d)", align: "right", cell: (r) => r.done30 },
                { key: "l", header: "", align: "right", cell: () => <span className="text-xs underline">Dashboard</span> },
              ]}
            />
          </div>
        </>
      ) : (
        <Empty>No team members in your scope.</Empty>
      )}
    </Panel>
  );
}
