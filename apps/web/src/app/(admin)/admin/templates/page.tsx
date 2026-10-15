"use client";

import { useState } from "react";
import { DEPARTMENTS, type FlowStep, type FlowTemplateView, type QcTemplateView } from "@bmu/shared";
import { DELIVERABLE_TYPES } from "@/components/plan-editor";
import { Button, Card, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { useActionsMaybe } from "@/components/actions/actions-provider";

/** Founders and Branch Managers publish straight away; department heads' saves go to a Branch Manager to approve (v11). */
function useCanPublish() {
  const me = useActionsMaybe()?.me;
  return !me || me.roles.some((r) => r === "founder" || r === "admin");
}

const ROLES = [
  ["am", "Client's Client Manager"],
  ["strategist", "Strategist"],
  ["producer", "Producer"],
  ["qc_reviewer", "QC Reviewer"],
  ["department_head", "Department Head"],
  ["intern", "Intern"],
] as const;
const KINDS = [
  ["work", "Work"],
  ["qc", "QC checkpoint"],
  ["client_review", "Client review"],
] as const;

export default function TemplatesPage() {
  const flows = useLoad(() => api.templates.flows());
  const qc = useLoad(() => api.templates.qc());
  return (
    <>
      <PageTitle
        title="Flow templates and QC checklists"
        subtitle="When a client approves a plan, each deliverable gets tasks from the matching flow. Saving creates a new version; tasks already created keep the old one."
      />
      {!flows.data ? <LoadState loading={flows.loading} error={flows.error} /> : <div className="grid gap-4">{flows.data.map((f) => <FlowEditor key={`${f.key}-${f.version}`} flow={f} />)}</div>}
      <h2 id="qc" className="mt-10 mb-3 font-display text-xl">
        QC checklists
      </h2>
      {!qc.data ? <LoadState loading={qc.loading} error={qc.error} /> : <div className="grid gap-4 md:grid-cols-2">{qc.data.map((c) => <QcEditor key={`${c.key}-${c.version}`} list={c} />)}</div>}
    </>
  );
}

function FlowEditor({ flow }: { flow: FlowTemplateView }) {
  const canPublish = useCanPublish();
  const [name, setName] = useState(flow.name);
  const [department, setDepartment] = useState(flow.department);
  const [types, setTypes] = useState(flow.deliverableTypes);
  const [steps, setSteps] = useState<FlowStep[]>(flow.steps);
  const [version, setVersion] = useState(flow.version);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const set = (i: number, patch: Partial<FlowStep>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setSteps(next);
  };
  const total = steps.reduce((s, x) => s + x.days, 0);

  async function save() {
    setMsg(undefined);
    try {
      const saved = await api.templates.saveFlow(flow.key, { name, department, deliverableTypes: types, steps });
      setVersion(saved.find((f) => f.key === flow.key)?.version ?? version);
      setMsg({ ok: true, text: canPublish ? "Saved as a new version." : "Sent to a Branch Manager to publish. The current version stays live until then." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-xs text-ink-muted">Flow name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-ink-muted">Department</span>
          <Select value={department} onChange={(e) => setDepartment(e.target.value)}>
            {DEPARTMENTS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </Select>
        </label>
        <span className="ml-auto text-xs text-ink-muted">
          v{version} · {total} working days end to end
        </span>
      </div>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <span className="text-ink-muted">Used for:</span>
        {DELIVERABLE_TYPES.map((t) => (
          <label key={t} className="flex items-center gap-1 capitalize">
            <input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))} />
            {t}
          </label>
        ))}
      </div>

      {/* Visual flow: one box per step, in order */}
      <ol className="mb-3 flex flex-wrap items-center gap-1 text-xs">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-1">
            <span className={`px-2 py-1 ${s.kind === "qc" ? "bg-amber/50 text-charcoal" : s.kind === "client_review" ? "bg-green/30" : "bg-canvas text-charcoal"}`}>
              {s.name} · {s.days}d
            </span>
            {i < steps.length - 1 && <span className="text-ink-muted">→</span>}
          </li>
        ))}
      </ol>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-muted">
              <th className="py-1">Step</th>
              <th>Owner</th>
              <th>Working days</th>
              <th>Type</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={i} className="border-t border-border">
                <td className="py-1 pr-2">
                  <Input className="py-1" value={s.name} onChange={(e) => set(i, { name: e.target.value })} />
                </td>
                <td className="pr-2">
                  <Select value={s.role} onChange={(e) => set(i, { role: e.target.value })}>
                    {ROLES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="pr-2">
                  <Input className="w-20 py-1" type="number" min={0} max={30} value={s.days} onChange={(e) => set(i, { days: Number(e.target.value) })} />
                </td>
                <td className="pr-2">
                  <Select value={s.kind} onChange={(e) => set(i, { kind: e.target.value as FlowStep["kind"] })}>
                    {KINDS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="whitespace-nowrap text-right">
                  <Button variant="ghost" className="px-1" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                    ↑
                  </Button>
                  <Button variant="ghost" className="px-1" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                    ↓
                  </Button>
                  <Button variant="ghost" className="px-1" onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove">
                    ✕
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setSteps([...steps, { key: `step${Date.now() % 100000}`, name: "New step", role: "producer", days: 1, kind: "work" }])}>
          Add step
        </Button>
        <Button onClick={save}>Save new version</Button>
        {msg && <span className={`text-sm ${msg.ok ? "text-ink-muted" : "text-red"}`}>{msg.text}</span>}
      </div>
    </Card>
  );
}

function QcEditor({ list }: { list: QcTemplateView }) {
  const canPublish = useCanPublish();
  const [name, setName] = useState(list.name);
  const [items, setItems] = useState(list.items.join("\n"));
  const [version, setVersion] = useState(list.version);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  async function save() {
    try {
      const saved = await api.templates.saveQc(list.key, { name, items: items.split("\n").map((s) => s.trim()).filter(Boolean) });
      setVersion(saved.find((c) => c.key === list.key)?.version ?? version);
      setMsg({ ok: true, text: canPublish ? "Saved." : "Sent to a Branch Manager to publish. The current version stays live until then." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="font-semibold" />
        <span className="shrink-0 text-xs text-ink-muted">v{version}</span>
      </div>
      <textarea className="w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={6} value={items} onChange={(e) => setItems(e.target.value)} />
      <p className="text-xs text-ink-muted">One check per line.</p>
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={save}>Save</Button>
        {msg && <span className={`text-sm ${msg.ok ? "text-ink-muted" : "text-red"}`}>{msg.text}</span>}
      </div>
    </Card>
  );
}
