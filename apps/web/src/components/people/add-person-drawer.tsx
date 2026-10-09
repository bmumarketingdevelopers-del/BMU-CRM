"use client";

/**
 * AddPersonDrawer: "+ New → Person", "+ Add person" on any hierarchy node and "+ Add" on Admin → Users.
 * Required: full name, mobile, email, role(s) with a permission preview, department, team/pod (when the department
 * has teams), reporting manager, branch, joining date, employment type. Then the onboarding checklist choice and the
 * invite (SMS + email). Department Heads' adds go to an Admin for approval.
 *
 * Prefill keys: departmentId, teamId, managerId, branchId.
 */
import { useMemo, useState } from "react";
import {
  CRAFT_SPECIALTY_OPTIONS,
  PEOPLE_EMPLOYMENT_TYPES,
  PEOPLE_ONBOARDING_CHOICES,
  peopleEmploymentLabels,
  peopleMergePermissions,
  peopleOnboardingLabels,
  peopleScopeLabels,
  PEOPLE_CAPABILITY_LABELS,
  type PeopleEmploymentType,
  type PeopleOnboardingChoice,
  type PeopleOptions,
} from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDrawer, Field, TextArea, inputCls, useDraftAutosave, type SaveMode } from "../actions/action-drawer";
import { DuplicateWarning } from "../actions/duplicate-warning";
import type { NewDrawerProps } from "../actions/new-registry";
import { todayIst, usePeopleOptions } from "./use-people-options";

type Values = {
  name: string;
  phone: string;
  email: string;
  roleId: string;
  extraRoleIds: string[];
  departmentId: string;
  teamId: string;
  managerId: string;
  branchId: string;
  joiningDate: string;
  employmentType: PeopleEmploymentType;
  onboarding: boolean;
  onboardingItems: PeopleOnboardingChoice[];
  buddyId: string;
  sendInvite: boolean;
  specialty: string;
  note: string;
};

const initial = (p: NewDrawerProps["prefill"] = {}): Values => ({
  name: "",
  phone: "",
  email: "",
  roleId: "",
  extraRoleIds: [],
  departmentId: p.departmentId ?? "",
  teamId: p.teamId ?? "",
  managerId: p.managerId ?? "",
  branchId: p.branchId ?? "",
  joiningDate: todayIst(),
  employmentType: "full_time",
  onboarding: true,
  onboardingItems: [...PEOPLE_ONBOARDING_CHOICES],
  buddyId: "",
  sendInvite: true,
  specialty: "",
  note: "",
});

/** Department → its branch, a single team picked for you, and a sensible manager (team lead, else department head). */
function resolvePlacement(x: Values, opts: PeopleOptions | undefined): Values {
  if (!opts) return x;
  const d = opts.departments.find((y) => y.id === x.departmentId);
  if (!d) return x.departmentId || !opts.me.departmentId || !opts.can.addNeedsApproval ? x : resolvePlacement({ ...x, departmentId: opts.me.departmentId }, opts);
  const t = d.teams.find((y) => y.id === x.teamId) ?? (d.teams.length === 1 && !x.teamId ? d.teams[0] : undefined);
  return { ...x, branchId: d.branchId, teamId: t?.id ?? "", managerId: x.managerId || t?.leadId || d.headId || "" };
}

export function AddPersonDrawer({ open, onClose, prefill, onSaved }: NewDrawerProps) {
  const { opts, error: optsError } = usePeopleOptions(open);
  const [raw, setV] = useState<Values>(() => initial(prefill));
  const v = useMemo(() => resolvePlacement(raw, opts), [raw, opts]);
  const [errors, setErrors] = useState<Partial<Record<keyof Values, string>>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((x) => ({ ...x, [k]: val }));
  const draftKey = `new${prefill?.departmentId ? `:${prefill.departmentId}` : ""}${prefill?.teamId ? `:${prefill.teamId}` : ""}`;
  const draft = useDraftAutosave({ entity: "person", key: draftKey, values: raw as unknown as Record<string, unknown>, enabled: open, onRestore: (d) => setV({ ...initial(prefill), ...(d as unknown as Values) }) });

  const dept = opts?.departments.find((d) => d.id === v.departmentId);
  const team = dept?.teams.find((t) => t.id === v.teamId);

  const roles = opts?.roles ?? [];
  const chosenRoles = roles.filter((r) => r.id === v.roleId || v.extraRoleIds.includes(r.id));
  const perms = useMemo(() => Object.entries(peopleMergePermissions(chosenRoles)).filter(([, s]) => s !== "none"), [chosenRoles]);
  const needsFounder = chosenRoles.some((r) => r.needsApproval);
  const staffInBranch = opts?.staff ?? [];

  function validate() {
    const e: Partial<Record<keyof Values, string>> = {};
    if (v.name.trim().length < 2) e.name = "Enter their full name";
    if (!/^(\+?91)?[6-9]\d{9}$/.test(v.phone.replace(/[\s-]/g, ""))) e.phone = "Enter a 10-digit Indian mobile number";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) e.email = "Enter a valid email address";
    if (!v.roleId) e.roleId = "Pick their role";
    if (!v.departmentId) e.departmentId = "Pick a department";
    if (dept && dept.teams.length && !v.teamId) e.teamId = `Pick a team or pod in ${dept.name}`;
    if (!v.managerId) e.managerId = "Pick who they report to";
    if (!v.branchId) e.branchId = "Pick a branch";
    if (!v.joiningDate) e.joiningDate = "Pick the joining date";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function save(mode: SaveMode) {
    setError(undefined);
    if (!validate()) return;
    setSaving(true);
    try {
      const r = await api.peopleActions.add({
        name: v.name.trim(),
        phone: v.phone.trim(),
        email: v.email.trim(),
        roleIds: [v.roleId, ...v.extraRoleIds.filter((id) => id !== v.roleId)],
        departmentId: v.departmentId,
        teamId: v.teamId || null,
        managerId: v.managerId,
        branchId: v.branchId,
        joiningDate: v.joiningDate,
        employmentType: v.employmentType,
        specialty: v.specialty || null,
        onboarding: { enabled: v.onboarding, items: v.onboardingItems, buddyId: v.buddyId || null },
        sendInvite: v.sendInvite,
        note: v.note.trim() || undefined,
      });
      draft.clear();
      onSaved(r.id ?? undefined, r.outcome === "approval" ? `${r.message}: ${v.name.trim()}` : r.message);
      if (mode === "another") setV((x) => ({ ...initial(prefill), departmentId: x.departmentId, teamId: x.teamId, managerId: x.managerId, branchId: x.branchId, roleId: x.roleId, joiningDate: x.joiningDate, employmentType: x.employmentType }));
      else onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const toggleItem = (k: PeopleOnboardingChoice) => set("onboardingItems", v.onboardingItems.includes(k) ? v.onboardingItems.filter((x) => x !== k) : [...v.onboardingItems, k]);
  const where = [dept?.name, team?.name].filter(Boolean).join(" · ");

  return (
    <ActionDrawer
      open={open}
      title="Add person"
      subtitle={where ? `Into ${where}` : "A new team member, invited by SMS and email"}
      onClose={onClose}
      onSubmit={save}
      saving={saving}
      error={error ?? optsError}
      allowAnother
      saveLabel={opts?.can.addNeedsApproval || needsFounder ? "Send for approval" : v.sendInvite ? "Add and invite" : "Add person"}
      banner={draft.banner}
      testId="add-person-drawer"
      footerNote={opts?.can.addNeedsApproval ? "You are a Department Head: an Admin approves before the person is added." : needsFounder ? "Joining as Admin needs the Founder's approval." : v.sendInvite ? "They get an SMS and an email with a link to sign in. Status: Invited." : null}
      more={
        <>
          <Field label="Specialty" hint="Picks their specialist dashboard (optional)">
            <select className={inputCls} value={v.specialty} onChange={(e) => set("specialty", e.target.value)} aria-label="Specialty">
              <option value="">None</option>
              {CRAFT_SPECIALTY_OPTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note for the approver or HR">
            <TextArea value={v.note} onChange={(e) => set("note", e.target.value)} maxLength={500} />
          </Field>
        </>
      }
    >
      {!opts && !optsError && <p className="text-sm text-ink-muted">Loading…</p>}
      {opts && (
        <>
          <Field label="Full name" required error={errors.name} htmlFor="ap-name">
            <input id="ap-name" className={inputCls} value={v.name} onChange={(e) => set("name", e.target.value)} autoComplete="off" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Mobile" required error={errors.phone} htmlFor="ap-phone">
              <input id="ap-phone" className={inputCls} inputMode="tel" placeholder="98765 43210" value={v.phone} onChange={(e) => set("phone", e.target.value)} />
            </Field>
            <Field label="Email" required error={errors.email} htmlFor="ap-email">
              <input id="ap-email" className={inputCls} type="email" value={v.email} onChange={(e) => set("email", e.target.value)} />
            </Field>
          </div>
          <DuplicateWarning
            value={`${v.email}|${v.phone}|${v.name}`}
            minLength={6}
            noun="person"
            search={() => api.peopleActions.duplicates({ email: v.email, phone: v.phone, name: v.name }).then((r) => r.map((d) => ({ id: d.id, label: d.name, sub: `Same ${d.match}${d.status !== "active" ? ` · ${d.status}` : ""}`, href: `/admin/users/${d.id}` })))}
          />
          <Field label="Role" required error={errors.roleId} htmlFor="ap-role">
            <select id="ap-role" className={inputCls} value={v.roleId} onChange={(e) => set("roleId", e.target.value)}>
              <option value="">Pick a role</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id} disabled={!r.assignable} title={r.whyNot ?? undefined}>
                  {r.name}
                  {r.needsApproval ? " (Founder approves)" : ""}
                  {!r.assignable ? " (not allowed)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <details className="text-sm">
            <summary className="cursor-pointer text-xs font-medium">Secondary roles {v.extraRoleIds.length ? `(${v.extraRoleIds.length})` : ""}</summary>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {roles
                .filter((r) => r.assignable && r.id !== v.roleId)
                .map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={v.extraRoleIds.includes(r.id)} onChange={() => set("extraRoleIds", v.extraRoleIds.includes(r.id) ? v.extraRoleIds.filter((x) => x !== r.id) : [...v.extraRoleIds, r.id])} />
                    {r.name}
                  </label>
                ))}
            </div>
          </details>
          {perms.length > 0 && (
            <div className="border border-border bg-canvas/40 px-3 py-2" data-testid="permission-preview">
              <p className="mb-1 text-xs font-medium">What they will be able to do</p>
              <ul className="grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
                {perms.map(([cap, scope]) => (
                  <li key={cap} className="flex justify-between gap-2">
                    <span>{PEOPLE_CAPABILITY_LABELS[cap] ?? cap}</span>
                    <span className="text-ink-muted">{peopleScopeLabels[scope]}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Department" required error={errors.departmentId} htmlFor="ap-dept">
              <select id="ap-dept" className={inputCls} value={v.departmentId} onChange={(e) => setV((x) => ({ ...x, departmentId: e.target.value, teamId: "", managerId: "" }))}>
                <option value="">Pick a department</option>
                {opts.branches.map((b) => (
                  <optgroup key={b.id} label={b.name}>
                    {opts.departments
                      .filter((d) => d.branchId === b.id)
                      .map((d) => (
                        <option key={d.id} value={d.id} disabled={opts.can.addNeedsApproval && d.id !== opts.me.departmentId}>
                          {d.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </Field>
            <Field label="Team or pod" required={!!dept?.teams.length} error={errors.teamId} htmlFor="ap-team" hint={dept && !dept.teams.length ? "This department has no teams" : undefined}>
              <select id="ap-team" className={inputCls} value={v.teamId} onChange={(e) => setV((x) => ({ ...x, teamId: e.target.value, managerId: dept?.teams.find((t) => t.id === e.target.value)?.leadId || x.managerId }))} disabled={!dept?.teams.length}>
                <option value="">{dept?.teams.length ? "Pick a team" : "No team"}</option>
                {dept?.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reports to" required error={errors.managerId} htmlFor="ap-manager">
              <select id="ap-manager" className={inputCls} value={v.managerId} onChange={(e) => set("managerId", e.target.value)}>
                <option value="">Pick their manager</option>
                {staffInBranch.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.id === dept?.headId ? " (head)" : s.id === team?.leadId ? " (team lead)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Branch" required error={errors.branchId} htmlFor="ap-branch" hint="Set by the department">
              <select id="ap-branch" className={inputCls} value={v.branchId} onChange={(e) => set("branchId", e.target.value)} disabled={!!dept}>
                <option value="">Pick a branch</option>
                {opts.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} · {b.city}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Joining date" required error={errors.joiningDate} htmlFor="ap-join">
              <input id="ap-join" type="date" className={inputCls} value={v.joiningDate} onChange={(e) => set("joiningDate", e.target.value)} />
            </Field>
            <Field label="Employment type" required htmlFor="ap-emp">
              <select id="ap-emp" className={inputCls} value={v.employmentType} onChange={(e) => set("employmentType", e.target.value as PeopleEmploymentType)}>
                {PEOPLE_EMPLOYMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {peopleEmploymentLabels[t]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <fieldset className="border border-border px-3 py-2">
            <legend className="px-1 text-xs font-medium">Onboarding</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={v.onboarding} onChange={(e) => set("onboarding", e.target.checked)} />
              Create the onboarding checklist (tasks for HR and the manager)
            </label>
            {v.onboarding && (
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                {PEOPLE_ONBOARDING_CHOICES.map((k) => (
                  <label key={k} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={v.onboardingItems.includes(k)} onChange={() => toggleItem(k)} />
                    {peopleOnboardingLabels[k]}
                  </label>
                ))}
                {v.onboardingItems.includes("shadowing") && (
                  <label className="col-span-full mt-1 grid gap-1 text-xs">
                    Buddy
                    <select className={inputCls} value={v.buddyId} onChange={(e) => set("buddyId", e.target.value)}>
                      <option value="">Pick later</option>
                      {opts.staff
                        .filter((s) => s.departmentId === v.departmentId)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              </div>
            )}
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={v.sendInvite} onChange={(e) => set("sendInvite", e.target.checked)} />
              Send the invite by SMS and email now
            </label>
          </fieldset>
        </>
      )}
    </ActionDrawer>
  );
}
