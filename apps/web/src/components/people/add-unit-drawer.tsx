"use client";

/**
 * AddUnitDrawer: "+ Add team" on the hierarchy tree (and + New → Team or pod). Creates a branch (with its working-hours
 * calendar), a department (head, branch, default flow templates and QC checklists copied in), a team (lead) or a
 * client pod (CM, strategist, producers, clients: new tasks for those clients default to pod members).
 *
 * Prefill keys: kind (branch | department | team | pod), branchId, departmentId.
 */
import { useState } from "react";
import { api } from "@/lib/api";
import { ActionDrawer, Field, inputCls } from "../actions/action-drawer";
import type { NewDrawerProps } from "../actions/new-registry";
import { usePeopleOptions } from "./use-people-options";

type Kind = "branch" | "department" | "team" | "pod";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const KIND_LABEL: Record<Kind, string> = { branch: "Branch", department: "Department", team: "Team", pod: "Client pod" };

function Multi({ label, options, value, onChange, testId }: { label: string; options: { id: string; name: string; note?: string }[]; value: string[]; onChange: (v: string[]) => void; testId?: string }) {
  const [q, setQ] = useState("");
  const rows = options.filter((o) => !q.trim() || o.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="border border-border" data-testid={testId}>
      {options.length > 8 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}`} aria-label={`Search ${label.toLowerCase()}`} className="w-full border-b border-border bg-surface-raised px-3 py-1.5 text-sm outline-none" />}
      <ul className="max-h-40 overflow-y-auto py-1">
        {rows.map((o) => (
          <li key={o.id}>
            <label className="flex items-center gap-2 px-3 py-0.5 text-xs">
              <input type="checkbox" checked={value.includes(o.id)} onChange={() => onChange(value.includes(o.id) ? value.filter((x) => x !== o.id) : [...value, o.id])} />
              <span>{o.name}</span>
              {o.note && <span className="text-ink-muted">· {o.note}</span>}
            </label>
          </li>
        ))}
        {!rows.length && <li className="px-3 py-2 text-xs text-ink-muted">Nothing to pick.</li>}
      </ul>
    </div>
  );
}

export function AddUnitDrawer({ open, onClose, prefill, onSaved }: NewDrawerProps) {
  const { opts, error: optsError } = usePeopleOptions(open);
  const kinds: Kind[] = opts ? [...(opts.can.addUnit ? (["branch", "department", "team"] as Kind[]) : []), ...(opts.can.addPod ? (["pod"] as Kind[]) : [])] : [];
  const [kind, setKind] = useState<Kind>((prefill?.kind as Kind) ?? "team");
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("19:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [branchId, setBranchId] = useState(prefill?.branchId ?? "");
  const [departmentId, setDepartmentId] = useState(prefill?.departmentId ?? "");
  const [headId, setHeadId] = useState("");
  const [flows, setFlows] = useState<string[]>([]);
  const [qcs, setQcs] = useState<string[]>([]);
  const [amId, setAmId] = useState("");
  const [strategistId, setStrategistId] = useState("");
  const [producers, setProducers] = useState<string[]>([]);
  const [clients, setClients] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const shownKind = kinds.length && !kinds.includes(kind) ? kinds[0] : kind;
  const staff = opts?.staff ?? [];
  const byRole = (...roles: string[]) => staff.filter((s) => s.roles.some((r) => roles.includes(r)));

  async function save() {
    setError(undefined);
    setSaving(true);
    try {
      const r =
        shownKind === "branch"
          ? await api.peopleActions.createUnit({ kind: "branch", name, city, workingHours: { start, end, days } })
          : shownKind === "department"
            ? await api.peopleActions.createUnit({ kind: "department", name, branchId: branchId || opts?.branches[0]?.id || "", headUserId: headId, copyFlowTemplateIds: flows, copyQcChecklistIds: qcs })
            : shownKind === "team"
              ? await api.peopleActions.createUnit({ kind: "team", name, departmentId, leadUserId: headId })
              : await api.peopleActions.createPod({ name, amUserId: amId, strategistUserId: strategistId, producerIds: producers, clientIds: clients });
      onSaved(r.id ?? undefined, r.message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionDrawer open={open} title={`Add ${KIND_LABEL[shownKind].toLowerCase()}`} subtitle="Branches, departments, teams and client pods" onClose={onClose} onSubmit={save} saving={saving} error={error ?? optsError} saveLabel={`Create ${KIND_LABEL[shownKind].toLowerCase()}`} testId="add-unit-drawer">
      {!opts && !optsError && <p className="text-sm text-ink-muted">Loading…</p>}
      {opts && (
        <>
          {kinds.length > 1 && (
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="What to add">
              {kinds.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={shownKind === k} onClick={() => setKind(k)} className={`border px-3 py-1.5 text-xs ${shownKind === k ? "border-charcoal bg-charcoal text-ivory" : "border-border hover:border-ink"}`}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          )}
          <Field label={`${KIND_LABEL[shownKind]} name`} required htmlFor="au-name">
            <input id="au-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {shownKind === "branch" && (
            <>
              <Field label="City" required htmlFor="au-city">
                <input id="au-city" className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} />
              </Field>
              <Field label="Working hours" required hint="The branch's calendar for deadlines and SLAs">
                <div className="flex flex-wrap items-center gap-2">
                  <input type="time" className={`${inputCls} w-32`} value={start} onChange={(e) => setStart(e.target.value)} aria-label="Opens at" />
                  <span className="text-xs">to</span>
                  <input type="time" className={`${inputCls} w-32`} value={end} onChange={(e) => setEnd(e.target.value)} aria-label="Closes at" />
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {DAYS.map((d, i) => (
                    <label key={d} className={`cursor-pointer border px-2 py-1 text-xs ${days.includes(i) ? "border-charcoal bg-charcoal text-ivory" : "border-border"}`}>
                      <input type="checkbox" className="sr-only" checked={days.includes(i)} onChange={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())} />
                      {d}
                    </label>
                  ))}
                </div>
              </Field>
            </>
          )}
          {shownKind === "department" && (
            <>
              <Field label="Branch" required htmlFor="au-branch">
                <select id="au-branch" className={inputCls} value={branchId || opts.branches[0]?.id || ""} onChange={(e) => setBranchId(e.target.value)}>
                  {opts.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} · {b.city}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Department head" required htmlFor="au-head">
                <select id="au-head" className={inputCls} value={headId} onChange={(e) => setHeadId(e.target.value)}>
                  <option value="">Pick the head</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Default flow templates" hint="Copied into the new department; edit them later in Department Flow Templates">
                <Multi label="Flow templates" options={opts.flowTemplates.map((f) => ({ id: f.id, name: f.name, note: f.department }))} value={flows} onChange={setFlows} />
              </Field>
              <Field label="QC checklists" hint="Copied into the new department">
                <Multi label="QC checklists" options={opts.qcChecklists.map((q) => ({ id: q.id, name: q.name, note: q.department ?? undefined }))} value={qcs} onChange={setQcs} />
              </Field>
            </>
          )}
          {shownKind === "team" && (
            <>
              <Field label="Department" required htmlFor="au-dept">
                <select id="au-dept" className={inputCls} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                  <option value="">Pick the department</option>
                  {opts.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {opts.branches.length > 1 ? ` (${opts.branches.find((b) => b.id === d.branchId)?.name})` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Team lead" required htmlFor="au-lead">
                <select id="au-lead" className={inputCls} value={headId} onChange={(e) => setHeadId(e.target.value)}>
                  <option value="">Pick the lead</option>
                  {staff.filter((s) => !departmentId || s.departmentId === departmentId).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          {shownKind === "pod" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Client manager" required htmlFor="au-am">
                  <select id="au-am" className={inputCls} value={amId} onChange={(e) => setAmId(e.target.value)}>
                    <option value="">Pick the CM</option>
                    {byRole("account_manager", "am_lead").map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Strategist" required htmlFor="au-strat">
                  <select id="au-strat" className={inputCls} value={strategistId} onChange={(e) => setStrategistId(e.target.value)}>
                    <option value="">Pick the strategist</option>
                    {byRole("strategist", "department_head").map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Producers" required>
                <Multi label="Producers" testId="pod-producers" options={byRole("producer", "intern", "qc_reviewer").map((s) => ({ id: s.id, name: s.name, note: opts.departments.find((d) => d.id === s.departmentId)?.name }))} value={producers} onChange={setProducers} />
              </Field>
              <Field label="Clients" required hint="New tasks for these clients go to pod members by default">
                <Multi label="Clients" testId="pod-clients" options={opts.clients.map((c) => ({ id: c.id, name: c.name, note: c.podId ? "in another pod" : undefined }))} value={clients} onChange={setClients} />
              </Field>
            </>
          )}
        </>
      )}
    </ActionDrawer>
  );
}
