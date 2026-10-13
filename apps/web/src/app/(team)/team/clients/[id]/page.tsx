"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import {
  CLIENTS_OFFBOARD_CHECKS,
  clientRoleLabels,
  clientsOffboardStatusLabels,
  clientsQuoteStatusLabels,
  deliverableStatusLabels,
  formatINR,
  requestStatusLabels,
  requestTypeLabels,
  type Client360,
  type ClientsDetail,
  type ClientTeamRole,
  type DeliverableStatus,
  type RequestStatus,
  type RequestType,
} from "@bmu/shared";
import { useActions } from "@/components/actions/actions-provider";
import { ActionDialog, Field, inputCls } from "@/components/actions/action-drawer";
import { HistoryTab } from "@/components/actions/history-tab";
import { RowMenu, type RowMenuItem } from "@/components/actions/row-menu";
import { AddTaskButton } from "@/components/actions/tasks/add-task-button";
import { healthLabel, healthTone } from "@/components/clients-table";
import { BrandDialog, ChangeTierDialog, EditClientDrawer, HealthDialog, InviteUserDrawer, OffboardDialog, PauseDialog, SetGateDialog } from "@/components/clients/client-dialogs";
import { DataTable, Empty, Grid, Meter, Panel, StatRow, StatTile } from "@/components/dash";
import { ApprovalRuleCard } from "@/components/deliver/approval-rule";
import { JourneyPanel } from "@/components/flows/journey-timeline";
import { GateTrack } from "@/components/gate-track";
import { ago, fmtDate, fmtDay, human } from "@/components/workspace/format";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { UploadFilesButton } from "@/components/ops/upload-files-button";
import { CustomFieldsPanel } from "@/components/custom-fields-panel";
import { AdResults } from "@/components/integrations/ad-results";

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "services", label: "Services" },
  { value: "work", label: "Work" },
  { value: "requests", label: "Requests" },
  { value: "users", label: "Users" },
  { value: "brands", label: "Brands" },
  { value: "notes", label: "Notes" },
  { value: "billing", label: "Billing" },
  { value: "results", label: "Ads & website" },
  { value: "history", label: "History" },
] as const;
type Tab = (typeof TABS)[number]["value"];
type Service = ClientsDetail["services"][number];
type Modal = { kind: "edit" | "invite" | "brand" | "health" | "offboard" | "archive" } | { kind: "tier" | "pause" | "gate"; service: Service } | null;
type Notify = ReturnType<typeof useActions>["notify"];

const addCls = "border border-border bg-surface-raised px-3 py-1.5 text-sm hover:border-ink";
const roleName = (r: string) => clientRoleLabels[r as ClientTeamRole]?.name ?? human(r);

export default function Client360Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = use(params);
  const sp = use(searchParams);
  const { openNew, openReassign, notify, version, changed } = useActions();
  const [tab, setTabState] = useState<Tab>(TABS.some((t) => t.value === sp.tab) ? (sp.tab as Tab) : "overview");
  const [c, setC] = useState<Client360>();
  const [d, setD] = useState<ClientsDetail | null>();
  const [error, setError] = useState<string>();
  const [modal, setModal] = useState<Modal>(null);

  const load = useCallback(() => {
    api.workspace.client360(id).then(setC, (e: Error) => setError(e.message));
    api.clientsActions.get(id).then(setD, () => setD(null));
  }, [id]);
  useEffect(load, [load, version]);

  const setTab = (t: Tab) => {
    setTabState(t);
    const u = new URL(window.location.href);
    u.searchParams.set("tab", t);
    window.history.replaceState(null, "", u.toString());
  };
  const done = (m: string, undo?: Parameters<Notify>[1]) => {
    notify(m, undo);
    changed();
  };
  const fail = (e: Error) => notify(e.message, null, "error");

  if (!c)
    return (
      <div className="[&_.grid>*]:min-w-0">
        <Link href="/team/clients" className="text-sm text-ink-muted hover:text-ink">
          ← All clients
        </Link>
        <div className="mt-6">
          <LoadState loading={!error} error={error} />
        </div>
      </div>
    );

  const { stats } = c;
  const threadId = c.messages[0]?.threadId;
  const can = d?.can;
  const off = d?.offboarding ?? null;

  const addMenu: RowMenuItem[] = [
    { key: "task", label: "Task", onSelect: () => openNew("task", { clientId: id }, changed) },
    { key: "request", label: "Request", hidden: !can?.raiseRequest, onSelect: () => openNew("request", { clientId: id }, changed) },
    { key: "service", label: "Service", hidden: !can?.addService, onSelect: () => openNew("engagement", { clientId: id }, changed) },
    { key: "user", label: "User", hidden: !can?.inviteUser, onSelect: () => setModal({ kind: "invite" }) },
    { key: "brand", label: "Brand or location", hidden: !can?.addBrand, onSelect: () => setModal({ kind: "brand" }) },
    { key: "note", label: "Note", onSelect: () => openNew("note", { clientId: id }, changed) },
  ];
  const moreMenu: RowMenuItem[] = [
    { key: "health", label: "Set health", hidden: !can?.health, onSelect: () => setModal({ kind: "health" }) },
    { key: "approval", label: "Ask for approval", onSelect: () => openNew("approval", { clientId: id }, changed) },
    { key: "history", label: "View history", onSelect: () => setTab("history") },
    { key: "offboard", label: "Offboard client", hidden: !can?.offboard, danger: true, onSelect: () => setModal({ kind: "offboard" }) },
    { key: "archive", label: d?.archivedAt ? "Restore client" : "Archive client", hidden: !can?.archive, danger: !d?.archivedAt, onSelect: () => setModal({ kind: "archive" }) },
  ];

  return (
    <div className="[&_.grid>*]:min-w-0">
      <Link href="/team/clients" className="text-sm text-ink-muted hover:text-ink">
        ← All clients
      </Link>
      <PageTitle
        presence={{ entity: "ClientOrg", id: id }}
        title={c.client.name}
        subtitle={[c.client.industry, `Client since ${fmtDate.format(new Date(c.client.since))}`, `Account Manager: ${c.client.am?.name ?? "not assigned"}`].filter(Boolean).join(" · ")}
        action={
          <span className="flex flex-wrap items-center gap-2" data-testid="client360-actions">
            <Badge tone={healthTone(c.client.health)}>{healthLabel(c.client.health)}</Badge>
            {d?.paymentStatus === "pending" && <Badge tone="amber">Payment pending</Badge>}
            {d?.startMode === "migration" && <Badge>Migrated</Badge>}
            {d?.archivedAt && <Badge>Archived</Badge>}
            <span className="inline-flex items-center border border-charcoal bg-charcoal pl-3 text-sm font-medium text-ivory [&_button]:!text-ivory">
              + Add
              <RowMenu items={addMenu} label="Add to this client" />
            </span>
            {can?.edit && (
              <button type="button" className={addCls} onClick={() => setModal({ kind: "edit" })}>
                Edit
              </button>
            )}
            {can?.reassignAm && (
              <button type="button" className={addCls} onClick={() => openReassign({ type: "client_am", ids: [id], title: `Reassign Account Manager for ${c.client.name}`, onDone: () => changed() })}>
                Reassign AM
              </button>
            )}
            <UploadFilesButton prefill={{ clientId: c.client.id }} onSaved={changed} />
            <RowMenu items={moreMenu} />
          </span>
        }
      />

      {d?.readOnlyAccess && <p className="mb-4 border border-border bg-canvas px-4 py-2 text-sm">You handed this client over. You can read it for 7 days after the change but can&apos;t make changes.</p>}
      {d?.healthReason && c.client.health !== "green" && <p className="mb-4 text-sm text-ink-muted">Health: {d.healthReason}</p>}
      {d && off && <OffboardingPanel client={d} onDone={done} />}

      <div className="mb-6 max-w-full overflow-x-auto">
        <div className="inline-flex border border-border text-sm" role="tablist">
          {TABS.map((t) => (
            <button key={t.value} role="tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)} className={`px-3 py-1.5 whitespace-nowrap ${tab === t.value ? "bg-charcoal text-ivory" : "text-ink-muted hover:text-ink"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "overview" && (
        <div className="grid gap-6">
          <StatRow cols={5}>
            <StatTile label="Active services" value={stats.activeServices} />
            <StatTile label="Open requests" value={stats.openRequests} tone={stats.openRequests ? "warn" : "default"} />
            <StatTile label="Drafts with client" value={stats.draftsWaiting} hint="Waiting for their review" />
            <StatTile label="Outstanding" value={stats.outstandingPaise === null ? "—" : formatINR(stats.outstandingPaise)} tone={stats.outstandingPaise ? "warn" : "default"} hint={stats.outstandingPaise === null ? "Billing is not part of your access" : undefined} />
            <StatTile label="Last contact" value={stats.lastContactAt ? ago(stats.lastContactAt) : "—"} hint={stats.lastContactAt ? fmtDate.format(new Date(stats.lastContactAt)) : "No messages yet"} />
          </StatRow>
          {d && d.pendingApprovals.length > 0 && (
            <Panel title="Waiting for approval" subtitle="Requests for sign-off on this client" flush>
              <ul className="divide-y divide-border">
                {d.pendingApprovals.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                    <span className="min-w-0">{a.summary}</span>
                    <span className="shrink-0 text-xs text-ink-muted">{ago(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <CustomFieldsPanel entity="client" id={c.client.id} />
          <Panel title="Journey" subtitle="Every step per service, from proposal to final files, with planned and actual dates">
            <JourneyPanel clientId={c.client.id} />
          </Panel>
          <Grid>
            <Panel title="Contact">
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-ink-muted">Name</dt>
                <dd>{d?.contact.name ?? "—"}</dd>
                <dt className="text-ink-muted">Phone</dt>
                <dd>{d?.contact.phone ?? "—"}</dd>
                <dt className="text-ink-muted">Email</dt>
                <dd className="break-all">{d?.contact.email ?? "—"}</dd>
                <dt className="text-ink-muted">Branch</dt>
                <dd>{d?.branch?.name ?? "—"}</dd>
                <dt className="text-ink-muted">Added</dt>
                <dd>{d ? ({ proposal: "From a paid proposal", lead: "From a won lead", import: "Imported" } as Record<string, string>)[d.source] ?? "By hand" : "—"}</dd>
              </dl>
            </Panel>
            <ApprovalRuleCard clientOrgId={c.client.id} />
          </Grid>
        </div>
      )}

      {tab === "services" && (
        <div className="grid gap-6">
          <Panel title="Services" subtitle="Milestones G1 → G5 for each service" action={can?.addService ? <button type="button" className={addCls} onClick={() => openNew("engagement", { clientId: id }, changed)}>+ Add service</button> : undefined} flush>
            {c.services.length ? (
              <ul className="divide-y divide-border">
                {c.services.map((s) => {
                  const sd = d?.services.find((x) => x.id === s.id);
                  return (
                    <li key={s.id} className="grid gap-4 px-5 py-4 md:grid-cols-[1.2fr_2fr_0.8fr_2rem] md:items-center" data-service-row={s.id}>
                      <div>
                        <Link href={`/team/projects/${s.id}`} className="font-medium hover:underline">
                          {s.serviceName}
                        </Link>
                        <p className="text-xs text-ink-muted capitalize">
                          {s.tier} · {s.billingType.replace("_", "-")} · {human(s.status)}
                        </p>
                        <p className="mt-1 flex flex-wrap gap-1">
                          {sd?.paymentPending && <Badge tone="amber">Waiting for first payment</Badge>}
                          {sd?.migrated && <Badge>Migrated at {sd.currentGate}</Badge>}
                          {sd?.pausedUntil && <Badge tone="amber">Paused until {fmtDay.format(new Date(sd.pausedUntil))}</Badge>}
                        </p>
                      </div>
                      <GateTrack track={s.track} />
                      <div>
                        <p className="mb-1 text-xs text-ink-muted">
                          {s.approved} of {s.total} approved
                        </p>
                        <Meter value={s.total ? (s.approved / s.total) * 100 : 0} tone={s.total && s.approved === s.total ? "good" : "default"} />
                      </div>
                      {sd && (
                        <RowMenu
                          label={`Actions for ${s.serviceName}`}
                          items={[
                            { key: "open", label: "Open project", href: `/team/projects/${s.id}` },
                            { key: "task", label: "Add task", onSelect: () => openNew("task", { clientId: id, engagementId: s.id }, changed) },
                            { key: "request", label: "Raise request", hidden: !can?.raiseRequest, onSelect: () => openNew("request", { clientId: id, engagementId: s.id }, changed) },
                            { key: "tier", label: "Change tier", hidden: !can?.changeTier || ["closed", "offboarding"].includes(sd.status), onSelect: () => setModal({ kind: "tier", service: sd }) },
                            { key: "pause", label: "Pause service", hidden: !can?.pause || !!sd.pausedUntil || ["closed", "offboarding", "delivered", "paused"].includes(sd.status), onSelect: () => setModal({ kind: "pause", service: sd }) },
                            { key: "resume", label: "Resume service", hidden: !can?.pause || !sd.pausedUntil, onSelect: () => api.clientsActions.resume(sd.id).then((r) => done(r.message), fail) },
                            { key: "gate", label: "Set current gate", hidden: !can?.setGate || !sd.migrated, onSelect: () => setModal({ kind: "gate", service: sd }) },
                          ]}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty>No services yet.</Empty>
            )}
          </Panel>
          {d && d.quotes.length > 0 && (
            <Panel title="Quotes" subtitle="New services and tier changes the client approves and pays" flush>
              <ul className="divide-y divide-border" data-testid="quotes">
                {d.quotes.map((q) => (
                  <li key={q.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {q.kind === "add_service" ? `Add ${q.serviceName}` : `${q.serviceName}: ${q.fromTier} → ${q.tier}`} <span className="font-normal text-ink-muted capitalize">· {q.tier}</span>
                      </p>
                      <p className="text-xs text-ink-muted">
                        {formatINR(q.amountPaise)} due{q.monthlyDiffPaise !== null ? ` · ${q.monthlyDiffPaise >= 0 ? "+" : ""}${formatINR(q.monthlyDiffPaise)} a month` : ""} · {clientsQuoteStatusLabels[q.status].team} · by {q.requestedBy}
                        {q.requestedByClient ? " (client)" : ""}
                      </p>
                    </div>
                    <span className="flex gap-2">
                      {q.status === "requested" && (
                        <button type="button" className={addCls} onClick={() => api.clientsActions.sendQuote(q.id).then(() => done("Quote sent to the client"), fail)}>
                          Send to client
                        </button>
                      )}
                      {["requested", "sent"].includes(q.status) && (
                        <button type="button" className="px-2 py-1.5 text-sm text-ink-muted hover:text-ink" onClick={() => api.clientsActions.cancelQuote(q.id).then(() => done("Quote cancelled"), fail)}>
                          Cancel
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}

      {tab === "work" && (
        <Panel title="Work in progress" subtitle="Deliverables not yet approved" action={<AddTaskButton prefill={{ clientId: id }} onSaved={changed} />} flush>
          <DataTable
            rows={c.deliverables}
            rowKey={(x) => x.id}
            rowHref={(x) => `/team/deliverables/${x.id}`}
            empty="Nothing in progress."
            columns={[
              {
                key: "t",
                header: "Deliverable",
                cell: (x) => (
                  <span>
                    {x.title}
                    <span className="block text-xs font-normal text-ink-muted">{x.serviceName}</span>
                  </span>
                ),
              },
              { key: "s", header: "Status", cell: (x) => <Badge tone={x.status === "changes_requested" || x.status === "qc_failed" ? "amber" : x.status === "ready_for_client" ? "green" : "neutral"}>{deliverableStatusLabels[x.status as DeliverableStatus] ?? human(x.status)}</Badge> },
              { key: "d", header: "Due", align: "right", cell: (x) => (x.dueAt ? <span className={x.overdue ? "font-medium text-red" : ""}>{fmtDay.format(new Date(x.dueAt))}</span> : "—") },
            ]}
          />
        </Panel>
      )}

      {tab === "requests" && (
        <Panel
          title="Requests"
          action={
            <span className="flex items-center gap-3">
              {can?.raiseRequest && (
                <button type="button" className={addCls} onClick={() => openNew("request", { clientId: id }, changed)}>
                  + Add request
                </button>
              )}
              <Link href="/team/requests" className="text-xs text-ink-muted hover:text-ink">
                Requests inbox →
              </Link>
            </span>
          }
          flush
        >
          <DataTable
            rows={c.requests}
            rowKey={(r) => r.id}
            rowHref={(r) => `/team/requests/${r.id}`}
            empty="No requests yet."
            columns={[
              {
                key: "d",
                header: "Request",
                cell: (r) => (
                  <span className="line-clamp-1 max-w-[16rem]">
                    {r.description}
                    <span className="block text-xs font-normal text-ink-muted">{requestTypeLabels[r.type as RequestType]?.team ?? r.type}</span>
                  </span>
                ),
              },
              { key: "s", header: "Status", cell: (r) => <Badge tone={r.status === "done" ? "green" : r.status === "declined" ? "red" : "neutral"}>{requestStatusLabels[r.status as RequestStatus]?.team ?? human(r.status)}</Badge> },
              { key: "a", header: "Raised", align: "right", cell: (r) => fmtDay.format(new Date(r.createdAt)) },
            ]}
          />
        </Panel>
      )}

      {tab === "users" && (
        <div className="grid gap-6">
          <Panel
            title="Client users"
            action={
              can?.inviteUser ? (
                <button type="button" className={addCls} onClick={() => setModal({ kind: "invite" })}>
                  + Invite user
                </button>
              ) : undefined
            }
            flush
          >
            {(d?.users ?? c.users).length ? (
              <ul className="divide-y divide-border">
                {(d?.users ?? c.users).map((u) => (
                  <li key={u.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{u.name}</p>
                      <p className="truncate text-xs text-ink-muted">{u.email}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {u.status === "suspended" && <Badge tone="red">Deactivated</Badge>}
                      {u.status === "invited" && <Badge tone="amber">Invited</Badge>}
                      <Badge tone="dark">{roleName(u.role)}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No client users yet.</Empty>
            )}
          </Panel>
          {d && d.pendingInvites.length > 0 && (
            <Panel title="Waiting for the Owner to confirm" subtitle="Owners invited by the Account Manager need the client's Owner or a Branch Manager to confirm" flush>
              <ul className="divide-y divide-border">
                {d.pendingInvites.map((p) => (
                  <li key={p.approvalId} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                    <span className="min-w-0">
                      {p.name} <span className="text-xs text-ink-muted">· {p.email ?? p.phone} · asked by {p.requestedBy}</span>
                    </span>
                    <Badge tone="amber">{roleName(p.role)}</Badge>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}

      {tab === "brands" && (
        <Panel
          title="Brands and locations"
          action={
            can?.addBrand ? (
              <button type="button" className={addCls} onClick={() => setModal({ kind: "brand" })}>
                + Add brand
              </button>
            ) : undefined
          }
          flush
        >
          {d?.brands.length ? (
            <ul className="divide-y divide-border">
              {d.brands.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{b.name}</span>
                    {b.address && <span className="block text-xs text-ink-muted">{b.address}</span>}
                  </span>
                  {can?.addBrand && (
                    <button type="button" className="text-xs text-ink-muted hover:text-red" onClick={() => api.clientsActions.removeBrand(id, b.id).then(() => done(`${b.name} removed`), fail)}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No brands or locations yet.</Empty>
          )}
        </Panel>
      )}

      {tab === "notes" && (
        <Panel
          title="Messages and notes"
          action={
            <span className="flex items-center gap-3">
              <button type="button" className={addCls} onClick={() => openNew("note", { clientId: id }, changed)}>
                + Add note
              </button>
              {threadId && (
                <Link href={`/team/messages/${threadId}`} className="text-xs text-ink-muted hover:text-ink">
                  Open conversation →
                </Link>
              )}
            </span>
          }
        >
          {c.messages.length ? (
            <ul className="space-y-4">
              {c.messages.map((m) => (
                <li key={m.id} className={`border-l-2 pl-3 ${m.internal ? "border-amber" : m.fromClient ? "border-green" : "border-border"}`}>
                  <p className="text-xs text-ink-muted">
                    <span className="font-medium text-ink">{m.author}</span> · {ago(m.at)}
                    {m.internal && " · internal note"}
                  </p>
                  <Link href={`/team/messages/${m.threadId}`} className="mt-0.5 line-clamp-2 block text-sm hover:underline">
                    {m.body}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No messages yet.</Empty>
          )}
        </Panel>
      )}

      {tab === "billing" && (
        <div className="grid gap-6">
          {d && (
            <Panel
              title="Billing details"
              action={
                can?.editFields.some((f) => ["billingName", "gstin", "billingAddress", "billingEmail"].includes(f)) ? (
                  <button type="button" className={addCls} onClick={() => setModal({ kind: "edit" })}>
                    Edit
                  </button>
                ) : undefined
              }
            >
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-ink-muted">Billing name</dt>
                <dd>{d.billing.billingName ?? "—"}</dd>
                <dt className="text-ink-muted">GSTIN</dt>
                <dd>{d.billing.gstin ?? "—"}</dd>
                <dt className="text-ink-muted">Address</dt>
                <dd>{d.billing.billingAddress ?? "—"}</dd>
                <dt className="text-ink-muted">Billing email</dt>
                <dd className="break-all">{d.billing.billingEmail ?? "—"}</dd>
              </dl>
            </Panel>
          )}
          {c.invoices ? (
            <Panel title="Invoices" subtitle={`${formatINR(c.invoices.paidPaise)} received in total`} flush>
              <DataTable
                rows={c.invoices.recent}
                rowKey={(i) => i.id}
                empty="No invoices yet."
                columns={[
                  { key: "n", header: "Invoice", cell: (i) => <span className="font-medium">{i.number}</span> },
                  { key: "s", header: "Status", cell: (i) => <Badge tone={i.status === "paid" ? "green" : i.status === "overdue" ? "red" : i.status === "draft" ? "neutral" : "amber"}>{human(i.status)}</Badge> },
                  { key: "d", header: "Due", cell: (i) => fmtDay.format(new Date(i.dueDate)) },
                  { key: "t", header: "Balance", align: "right", cell: (i) => formatINR(i.totalPaise - i.paidPaise) },
                ]}
              />
            </Panel>
          ) : (
            <Empty>Invoices are not part of your access.</Empty>
          )}
          <Panel title="Files" flush>
            <FileList files={c.files} />
          </Panel>
        </div>
      )}

      {tab === "results" && <AdResults audience="team" load={() => api.integrations.results({ clientOrgId: id })} />}

      {tab === "history" && (
        <div className="max-w-3xl">
          <HistoryTab entity="ClientOrg" id={id} assignments={d?.amHistory} />
        </div>
      )}

      {d && modal?.kind === "edit" && <EditClientDrawer client={d} open onClose={() => setModal(null)} onDone={(m, undo) => done(m, undo)} />}
      {d && modal?.kind === "invite" && <InviteUserDrawer client={d} open onClose={() => setModal(null)} onDone={done} />}
      {d && modal?.kind === "health" && <HealthDialog client={d} open onClose={() => setModal(null)} onDone={done} />}
      {d && modal?.kind === "offboard" && <OffboardDialog client={d} open onClose={() => setModal(null)} onDone={done} />}
      {d && modal?.kind === "tier" && <ChangeTierDialog client={d} engagementId={modal.service.id} open onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "pause" && <PauseDialog service={modal.service} open onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "gate" && <SetGateDialog service={modal.service} open onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "brand" && (
        <BrandDialog
          open
          onClose={() => setModal(null)}
          onSave={async (input) => {
            await api.clientsActions.addBrand(id, input);
            done(`${input.name} added`);
            return `${input.name} added`;
          }}
        />
      )}
      {d && modal?.kind === "archive" && <ArchiveDialog client={d} onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}

function OffboardingPanel({ client, onDone }: { client: ClientsDetail; onDone: (m: string) => void }) {
  const o = client.offboarding!;
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const allDone = CLIENTS_OFFBOARD_CHECKS.every((k) => o.checklist[k.key].done);
  const run = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    setError(undefined);
    try {
      await fn();
      onDone(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <section className="mb-6 border border-red/50 bg-surface-raised px-5 py-4 text-sm" data-testid="offboarding-panel">
      <p className="font-semibold">{clientsOffboardStatusLabels[o.status]}</p>
      <p className="text-xs text-ink-muted">
        {o.reason} · last cycle {o.lastCycle}
        {o.readOnlyUntil && ` · client users read-only until ${fmtDay.format(new Date(o.readOnlyUntil))}`}
      </p>
      {o.status !== "requested" && (
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {CLIENTS_OFFBOARD_CHECKS.map((k) => {
            const item = o.checklist[k.key];
            return (
              <li key={k.key}>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={item.done}
                    disabled={o.status !== "in_progress" || busy === k.key}
                    onChange={(e) => run(k.key, () => api.clientsActions.offboardTick(client.id, { key: k.key, done: e.target.checked }), e.target.checked ? `${k.label}: done` : `${k.label}: reopened`)}
                  />
                  <span>
                    {k.label}
                    {item.done && item.by && <span className="block text-xs text-ink-muted">by {item.by}</span>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {o.status === "in_progress" && (
        <button type="button" disabled={!allDone || !!busy} onClick={() => run("complete", () => api.clientsActions.offboardComplete(client.id), "Checklist complete. The client is asked to confirm receipt.")} className="mt-3 bg-charcoal px-3 py-1.5 text-sm font-medium text-ivory disabled:opacity-40">
          Ask the client to confirm
        </button>
      )}
      {error && <p className="mt-2 text-red">{error}</p>}
    </section>
  );
}

function ArchiveDialog({ client, onClose, onDone }: { client: ClientsDetail; onClose: () => void; onDone: (m: string, undo?: Parameters<Notify>[1]) => void }) {
  const restore = !!client.archivedAt;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.clientsActions.bulk({ ids: [client.id], action: restore ? "restore" : "archive", reason: reason.trim() || undefined });
      onDone(r.message, r.undo);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog
      open
      title={restore ? `Restore ${client.name}` : `Archive ${client.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={`px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40 ${restore ? "bg-charcoal" : "bg-red"}`} disabled={busy || (!restore && reason.trim().length < 3)} onClick={submit}>
            {restore ? "Restore" : "Archive"}
          </button>
          <button type="button" className="border border-border px-3 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      {restore ? (
        <p className="text-sm text-ink-muted">The client comes back to the Clients list.</p>
      ) : (
        <Field label="Reason" required>
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
        </Field>
      )}
      {error && <p className="text-sm text-red">{error}</p>}
    </ActionDialog>
  );
}

function FileList({ files }: { files: { id: string; name: string; kind: string; url: string; at: string }[] }) {
  if (!files.length) return <Empty>No files yet.</Empty>;
  return (
    <ul className="divide-y divide-border">
      {files.map((f) => (
        <li key={f.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
          <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">
            {f.name}
          </a>
          <span className="shrink-0 text-xs text-ink-muted capitalize">
            {f.kind} · {fmtDay.format(new Date(f.at))}
          </span>
        </li>
      ))}
    </ul>
  );
}
