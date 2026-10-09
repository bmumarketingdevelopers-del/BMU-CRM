"use client";

import { useEffect, useMemo, useState, type DragEvent } from "react";
import Link from "next/link";
import { customFieldDisplay, formatINR, LEAD_STAGES, leadStageLabels, pipelineLabelMap, type LeadRow, type LeadStage, type PipelineStage } from "@bmu/shared";
import { Badge, Button, Input, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { useActions } from "@/components/actions/actions-provider";
import { BulkBar, BulkButton, useSelection } from "@/components/actions/bulk-bar";
import { ImportWizard } from "@/components/actions/import-wizard";
import { RowMenu } from "@/components/actions/row-menu";
import { SavedViewsMenu } from "@/components/actions/saved-views-menu";
import { CsvButton } from "@/components/charts";
import { AddButton, EmptyAdd, errMsg, GhostButton, ReasonDialog } from "@/components/ops/kit";
import { LOST_REASONS, useLeadActions } from "@/components/ops/lead-actions";
import { opsIsSalesManager } from "@bmu/shared";

const dFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const istDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
const name = (l: LeadRow) => l.contact.company || l.contact.name;

function followUpTone(at: string | null | undefined): { label: string; tone: "red" | "amber" | "neutral" } | null {
  if (!at) return null;
  const day = istDay(new Date(at));
  const today = istDay(new Date());
  if (day < today) return { label: `Follow-up overdue (${dFmt.format(new Date(at))})`, tone: "red" };
  if (day === today) return { label: "Follow up today", tone: "amber" };
  return { label: `Follow up ${dFmt.format(new Date(at))}`, tone: "neutral" };
}

type Filters = { q: string; owner: string; source: string; minScore: string; followUp: string; showClosed: boolean; cf?: Record<string, string> };
const EMPTY: Filters = { q: "", owner: "", source: "", minScore: "", followUp: "", showClosed: true, cf: {} };

/** v14: `?cf.<key>=<value>` in the address opens the board already filtered on a custom field. */
function cfFromUrl(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const out: Record<string, string> = {};
  new URLSearchParams(window.location.search).forEach((v, k) => {
    if (k.startsWith("cf.") && v) out[k.slice(3)] = v;
  });
  return out;
}

/** Whole days since a date. */
const daysSince = (iso?: string | null) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : 0);

/** Does a lead's custom value match a filter value (text: contains; others: equal)? */
function cfMatch(type: string, v: unknown, want: string) {
  if (v === undefined || v === null || v === "") return false;
  if (type === "checkbox") return (v === true) === (want === "yes");
  if (type === "text" || type === "long_text") return String(v).toLowerCase().includes(want.toLowerCase());
  if (type === "number" || type === "money") return Number(v) === Number(want);
  return String(v) === want;
}

/**
 * Leads as a board (drag a card between stages, or use the stage menu, which also works from the keyboard) or as a
 * list. Filters for search, owner, source, score and follow-ups. Moves show at once and roll back if the server refuses.
 * Managers (scope "all") can assign owners. Click a lead's name for its full history.
 */
export function LeadBoard({ canAssign }: { canAssign: boolean }) {
  const leads = useLoad(() => api.leads.list());
  const people = useLoad(() => (canAssign ? api.leads.assignees() : Promise.resolve([])));
  const pipeline = useLoad(() => api.pipelines.all().then((p) => p.pipelines.find((x) => x.kind === "lead")?.stages ?? null).catch(() => null), { live: ["PipelineConfig"] });
  const cfDefs = useLoad(() => api.customFields.list("lead").catch(() => []), { live: ["CustomFieldDef"] });
  const [error, setError] = useState<string>();
  const [rows, setRows] = useState<LeadRow[]>();
  const [source, setSource] = useState<LeadRow[]>();
  const [dragging, setDragging] = useState<string>();
  const [over, setOver] = useState<LeadStage>();
  const [view, setView] = useState<"board" | "list">("board");
  const [f, setF] = useState<Filters>(() => ({ ...EMPTY, cf: cfFromUrl() }));
  const [losing, setLosing] = useState<{ lead: LeadRow; reason: string }>();
  const { me, openNew, canNew, openReassign, notify, version, changed } = useActions();
  const manager = opsIsSalesManager(me);
  const [importing, setImporting] = useState(false);
  const [bulkAsk, setBulkAsk] = useState<"lost" | "archive" | null>(null);
  const [bulkStage, setBulkStage] = useState("");
  const leadActions = useLeadActions(() => leads.reload(), rows);
  const reload = leads.reload;
  useEffect(() => {
    if (version) reload();
  }, [version, reload]);
  if (leads.data && source !== leads.data) {
    setSource(leads.data);
    setRows(leads.data);
  }

  async function update(lead: LeadRow, change: { stage?: LeadStage; ownerId?: string | null }, lostReason?: string) {
    setError(undefined);
    if (change.stage === lead.stage) return;
    if (change.stage === "lost" && !lostReason) {
      setLosing({ lead, reason: "" });
      return;
    }
    // Optimistic: move the card now, put it back if the server says no.
    const before = lead;
    const owner = change.ownerId === undefined ? lead.owner : change.ownerId ? { id: change.ownerId, name: people.data?.find((u) => u.id === change.ownerId)?.name ?? "" } : null;
    setRows((r) => r?.map((x) => (x.id === lead.id ? { ...x, ...(change.stage ? { stage: change.stage, lostReason: change.stage === "lost" ? (lostReason ?? null) : null } : {}), owner } : x)));
    try {
      const saved = await api.leads.update(lead.id, { ...change, lostReason });
      setRows((r) => r?.map((x) => (x.id === saved.id ? saved : x)));
    } catch (e) {
      setRows((r) => r?.map((x) => (x.id === before.id ? before : x)));
      setError(`${name(lead)}: ${(e as Error).message}`);
    }
  }

  function onDrop(e: DragEvent, stage: LeadStage) {
    e.preventDefault();
    setOver(undefined);
    const id = e.dataTransfer.getData("text/plain") || dragging;
    setDragging(undefined);
    const lead = rows?.find((l) => l.id === id);
    if (lead) update(lead, { stage });
  }

  const sources = useMemo(() => [...new Set((rows ?? []).map((l) => l.source))].sort(), [rows]);
  const owners = useMemo(() => [...new Map((rows ?? []).filter((l) => l.owner).map((l) => [l.owner!.id, l.owner!.name])).entries()], [rows]);
  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    const today = istDay(new Date());
    return (rows ?? []).filter((l) => {
      if (q && ![l.contact.name, l.contact.company, l.contact.email, l.contact.phone, l.need].some((x) => x?.toLowerCase().includes(q))) return false;
      if (f.owner === "none" ? !!l.owner : f.owner && l.owner?.id !== f.owner) return false;
      if (f.source && l.source !== f.source) return false;
      if (f.minScore && l.score < Number(f.minScore)) return false;
      if (f.followUp === "due" && !(l.nextFollowUpAt && istDay(new Date(l.nextFollowUpAt)) <= today)) return false;
      if (f.followUp === "none" && l.nextFollowUpAt) return false;
      if (f.followUp === "duplicates" && !l.duplicateOfId) return false;
      if (!f.showClosed && (l.stage === "won" || l.stage === "lost")) return false;
      for (const [key, want] of Object.entries(f.cf ?? {})) {
        if (!want) continue;
        const def = cfDefs.data?.find((d) => d.key === key);
        if (!cfMatch(def?.type ?? "text", l.customFields?.[key], want)) return false;
      }
      return true;
    });
  }, [rows, f, cfDefs.data]);

  const filteredIds = useMemo(() => filtered.map((l) => l.id), [filtered]);
  const sel = useSelection(filteredIds);

  async function bulk(body: { action: "stage" | "lost" | "archive" | "tag"; stage?: string; reason?: string; tag?: string }) {
    setError(undefined);
    try {
      const r = await api.ops.leads.bulk({ ids: sel.ids, ...body } as Parameters<typeof api.ops.leads.bulk>[0]);
      notify(r.message, r.undo);
      sel.clear();
      changed();
      leads.reload();
    } catch (e) {
      setError(errMsg(e));
      throw e;
    }
  }

  if (!leads.data || !rows) return <LoadState loading={leads.loading} error={leads.error} />;
  const salesPeople = (people.data ?? []).filter((u) => u.roles.some((r) => r.baseRole.startsWith("sales") || r.baseRole === "founder"));
  const active = JSON.stringify({ ...f, cf: Object.fromEntries(Object.entries(f.cf ?? {}).filter(([, v]) => v)) }) !== JSON.stringify(EMPTY);
  const stages: PipelineStage[] = pipeline.data ?? LEAD_STAGES.map((key) => ({ key, label: leadStageLabels[key], hidden: false, requiredFields: [], targetDays: null }));
  const label = pipelineLabelMap(stages) as Record<LeadStage, string>;
  const stageOf = (key: string) => stages.find((x) => x.key === key);
  const filterable = (cfDefs.data ?? []).filter((d) => d.type !== "long_text" && d.type !== "date");
  const cfField = filterable.find((d) => d.key === Object.keys(f.cf ?? {}).find((k) => f.cf?.[k])) ?? null;
  const setCf = (key: string, value: string) => setF({ ...f, cf: key ? { [key]: value } : {} });
  const stageAge = (lead: LeadRow) => {
    const target = stageOf(lead.stage)?.targetDays;
    const days = daysSince(lead.stageSince);
    return target && lead.stage !== "won" && lead.stage !== "lost" && days > target ? { days, target } : null;
  };

  const stageSelect = (lead: LeadRow) => (
    <Select aria-label={`Move ${name(lead)} to stage`} value={lead.stage} disabled={lead.stage === "won"} onChange={(e) => update(lead, { stage: e.target.value as LeadStage })}>
      {stages
        .filter((s) => !s.hidden || s.key === lead.stage)
        .map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
    </Select>
  );
  const ownerSelect = (lead: LeadRow) =>
    canAssign && !lead.owner ? (
      <Select aria-label={`Owner of ${name(lead)}`} value="" onChange={(e) => update(lead, { ownerId: e.target.value || null })}>
        <option value="">Unassigned</option>
        {salesPeople.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </Select>
    ) : (
      <span className="self-center text-xs text-ink-muted">{lead.owner?.name ?? "Unassigned"}</span>
    );

  const addLead = canNew("lead") ? (stage?: LeadStage) => openNew("lead", stage ? { stage } : undefined, () => leads.reload()) : null;
  const menu = (lead: LeadRow) => <RowMenu label={`More actions for ${name(lead)}`} items={leadActions.items(lead, { withOpen: true })} />;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="lead-toolbar">
        {addLead && (
          <AddButton onClick={() => addLead()} testId="add-lead">
            + Add lead
          </AddButton>
        )}
        {manager && <GhostButton onClick={() => setImporting(true)}>Import CSV</GhostButton>}
        <CsvButton
          rows={filtered}
          filename="leads.csv"
          label="Export"
          columns={[
            { header: "Business", value: (l) => l.contact.company ?? "" },
            { header: "Contact", value: (l) => l.contact.name },
            { header: "Mobile", value: (l) => l.contact.phone ?? "" },
            { header: "Email", value: (l) => l.contact.email ?? "" },
            { header: "Source", value: (l) => l.source },
            { header: "Stage", value: (l) => label[l.stage] ?? l.stage },
            { header: "Owner", value: (l) => l.owner?.name ?? "" },
            { header: "Score", value: (l) => l.score },
            { header: "Budget (₹/month)", value: (l) => (l.budgetPaise ? l.budgetPaise / 100 : "") },
            { header: "Need", value: (l) => l.need },
            { header: "Added", value: (l) => l.createdAt.slice(0, 10) },
          ]}
        />
        <SavedViewsMenu entity="leads" filters={{ ...f, view }} onApply={(x) => {
          const { view: v2, ...rest } = x as Partial<Filters> & { view?: "board" | "list" };
          setF({ ...EMPTY, ...rest });
          if (v2) setView(v2);
        }} />
      </div>
      <ImportWizard entity="leads" open={importing} onClose={() => setImporting(false)} onDone={() => (leads.reload(), changed())} />
      {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
      {rows.length === 0 && (
        <EmptyAdd title="No leads yet" body="Leads from the website, ads and referrals land here." action={addLead ? <AddButton onClick={() => addLead()}>+ Add the first lead</AddButton> : undefined} />
      )}

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6" role="search" aria-label="Filter leads">
        <Input placeholder="Search name, phone, need…" aria-label="Search leads" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} className="lg:col-span-2" />
        <Select aria-label="Filter by owner" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}>
          <option value="">Any owner</option>
          <option value="none">Unassigned</option>
          {owners.map(([id, n]) => (
            <option key={id} value={id}>
              {n}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by source" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
          <option value="">Any source</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s.replace("_", " ")}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by score" value={f.minScore} onChange={(e) => setF({ ...f, minScore: e.target.value })}>
          <option value="">Any score</option>
          <option value="60">Hot (60+)</option>
          <option value="30">Warm (30+)</option>
        </Select>
        <Select aria-label="Filter by follow-up" value={f.followUp} onChange={(e) => setF({ ...f, followUp: e.target.value })}>
          <option value="">Any follow-up</option>
          <option value="due">Follow-up due</option>
          <option value="none">No follow-up set</option>
          <option value="duplicates">Possible duplicates</option>
        </Select>
        {filterable.length > 0 && (
          <div className="flex gap-2 sm:col-span-2 lg:col-span-6" data-testid="cf-filter">
            <Select aria-label="Filter by custom field" value={cfField?.key ?? ""} onChange={(e) => setCf(e.target.value, "")}>
              <option value="">Filter by a custom field…</option>
              {filterable.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </Select>
            {cfField &&
              (cfField.type === "select" || cfField.type === "checkbox" ? (
                <Select aria-label={`${cfField.label} value`} value={f.cf?.[cfField.key] ?? ""} onChange={(e) => setCf(cfField.key, e.target.value)}>
                  <option value="">Any</option>
                  {(cfField.type === "checkbox" ? ["yes", "no"] : cfField.options).map((o) => (
                    <option key={o} value={o}>
                      {cfField.type === "checkbox" ? (o === "yes" ? "Yes" : "No") : o}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input aria-label={`${cfField.label} value`} placeholder={cfField.type === "text" ? "Contains…" : "Equals…"} value={f.cf?.[cfField.key] ?? ""} onChange={(e) => setCf(cfField.key, e.target.value)} />
              ))}
          </div>
        )}
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
        <span>
          {filtered.length} of {rows.length} leads
          {active && (
            <button type="button" className="ml-2 underline" onClick={() => setF(EMPTY)}>
              Clear filters
            </button>
          )}
          <label className="ml-3 inline-flex items-center gap-1">
            <input type="checkbox" className="accent-[#8BB72C]" checked={f.showClosed} onChange={(e) => setF({ ...f, showClosed: e.target.checked })} /> Show won and lost
          </label>
        </span>
        <span className="flex gap-1" role="group" aria-label="View">
          {(["board", "list"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={`border px-3 py-1 ${view === v ? "border-charcoal bg-charcoal text-ivory" : "border-border"}`}>
              {v === "board" ? "Board" : "List"}
            </button>
          ))}
        </span>
      </div>

      {losing && (
        <div role="dialog" aria-label="Mark lead lost" className="mb-4 border border-red bg-surface-raised p-4">
          <p className="text-sm font-semibold">Why was {name(losing.lead)} lost?</p>
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (losing.reason.trim().length < 3) return setError("Give a reason of at least 3 letters");
              const l = losing;
              setLosing(undefined);
              update(l.lead, { stage: "lost" }, l.reason.trim());
            }}
          >
            <Select aria-label="Common reasons" value="" onChange={(e) => e.target.value && setLosing({ ...losing, reason: e.target.value })}>
              <option value="">Pick a common reason…</option>
              {["Budget too low", "Went with another agency", "No response after follow-ups", "Not a fit for our services", "Timing: not now"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
            <Input aria-label="Lost reason" placeholder="Or type the reason" value={losing.reason} onChange={(e) => setLosing({ ...losing, reason: e.target.value })} className="min-w-56 flex-1" />
            <Button type="submit">Mark lost</Button>
            <Button type="button" variant="ghost" onClick={() => setLosing(undefined)}>
              Cancel
            </Button>
          </form>
        </div>
      )}

      {view === "list" ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] bg-surface-raised text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                <th className="w-8 px-3 py-2">
                  <input type="checkbox" className="accent-[#8BB72C]" aria-label="Select all leads" checked={sel.allSelected} onChange={sel.toggleAll} />
                </th>
                <th className="px-3 py-2">Lead</th>
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Next follow-up</th>
                <th className="px-3 py-2">Stage</th>
                <th className="px-3 py-2">Owner</th>
                <th className="w-10 px-3 py-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((lead) => {
                const fu = followUpTone(lead.nextFollowUpAt);
                return (
                  <tr key={lead.id} className="border-b border-border align-top" data-lead={lead.id}>
                    <td className="px-3 py-2">
                      <input type="checkbox" className="accent-[#8BB72C]" aria-label={`Select ${name(lead)}`} checked={sel.has(lead.id)} onChange={() => sel.toggle(lead.id)} />
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/team/leads/${lead.id}`} className="font-medium underline-offset-2 hover:underline">
                        {name(lead)}
                      </Link>
                      {lead.duplicateOfId && <Badge tone="amber">possible duplicate</Badge>}
                      {stageAge(lead) && <Badge tone="amber">{stageAge(lead)!.days} days in stage</Badge>}
                      <span className="block text-xs text-ink-muted">{lead.need}</span>
                      {cfField && <span className="block text-xs">{cfField.label}: {customFieldDisplay(cfField, lead.customFields?.[cfField.key] as never)}</span>}
                    </td>
                    <td className="px-3 py-2">{lead.score}</td>
                    <td className="px-3 py-2 capitalize">{lead.source.replace("_", " ")}</td>
                    <td className="px-3 py-2">{fu ? <Badge tone={fu.tone}>{fu.label}</Badge> : <span className="text-xs text-ink-muted">None</span>}</td>
                    <td className="px-3 py-2">{stageSelect(lead)}</td>
                    <td className="px-3 py-2">{ownerSelect(lead)}</td>
                    <td className="px-3 py-2">{menu(lead)}</td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-ink-muted">
                    No leads match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-ink-muted">Drag a card to another column to move it, or use the stage menu on the card. Click a name for the full history.</p>
          <div className="flex gap-3 overflow-x-auto pb-4">
            {stages.map(({ key, hidden, targetDays }) => {
              const stage = key as LeadStage;
              const column = filtered.filter((l) => l.stage === stage);
              if (hidden && column.length === 0) return null;
              const target = over === stage && dragging && rows.find((l) => l.id === dragging)?.stage !== stage;
              if (!f.showClosed && (stage === "won" || stage === "lost")) return null;
              return (
                <section
                  key={stage}
                  aria-label={`${label[stage]} column`}
                  onDragOver={(e) => {
                    if (!dragging) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (over !== stage) setOver(stage);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(undefined);
                  }}
                  onDrop={(e) => onDrop(e, stage)}
                  className={`w-72 shrink-0 transition-colors ${target ? "bg-green/10 outline-1 outline-dashed outline-green" : ""}`}
                >
                  <h2 className="mb-2 flex items-center justify-between gap-2 border-b border-ink px-1 py-2 text-sm font-medium">
                    <span>
                      {label[stage]} <span className="text-ink-muted">{column.length}</span>
                      {targetDays && <span className="ml-1 text-[11px] font-normal text-ink-muted">· target {targetDays}d</span>}
                    </span>
                    {addLead && stage !== "won" && stage !== "lost" && (
                      <button type="button" className="text-xs font-normal underline" onClick={() => addLead(stage)} aria-label={`Add a lead to ${label[stage]}`}>
                        + Add
                      </button>
                    )}
                  </h2>
                  <div className="grid min-h-24 content-start gap-2">
                    {column.map((lead) => {
                      const fu = lead.stage !== "won" && lead.stage !== "lost" ? followUpTone(lead.nextFollowUpAt) : null;
                      const age = stageAge(lead);
                      return (
                        <article
                          key={lead.id}
                          draggable={lead.stage !== "won"}
                          onDragStart={(e) => {
                            e.dataTransfer.setData("text/plain", lead.id);
                            e.dataTransfer.effectAllowed = "move";
                            setDragging(lead.id);
                          }}
                          onDragEnd={() => {
                            setDragging(undefined);
                            setOver(undefined);
                          }}
                          data-lead={lead.id}
                          className={`border border-border bg-surface-raised p-3 text-sm ${lead.stage !== "won" ? "cursor-grab active:cursor-grabbing" : ""} ${dragging === lead.id ? "opacity-50" : ""}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="font-semibold">
                              <Link href={`/team/leads/${lead.id}`} className="underline-offset-2 hover:underline" draggable={false}>
                                {name(lead)}
                              </Link>
                            </h3>
                            <span className="flex items-center gap-1">
                              <Badge tone={lead.score >= 60 ? "green" : lead.score >= 30 ? "amber" : "neutral"}>{lead.score}</Badge>
                              {menu(lead)}
                            </span>
                          </div>
                          <p className="mt-1 text-ink-muted">{lead.need}</p>
                          <p className="mt-2 text-xs text-ink-muted">
                            {lead.budgetPaise ? `${formatINR(lead.budgetPaise)} budget · ` : ""}
                            {lead.contact.phone ?? lead.contact.email}
                            {lead.source !== "website" ? ` · ${lead.source.replace("_", " ")}` : ""}
                          </p>
                          {cfField && <p className="mt-1 text-xs">{cfField.label}: {customFieldDisplay(cfField, lead.customFields?.[cfField.key] as never)}</p>}
                          {(fu || lead.duplicateOfId || age) && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {age && <Badge tone="amber">{`${age.days} days in stage (target ${age.target})`}</Badge>}
                              {fu && <Badge tone={fu.tone}>{fu.label}</Badge>}
                              {lead.duplicateOfId && <Badge tone="amber">possible duplicate</Badge>}
                            </div>
                          )}
                          {lead.lostReason && <p className="mt-1 text-xs text-red">Lost: {lead.lostReason}</p>}
                          {lead.stage !== "won" && lead.stage !== "lost" && (
                            <Link href={`/team/proposals/new?lead=${lead.id}`} className="mt-2 inline-block text-xs font-semibold text-ink underline">
                              Create proposal
                            </Link>
                          )}
                          <div className="mt-3 flex flex-wrap gap-2">
                            {stageSelect(lead)}
                            {ownerSelect(lead)}
                          </div>
                        </article>
                      );
                    })}
                    {column.length === 0 && <p className="py-6 text-center text-xs text-ink-muted">{dragging ? "Drop here" : "No leads"}</p>}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
      {view === "list" && (
        <BulkBar count={sel.count} onClear={sel.clear} label="leads">
          <select
            aria-label="Move selected to stage"
            className="border border-ivory/40 bg-charcoal px-2 py-1 text-xs"
            value={bulkStage}
            onChange={(e) => {
              const st = e.target.value;
              setBulkStage("");
              if (st) bulk({ action: "stage", stage: st }).catch(() => undefined);
            }}
          >
            <option value="">Move to stage…</option>
            {(["new", "contacted", "discovery", "proposal_sent"] as const)
              .filter((st) => !stageOf(st)?.hidden)
              .map((st) => (
                <option key={st} value={st}>
                  {label[st]}
                </option>
              ))}
          </select>
          {manager && <BulkButton onClick={() => openReassign({ type: "lead_owner", ids: sel.ids, title: `Reassign ${sel.count} leads`, onDone: () => (sel.clear(), leads.reload()) })}>Reassign</BulkButton>}
          <BulkButton
            onClick={() => {
              const tag = window.prompt("Tag to add to the selected leads");
              if (tag?.trim()) bulk({ action: "tag", tag: tag.trim() }).catch(() => undefined);
            }}
          >
            Tag
          </BulkButton>
          <BulkButton onClick={() => setBulkAsk("lost")}>Mark lost</BulkButton>
          {manager && <BulkButton onClick={() => setBulkAsk("archive")}>Archive</BulkButton>}
        </BulkBar>
      )}
      <ReasonDialog open={bulkAsk === "lost"} title={`Mark ${sel.count} leads lost`} label="Lost reason" options={LOST_REASONS} confirm="Mark lost" danger onClose={() => setBulkAsk(null)} onConfirm={(reason) => bulk({ action: "lost", reason })} />
      <ReasonDialog open={bulkAsk === "archive"} title={`Archive ${sel.count} leads`} confirm="Archive" danger onClose={() => setBulkAsk(null)} onConfirm={(reason) => bulk({ action: "archive", reason })} />
      {leadActions.dialogs}
    </>
  );
}
