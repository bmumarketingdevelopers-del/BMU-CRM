"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ActivityFeed } from "@/components/activity-feed";
import { deliverableStatusLabels, planStatusLabels, type DeliverableStatus, type PlanContent, type EngagementDetail, type RequirementItemView } from "@bmu/shared";
import { day, engagementStatus } from "@/components/engagements-table";
import { PlanEditor } from "@/components/plan-editor";
import { AiPanel } from "@/components/ai/ai-panel";
import { PlanComments, PlanContentView } from "@/components/plan-view";
import { Badge, Button, Card, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { ProjectBriefLink } from "@/components/comms/doc-list";
import { ProjectMoney } from "@/components/money/project-money";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ApprovalStatusBox } from "@/components/deliver/approval-status";
import { CyclesPanel } from "@/components/deliver/cycles-panel";
import { ProjectHandoffPanel } from "@/components/deliver/handoff";
import { FeedbackSummary, HandoverContents } from "@/components/deliver/handover";
import { Panel } from "@/components/dash";
import type { DeliverHandoverView } from "@bmu/shared";
import { AddTaskButton } from "@/components/actions/tasks/add-task-button";
import { UploadFilesButton } from "@/components/ops/upload-files-button";
import { CustomFieldsPanel, RecordWorkflows } from "@/components/custom-fields-panel";

const reqTone = { received: "green", pending: "neutral", waiting: "amber", blocked: "red" } as const;
const reqLabel = { received: "Received", pending: "Not sent yet", waiting: "Client sent, check it", blocked: "Blocked" };
const DONE_D = ["approved", "scheduled", "published"];

/** Client notes can hold links and uploaded files (/api/files/…): show them as links. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/((?:https?:\/\/|\/api\/files\/)\S+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^(https?:\/\/|\/api\/files\/)/.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="underline">
            {p.startsWith("/api/files/") ? "open file" : p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export default function EngagementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const e = useLoad(() => api.engagements.get(id));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<EngagementDetail>();
  const handover = useLoad(() => api.deliver.handover(id));
  const [handoverFresh, setHandoverFresh] = useState<DeliverHandoverView>();
  const [now] = useState(() => Date.now());
  const [aiPlan, setAiPlan] = useState<{ n: number; content: PlanContent }>();

  async function act(fn: () => Promise<EngagementDetail>) {
    setBusy(true);
    setError(undefined);
    try {
      setFresh(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const v = fresh ?? e.data;
  if (!v) return <LoadState loading={e.loading} error={e.error} />;
  const cycle = v.cycle;
  const manage = v.can.markRcd;
  const allReceived = !!cycle && cycle.requirements.length > 0 && cycle.requirements.every((r) => r.status === "received");

  return (
    <>
      <PageTitle
        presence={{ entity: "Engagement", id: id }}
        title={v.client.name}
        subtitle={`${v.serviceName} · ${v.tier} · Client Manager: ${v.am?.name ?? "unassigned"}`}
        action={
          <span className="flex flex-wrap items-center gap-3">
            <AddTaskButton prefill={{ engagementId: v.id }} onSaved={() => e.reload()} />
            <UploadFilesButton prefill={{ engagementId: v.id }} />
            <Link href="/team/projects" className="text-sm underline">
              All projects
            </Link>
          </span>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="dark">{v.currentGate}</Badge>
        <span className="capitalize">{engagementStatus(v.status)}</span>
        {cycle?.rcdAt && <span className="text-ink-muted">· Project start date (RCD) {day.format(new Date(cycle.rcdAt))}</span>}
        {cycle?.planningDue && <span className="text-ink-muted">· Plan due {day.format(new Date(cycle.planningDue))}</span>}
      </div>
      <div className="mb-6">
        <ProjectBriefLink engagementId={v.id} title={`${v.client.name} ${v.serviceName}`} text={`Goal:\n\nAudience:\n\nKey message:\n\nDeliverables:\n\nMust include:\n\nTone and look:\n\nReferences:\n`} />
      </div>
      <div className="mb-6">
        <ProjectMoney clientId={v.client.id} engagementId={v.id} />
      </div>
      {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Onboarding checklist</h2>
            {cycle?.rcdAt ? <Badge tone="green">Gate 1 passed</Badge> : <Badge tone="amber">Gate 1 open</Badge>}
          </div>
          <ul className="divide-y divide-border">
            {cycle?.requirements.map((r) => (
              <RequirementRow key={r.id} r={r} editable={manage} busy={busy} onUpdate={(input) => act(() => api.engagements.updateRequirement(r.id, input))} />
            ))}
          </ul>
          {manage && (
            <>
              <AddItem busy={busy} onAdd={(label, type) => act(() => api.engagements.addRequirement(v.id, label, type))} />
              <div className="mt-4 border-t border-border pt-4">
                <Button disabled={busy || !allReceived} onClick={() => act(() => api.engagements.markRcd(v.id))}>
                  Mark RCD and start planning
                </Button>
                <p className="mt-2 text-xs text-ink-muted">
                  {allReceived ? "Sets today as the project start date. The plan is due in 4 working days." : "Every item must be received first."}
                </p>
              </div>
            </>
          )}
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Plan</h2>
            {v.plan && <Badge tone={v.plan.status === "approved" ? "green" : "neutral"}>{planStatusLabels[v.plan.status]}</Badge>}
          </div>
          {!cycle?.rcdAt ? (
            <p className="text-sm text-ink-muted">Planning starts once the project start date (RCD) is marked.</p>
          ) : v.can.editPlan ? (
            <>
              {v.plan && <PlanComments plan={v.plan} />}
              <AiPanel
                className="mb-4"
                feature="plan_draft"
                targetId={v.id}
                title="Draft the plan with AI"
                description="Uses the services sold, requirements received and the client's industry. Insert fills the form below; nothing is saved until you click Save."
                buttonLabel="Draft plan"
                insertLabel="Fill the plan form"
                onInsert={(_text, r) => {
                  if (r.data?.kind === "plan") setAiPlan((p) => ({ n: (p?.n ?? 0) + 1, content: r.data!.value as PlanContent }));
                  else throw new Error("This draft has no plan fields to insert. Copy the parts you need instead.");
                }}
              />
              <PlanEditor
                key={`${v.plan?.id ?? "new"}-${aiPlan?.n ?? 0}`}
                initial={aiPlan?.content ?? v.plan?.content ?? null}
                busy={busy}
                onSave={(c) => act(() => api.engagements.savePlan(v.id, c))}
                onSubmit={(c) => act(async () => (await api.engagements.savePlan(v.id, c), api.engagements.submitPlan(v.id)))}
              />
            </>
          ) : v.plan ? (
            <>
              <PlanContentView content={v.plan.content} />
              <PlanComments plan={v.plan} />
              {v.plan.approvalStatus && v.plan.status === "sent_to_client" && (
                <div className="mt-4">
                  <ApprovalStatusBox status={v.plan.approvalStatus} remind={{ target: "plan", id: v.plan.id }} />
                </div>
              )}
              {v.plan.approvedAt && (
                <p className="mt-4 text-sm">
                  Approved by {v.plan.approvedBy} on {day.format(new Date(v.plan.approvedAt))}. The plan is locked; changes go through an extra request.
                </p>
              )}
              {v.can.sendPlan && (
                <Button className="mt-4" disabled={busy} onClick={() => act(() => api.engagements.sendPlan(v.id))}>
                  Approve and send to client
                </Button>
              )}
            </>
          ) : (
            <p className="text-sm text-ink-muted">The strategist hasn&apos;t started the plan yet.</p>
          )}
        </Card>
      </div>

      {v.deliverables.length > 0 && (
        <Card className="mt-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Deliverables {cycle?.period && cycle.period !== "project" ? `· ${cycle.period}` : ""}</h2>
            <span className="text-xs text-ink-muted">
              {v.deliverables.filter((d) => DONE_D.includes(d.status)).length} of {v.deliverables.length} approved
            </span>
          </div>
          <ul className="divide-y divide-border text-sm">
            {v.deliverables.map((d) => {
              const open = !DONE_D.includes(d.status) && d.status !== "ready_for_client";
              const late = open && !!d.dueAt && new Date(d.dueAt).getTime() < now;
              const soon = open && !late && !!d.dueAt && new Date(d.dueAt).getTime() < now + 36 * 3_600_000;
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/team/deliverables/${d.id}`} className="hover:underline">
                    <span className="capitalize text-ink-muted">{d.type}</span> · {d.title}
                  </Link>
                  <span className="flex items-center gap-2">
                    {d.dueAt && <span className={`text-xs ${late ? "font-semibold text-[#b4432c]" : "text-ink-muted"}`}>Due {day.format(new Date(d.dueAt))}</span>}
                    {late && <Badge tone="red">Overdue</Badge>}
                    {soon && <Badge tone="amber">Due soon</Badge>}
                    <span>{deliverableStatusLabels[d.status as DeliverableStatus] ?? engagementStatus(d.status)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {v.deliverables.length > 0 && <ProjectHandoffPanel engagementId={v.id} />}

      <CyclesPanel
        engagementId={v.id}
        onStarted={() => {
          setFresh(undefined);
          e.reload();
        }}
      />

      {(handoverFresh ?? handover.data) && ((handoverFresh ?? handover.data)!.files.length > 0 || ["G4", "G5"].includes(v.currentGate)) && (
        <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <Panel title="Final delivery and handover pack" subtitle="What the client receives at Gate 5: approved final files, links and logins, downloadable as one zip.">
            <HandoverContents v={(handoverFresh ?? handover.data)!} onChange={setHandoverFresh} />
          </Panel>
          <Panel title="Client feedback" subtitle="Asked after the final sign-off (score 0 to 10). Feeds Client Health.">
            <FeedbackSummary v={(handoverFresh ?? handover.data)!} />
            {(handoverFresh ?? handover.data)!.feedback.average !== null && <p className="mt-3 text-xs text-ink-muted">Average {(handoverFresh ?? handover.data)!.feedback.average}/10</p>}
          </Panel>
        </div>
      )}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <CustomFieldsPanel entity="engagement" id={id} />
        <RecordWorkflows entity="Engagement" id={id} />
      </div>
      <div className="mt-6">
        <ActivityFeed entity="Engagement" id={id} subtitle="Who did what, when: gates, plan, requirements, deliverables and requests" />
      </div>
    </>
  );
}

function RequirementRow({
  r,
  editable,
  busy,
  onUpdate,
}: {
  r: RequirementItemView;
  editable: boolean;
  busy: boolean;
  onUpdate: (input: { status: string; blockedReason?: string; waitingFor?: string }) => void;
}) {
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState("");
  const [waitingFor, setWaitingFor] = useState("");
  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {r.label} <span className="text-xs capitalize text-ink-muted">· {r.type}</span>
        </span>
        <Badge tone={reqTone[r.status]}>{reqLabel[r.status]}</Badge>
      </div>
      {r.clientNote && (
        <p className="mt-1 break-all text-xs">
          Client sent: <Linkified text={r.clientNote} />
        </p>
      )}
      {r.status === "blocked" && (
        <p className="mt-1 text-xs text-ink-muted">
          {r.blockedReason}
          {r.waitingFor && ` · waiting for ${r.waitingFor}`}
        </p>
      )}
      {editable && r.status !== "received" && !blocking && (
        <div className="mt-2 flex gap-2">
          <Button variant="secondary" className="py-1" disabled={busy} onClick={() => onUpdate({ status: "received" })}>
            Mark received
          </Button>
          <Button variant="ghost" className="py-1" disabled={busy} onClick={() => setBlocking(true)}>
            Mark blocked
          </Button>
        </div>
      )}
      {blocking && (
        <form
          className="mt-2 grid gap-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            onUpdate({ status: "blocked", blockedReason: reason, waitingFor: waitingFor || undefined });
            setBlocking(false);
          }}
        >
          <Input value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="Why is it blocked? (required)" minLength={3} required />
          <Input value={waitingFor} onChange={(ev) => setWaitingFor(ev.target.value)} placeholder="Waiting for whom? (optional)" />
          <div className="flex gap-2">
            <Button type="submit" className="py-1" disabled={busy}>
              Save
            </Button>
            <Button type="button" variant="ghost" className="py-1" onClick={() => setBlocking(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

function AddItem({ busy, onAdd }: { busy: boolean; onAdd: (label: string, type: string) => void }) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState("info");
  return (
    <form
      className="mt-3 flex flex-wrap gap-2"
      onSubmit={(ev) => {
        ev.preventDefault();
        onAdd(label, type);
        setLabel("");
      }}
    >
      <Input className="min-w-[180px] flex-1" value={label} onChange={(ev) => setLabel(ev.target.value)} placeholder="Add an item to collect" minLength={2} required />
      <Select value={type} onChange={(ev) => setType(ev.target.value)} aria-label="Item type">
        <option value="info">Info</option>
        <option value="asset">Asset</option>
        <option value="access">Access</option>
        <option value="payment">Payment</option>
      </Select>
      <Button type="submit" variant="secondary" disabled={busy}>
        Add
      </Button>
    </form>
  );
}
