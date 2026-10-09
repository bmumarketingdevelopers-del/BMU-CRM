"use client";

/**
 * Person actions used on the hierarchy tree, the Users list and the person page:
 *   const pa = usePersonActions(reload);
 *   pa.open("move", person, { departmentId, teamId, managerId })   // also "role", "offboard", "edit"
 *   <RowMenu items={personMenuItems(person, can, pa.open, openBulkReassign)} />
 *   {pa.dialogs}
 * Move: new position, effective date, reason, access preview (gains / loses), open work keep or reassign through the
 * engine; cross-department moves by a Department Head go to an Admin. Change role: main + secondary roles, the
 * permission diff, effective date, reason; Admin-level changes go to the Founder. Offboard: last day + reason, then the
 * blocking checklist (everything they own), handover, and the final confirmation.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  CRAFT_SPECIALTY_OPTIONS,
  PEOPLE_EMPLOYMENT_TYPES,
  peopleEmploymentLabels,
  peopleScopeLabels,
  type PeopleCan,
  type PeopleEmploymentType,
  type PeopleMovePreview,
  type PeopleOffboardingStatus,
  type PeoplePersonRow,
  type PeopleRolePreview,
} from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDialog, ActionDrawer, Field, TextArea, inputCls } from "../actions/action-drawer";
import { useActions } from "../actions/actions-provider";
import type { RowMenuItem } from "../actions/row-menu";
import { fmtDay, todayIst, usePeopleOptions } from "./use-people-options";

export type PersonLite = Pick<PeoplePersonRow, "id" | "name" | "status" | "roles" | "department" | "team" | "manager"> & Partial<PeoplePersonRow>;
export type PersonActionKind = "move" | "role" | "offboard" | "edit";
type Target = { departmentId?: string; teamId?: string | null; managerId?: string | null };

const btn = "bg-charcoal px-4 py-2 text-sm font-medium text-ivory hover:opacity-90 disabled:opacity-40";
const ghost = "px-3 py-2 text-sm text-ink-muted hover:text-ink";

export function usePersonActions(onChanged?: () => void) {
  const [state, setState] = useState<{ kind: PersonActionKind; person: PersonLite; target?: Target; n: number } | null>(null);
  const open = (kind: PersonActionKind, person: PersonLite, target?: Target) => setState({ kind, person, target, n: Date.now() });
  const close = () => setState(null);
  const done = () => {
    setState(null);
    onChanged?.();
  };
  const dialogs = state ? (
    state.kind === "move" ? (
      <MoveDialog key={state.n} person={state.person} target={state.target} onClose={close} onDone={done} />
    ) : state.kind === "role" ? (
      <RoleDialog key={state.n} person={state.person} onClose={close} onDone={done} />
    ) : state.kind === "offboard" ? (
      <OffboardDialog key={state.n} person={state.person} onClose={close} onDone={done} />
    ) : (
      <EditPersonDrawer key={state.n} person={state.person} onClose={close} onDone={done} />
    )
  ) : null;
  return { open, dialogs };
}

/** The ⋯ menu items for a person (hidden when not allowed). */
export function personMenuItems(p: PersonLite, can: PeopleCan, open: (k: PersonActionKind, p: PersonLite) => void, opts: { meId: string; reassign?: () => void; profile?: boolean; onInvite?: () => void }): RowMenuItem[] {
  const self = p.id === opts.meId;
  const left = !!p.leftAt;
  const founder = p.roles.some((r) => r.baseRole === "founder");
  return [
    { key: "open", label: "Open profile", href: `/admin/users/${p.id}`, hidden: opts.profile === false },
    { key: "edit", label: "Edit details", onSelect: () => open("edit", p), hidden: !(can.edit || self) || left, shortcut: "E" },
    { key: "move", label: "Move…", onSelect: () => open("move", p), hidden: !can.move || left, disabledReason: founder ? "Only the Founder can move the Founder" : null },
    { key: "role", label: "Change role…", onSelect: () => open("role", p), hidden: !can.changeRole || left, disabledReason: self ? "You can't change your own role" : null },
    { key: "reassign", label: "Reassign work…", onSelect: opts.reassign, hidden: !can.reassignWork || !opts.reassign, shortcut: "R" },
    { key: "invite", label: "Resend invite", onSelect: opts.onInvite, hidden: !can.edit || p.status !== "invited" || !opts.onInvite },
    { key: "offboard", label: "Offboard…", onSelect: () => open("offboard", p), hidden: !can.offboard || left, disabledReason: self ? "You can't offboard yourself" : null, danger: true },
    { key: "history", label: "View history", href: `/admin/users/${p.id}?tab=history` },
  ];
}

function useDebounced<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ---------------------------------------------------------------------------
// Move

function MoveDialog({ person, target, onClose, onDone }: { person: PersonLite; target?: Target; onClose: () => void; onDone: () => void }) {
  const { opts, error: optsError } = usePeopleOptions(true);
  const { notify, openBulkReassign } = useActions();
  const [departmentId, setDept] = useState(target?.departmentId ?? person.department?.id ?? "");
  const [teamId, setTeam] = useState<string>(target?.teamId === undefined ? (target?.departmentId && target.departmentId !== person.department?.id ? "" : (person.team?.id ?? "")) : (target.teamId ?? ""));
  const [managerId, setManager] = useState<string>(target?.managerId === undefined ? (person.manager?.id ?? "") : (target.managerId ?? ""));
  const [effectiveDate, setDate] = useState(todayIst());
  const [reason, setReason] = useState("");
  const [openWork, setOpenWork] = useState<"keep" | "reassign">("keep");
  const [preview, setPreview] = useState<PeopleMovePreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const dept = opts?.departments.find((d) => d.id === departmentId);
  const input = useDebounced(JSON.stringify({ departmentId, teamId: teamId || null, managerId: managerId || null, effectiveDate }));

  useEffect(() => {
    const i = JSON.parse(input) as { departmentId: string };
    if (!i.departmentId) return;
    let live = true;
    api.peopleActions
      .movePreview(person.id, { ...JSON.parse(input), reason: "preview" })
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setError(undefined);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [input, person.id]);

  async function save() {
    if (reason.trim().length < 3) return setError("Give a short reason (at least 3 characters)");
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.peopleActions.move(person.id, { departmentId, teamId: teamId || null, managerId: managerId || null, effectiveDate, reason: reason.trim(), openWork });
      notify(r.message, r.undo);
      onDone();
      if (openWork === "reassign" && r.outcome !== "approval") openBulkReassign(person.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const label = preview?.needsApproval ? "Send for approval" : preview?.scheduled ? `Schedule for ${fmtDay(effectiveDate)}` : "Move";
  return (
    <ActionDialog
      open
      title={`Move ${person.name}`}
      onClose={onClose}
      testId="move-dialog"
      footer={
        <>
          <button type="button" className={btn} disabled={busy || !preview || !!preview.blocked} onClick={save}>
            {busy ? "Saving…" : label}
          </button>
          <button type="button" className={`ml-auto ${ghost}`} onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      {!opts && !optsError && <p className="text-ink-muted">Loading…</p>}
      {optsError && <p className="text-red">{optsError}</p>}
      {opts && (
        <>
          <Field label="Department" required htmlFor="mv-dept">
            <select id="mv-dept" className={inputCls} value={departmentId} onChange={(e) => { setDept(e.target.value); setTeam(""); }}>
              {opts.branches.map((b) => (
                <optgroup key={b.id} label={b.name}>
                  {opts.departments.filter((d) => d.branchId === b.id).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Team or pod" htmlFor="mv-team">
              <select id="mv-team" className={inputCls} value={teamId} onChange={(e) => setTeam(e.target.value)}>
                <option value="">No team</option>
                {dept?.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reports to" htmlFor="mv-mgr">
              <select id="mv-mgr" className={inputCls} value={managerId} onChange={(e) => setManager(e.target.value)}>
                <option value="">Nobody</option>
                {opts.staff.filter((s) => s.id !== person.id).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.id === dept?.headId ? " (head)" : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Effective from" required htmlFor="mv-date" hint="Today applies straight away; a later date is scheduled.">
            <input id="mv-date" type="date" className={inputCls} min={todayIst()} value={effectiveDate} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Reason" required htmlFor="mv-reason">
            <input id="mv-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Joins the video team for the new retainer" />
          </Field>
          {preview && (
            <div className="space-y-2 border border-border bg-canvas/40 px-3 py-2 text-xs" data-testid="move-preview">
              <p>
                <span className="text-ink-muted">{[preview.from.department, preview.from.team].filter(Boolean).join(" · ") || "No department"}</span> → <span className="font-medium">{[preview.to.department, preview.to.team].filter(Boolean).join(" · ")}</span>
                {preview.to.manager ? `, reports to ${preview.to.manager}` : ""}
              </p>
              {preview.gains.map((g) => (
                <p key={g} className="text-ink">
                  <span className="font-semibold text-green">+</span> {g}
                </p>
              ))}
              {preview.loses.map((g) => (
                <p key={g} className="text-ink-muted">
                  <span className="font-semibold text-red">−</span> {g}
                </p>
              ))}
              {preview.needsApproval && <p className="border border-amber bg-amber/10 px-2 py-1">Needs approval from {preview.needsApproval.approver}: {preview.needsApproval.why}.</p>}
              {preview.blocked && <p className="border border-red bg-red/10 px-2 py-1">{preview.blocked}</p>}
            </div>
          )}
          {preview && preview.openWork.total > 0 && (
            <fieldset className="text-sm">
              <legend className="mb-1 text-xs font-medium">
                Their open work: {preview.openWork.tasks} task{preview.openWork.tasks === 1 ? "" : "s"}
                {preview.openWork.clients ? `, ${preview.openWork.clients} client${preview.openWork.clients === 1 ? "" : "s"}` : ""}
                {preview.openWork.leads ? `, ${preview.openWork.leads} lead${preview.openWork.leads === 1 ? "" : "s"}` : ""}
              </legend>
              <label className="mr-4 inline-flex items-center gap-2">
                <input type="radio" name="openwork" checked={openWork === "keep"} onChange={() => setOpenWork("keep")} /> They keep it
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="openwork" checked={openWork === "reassign"} onChange={() => setOpenWork("reassign")} /> Reassign it after the move
              </label>
            </fieldset>
          )}
          {error && <p role="alert" className="border border-red bg-red/10 px-3 py-2">{error}</p>}
        </>
      )}
    </ActionDialog>
  );
}

// ---------------------------------------------------------------------------
// Change role

function RoleDialog({ person, onClose, onDone }: { person: PersonLite; onClose: () => void; onDone: () => void }) {
  const { opts, error: optsError } = usePeopleOptions(true);
  const { notify } = useActions();
  const [main, setMain] = useState(person.roles[0]?.id ?? "");
  const [extra, setExtra] = useState<string[]>(person.roles.slice(1).map((r) => r.id));
  const [effectiveDate, setDate] = useState(todayIst());
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<PeopleRolePreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const roleIds = [main, ...extra.filter((x) => x !== main)].filter(Boolean);
  const key = useDebounced(JSON.stringify({ roleIds, effectiveDate }));

  useEffect(() => {
    const i = JSON.parse(key) as { roleIds: string[]; effectiveDate: string };
    if (!i.roleIds.length) return;
    let live = true;
    api.peopleActions
      .rolePreview(person.id, { ...i, reason: "preview" })
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setError(undefined);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [key, person.id]);

  async function save() {
    if (reason.trim().length < 3) return setError("Give a short reason (at least 3 characters)");
    setBusy(true);
    try {
      const r = await api.peopleActions.changeRole(person.id, { roleIds, effectiveDate, reason: reason.trim() });
      notify(r.message, r.undo);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const roles = opts?.roles ?? [];
  return (
    <ActionDialog
      open
      title={`Change ${person.name}'s role`}
      onClose={onClose}
      testId="role-dialog"
      footer={
        <>
          <button type="button" className={btn} disabled={busy || !preview || !!preview.blocked} onClick={save}>
            {busy ? "Saving…" : preview?.needsApproval ? "Send to the Founder" : preview?.scheduled ? `Schedule for ${fmtDay(effectiveDate)}` : "Change role"}
          </button>
          <button type="button" className={`ml-auto ${ghost}`} onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      {!opts && !optsError && <p className="text-ink-muted">Loading…</p>}
      {optsError && <p className="text-red">{optsError}</p>}
      {opts && (
        <>
          <p className="text-xs text-ink-muted">Now: {person.roles.map((r) => r.name).join(" + ") || "No role"}</p>
          <Field label="Main role" required htmlFor="rl-main">
            <select id="rl-main" className={inputCls} value={main} onChange={(e) => setMain(e.target.value)}>
              {roles.map((r) => (
                <option key={r.id} value={r.id} disabled={!r.assignable}>
                  {r.name}
                  {r.needsApproval ? " (Founder approves)" : ""}
                  {!r.assignable ? " (not allowed)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <details open={extra.length > 0}>
            <summary className="cursor-pointer text-xs font-medium">Secondary roles</summary>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {roles.filter((r) => r.assignable && r.id !== main).map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={extra.includes(r.id)} onChange={() => setExtra(extra.includes(r.id) ? extra.filter((x) => x !== r.id) : [...extra, r.id])} />
                  {r.name}
                </label>
              ))}
            </div>
          </details>
          <Field label="Effective from" required htmlFor="rl-date">
            <input id="rl-date" type="date" className={inputCls} min={todayIst()} value={effectiveDate} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Reason" required htmlFor="rl-reason">
            <input id="rl-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Promoted after the review" />
          </Field>
          {preview && (
            <div className="border border-border bg-canvas/40 px-3 py-2 text-xs" data-testid="role-diff">
              <p className="mb-1 font-medium">What changes</p>
              {preview.diff.length === 0 && <p className="text-ink-muted">No change in permissions.</p>}
              <ul className="space-y-0.5">
                {preview.diff.map((d) => (
                  <li key={d.capability} className="flex justify-between gap-2">
                    <span>
                      <span className={`font-semibold ${d.change === "gain" ? "text-green" : "text-red"}`}>{d.change === "gain" ? "+" : "−"}</span> {d.label}
                    </span>
                    <span className="text-ink-muted">
                      {peopleScopeLabels[d.before]} → {peopleScopeLabels[d.after]}
                    </span>
                  </li>
                ))}
              </ul>
              {preview.needsApproval && <p className="mt-2 border border-amber bg-amber/10 px-2 py-1">{preview.needsApproval.why}: it goes to {preview.needsApproval.approver}.</p>}
              {preview.blocked && <p className="mt-2 border border-red bg-red/10 px-2 py-1">{preview.blocked}</p>}
            </div>
          )}
          {error && <p role="alert" className="border border-red bg-red/10 px-3 py-2">{error}</p>}
        </>
      )}
    </ActionDialog>
  );
}

// ---------------------------------------------------------------------------
// Offboard

const GROUPS: [keyof Omit<PeopleOffboardingStatus["openRecords"], "total">, string][] = [
  ["tasks", "Tasks"],
  ["clients", "Clients (as AM)"],
  ["engagements", "Engagements (as AM)"],
  ["leads", "Leads"],
  ["requests", "Client requests"],
  ["approvals", "Approvals waiting on them"],
  ["briefs", "Creator briefs"],
];

function OffboardDialog({ person, onClose, onDone }: { person: PersonLite; onClose: () => void; onDone: () => void }) {
  const { notify, openBulkReassign } = useActions();
  const { opts } = usePeopleOptions(true);
  const [status, setStatus] = useState<PeopleOffboardingStatus>();
  const [lastDay, setLastDay] = useState(todayIst());
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = () =>
    api.peopleActions
      .offboarding(person.id)
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person.id]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const started = !!status?.processId;
  const open = status?.openRecords;
  return (
    <ActionDialog
      open
      title={`Offboard ${person.name}`}
      onClose={onClose}
      testId="offboard-dialog"
      footer={
        !started ? (
          <>
            <button type="button" className={btn} disabled={busy || !status} onClick={() => run(async () => { if (reason.trim().length < 3) throw new Error("Give a short reason (at least 3 characters)"); setStatus(await api.peopleActions.offboard(person.id, { lastDay, reason: reason.trim(), note: note.trim() || undefined })); notify(`Offboarding started for ${person.name}`); })}>
              Start offboarding
            </button>
            <button type="button" className={`ml-auto ${ghost}`} onClick={onClose}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={btn}
              disabled={busy || !status?.canConfirm}
              title={status?.blockers.join(" · ")}
              onClick={() => run(async () => { const r = await api.peopleActions.confirmOffboarding(person.id); notify(r.message); onDone(); })}
            >
              {status?.confirmNeedsAdmin ? "Send to Admin to confirm" : "Confirm offboarding"}
            </button>
            <button type="button" className={`ml-auto ${ghost}`} onClick={onDone}>
              Close
            </button>
          </>
        )
      }
    >
      {!status && !error && <p className="text-ink-muted">Loading…</p>}
      {status && !started && (
        <>
          <Field label="Last working day" required htmlFor="ob-last" hint="They can sign in until the end of this day.">
            <input id="ob-last" type="date" className={inputCls} value={lastDay} onChange={(e) => setLastDay(e.target.value)} />
          </Field>
          <Field label="Reason" required htmlFor="ob-reason">
            <input id="ob-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Resigned, moving cities" />
          </Field>
          <Field label="Note for HR (optional)" htmlFor="ob-note">
            <TextArea id="ob-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {open && open.total > 0 && <p className="text-xs text-ink-muted">They own {open.total} open record{open.total === 1 ? "" : "s"}. Offboarding can&apos;t finish until every one has a new owner.</p>}
        </>
      )}
      {status && started && open && (
        <>
          <p className="text-xs text-ink-muted">
            Last day {fmtDay(status.lastDay)} · {status.status === "done" ? "Confirmed" : "In progress"} ·{" "}
            <Link className="underline" href={`/admin/people/${status.processId}`}>
              Open the checklist
            </Link>
          </p>
          {status.blockers.length > 0 && (
            <div className="border border-amber bg-amber/10 px-3 py-2 text-xs" data-testid="offboard-blockers">
              <p className="font-medium">Can&apos;t finish yet</p>
              <ul className="list-disc pl-4">
                {status.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          {open.total > 0 && (
            <div className="space-y-2">
              {GROUPS.filter(([k]) => open[k].length).map(([k, label]) => (
                <div key={k}>
                  <p className="text-xs font-medium">
                    {label} ({open[k].length})
                  </p>
                  <ul className="text-xs">
                    {open[k].slice(0, 4).map((r) => (
                      <li key={r.id} className="truncate">
                        <Link className="underline-offset-2 hover:underline" href={r.href}>
                          {r.title}
                        </Link>
                      </li>
                    ))}
                    {open[k].length > 4 && <li className="text-ink-muted">and {open[k].length - 4} more</li>}
                  </ul>
                </div>
              ))}
              <button type="button" className="border border-border px-3 py-1.5 text-xs hover:border-ink" onClick={() => openBulkReassign(person.id, () => void load())}>
                Move all their work…
              </button>
              {(open.approvals.length > 0 || open.briefs.length > 0) && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="grid gap-1 text-xs">
                    Hand over to
                    <select className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Hand over to">
                      <option value="">Pick a person</option>
                      {(opts?.staff ?? []).filter((s) => s.id !== person.id).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {open.approvals.length > 0 && (
                    <button type="button" disabled={!to || busy} className="border border-border px-3 py-1.5 text-xs disabled:opacity-40" onClick={() => run(async () => setStatus(await api.peopleActions.handover(person.id, { kind: "approvals", toUserId: to })))}>
                      Hand over approvals
                    </button>
                  )}
                  {open.briefs.length > 0 && (
                    <button type="button" disabled={!to || busy} className="border border-border px-3 py-1.5 text-xs disabled:opacity-40" onClick={() => run(async () => setStatus(await api.peopleActions.handover(person.id, { kind: "briefs", toUserId: to })))}>
                      Hand over briefs
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {status.pendingItems.length > 0 && (
            <p className="text-xs">
              Checklist still open: {status.pendingItems.slice(0, 4).join("; ")}
              {status.pendingItems.length > 4 ? "…" : ""}
            </p>
          )}
          {status.blockers.length === 0 && status.status === "open" && <p className="border border-green bg-green/10 px-3 py-2 text-xs">Everything is handed over. {status.confirmNeedsAdmin ? "Send it to an Admin for the final confirmation." : "Confirm to finish."}</p>}
        </>
      )}
      {error && <p role="alert" className="border border-red bg-red/10 px-3 py-2">{error}</p>}
    </ActionDialog>
  );
}

// ---------------------------------------------------------------------------
// Edit (self: contact + photo only)

function EditPersonDrawer({ person, onClose, onDone }: { person: PersonLite; onClose: () => void; onDone: () => void }) {
  const { me, notify } = useActions();
  const { opts } = usePeopleOptions(true);
  const selfOnly = person.id === me.id && !(opts?.can.edit ?? false);
  const [v, setV] = useState({ name: person.name, email: person.email ?? "", phone: person.phone ?? "", photoUrl: person.photoUrl ?? "", joiningDate: person.joiningDate ?? "", employmentType: (person.employmentType ?? "") as PeopleEmploymentType | "", specialty: person.specialty ?? "" });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v, val: string) => setV((x) => ({ ...x, [k]: val }));

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const contact = { email: v.email.trim() || null, phone: v.phone.trim() || null, photoUrl: v.photoUrl.trim() || null };
      const r = await api.peopleActions.edit(person.id, selfOnly ? contact : { ...contact, name: v.name.trim(), joiningDate: v.joiningDate || null, employmentType: v.employmentType || null, specialty: v.specialty || null });
      notify(r.message, r.undo);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionDrawer open title={selfOnly ? "Your contact details" : `Edit ${person.name}`} subtitle="Role, department and manager changes use Change role and Move." onClose={onClose} onSubmit={save} saving={busy} error={error} testId="edit-person-drawer">
      {!selfOnly && (
        <Field label="Full name" required htmlFor="ep-name">
          <input id="ep-name" className={inputCls} value={v.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mobile" htmlFor="ep-phone">
          <input id="ep-phone" className={inputCls} value={v.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
        <Field label="Email" htmlFor="ep-email">
          <input id="ep-email" type="email" className={inputCls} value={v.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
      </div>
      <Field label="Photo link" htmlFor="ep-photo" hint="A link to a square photo">
        <input id="ep-photo" className={inputCls} value={v.photoUrl} onChange={(e) => set("photoUrl", e.target.value)} placeholder="https://" />
      </Field>
      {!selfOnly && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Joining date" htmlFor="ep-join">
            <input id="ep-join" type="date" className={inputCls} value={v.joiningDate} onChange={(e) => set("joiningDate", e.target.value)} />
          </Field>
          <Field label="Employment type" htmlFor="ep-emp">
            <select id="ep-emp" className={inputCls} value={v.employmentType} onChange={(e) => set("employmentType", e.target.value)}>
              <option value="">Not set</option>
              {PEOPLE_EMPLOYMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {peopleEmploymentLabels[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Specialty" htmlFor="ep-spec">
            <select id="ep-spec" className={inputCls} value={v.specialty} onChange={(e) => set("specialty", e.target.value)}>
              <option value="">None</option>
              {CRAFT_SPECIALTY_OPTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
    </ActionDrawer>
  );
}
