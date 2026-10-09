"use client";

/**
 * PersonDrawer: click a person on the hierarchy tree (or the Users list) to see their profile with the actions:
 * Reassign work (all open work A → B through the engine, with preview and undo), Change role, Move, Offboard, Edit.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  peopleEmploymentLabels,
  peopleScopeLabels,
  type PeoplePersonDetail,
} from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDrawer } from "../actions/action-drawer";
import { useActions } from "../actions/actions-provider";
import { LoadBar } from "../actions/person-picker";
import { Badge } from "../ui";
import { fmtDay } from "./use-people-options";
import type { PersonActionKind, PersonLite } from "./person-actions";

export function Avatar({
  name,
  photoUrl,
  size = 40,
}: {
  name: string;
  photoUrl?: string | null;
  size?: number;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  if (photoUrl)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoUrl}
        alt=""
        width={size}
        height={size}
        className="shrink-0 border border-border object-cover"
        style={{ width: size, height: size }}
      />
    );
  return (
    <span
      className="flex shrink-0 items-center justify-center border border-border bg-canvas text-xs font-semibold"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

export const statusTone = (s: string) =>
  (s === "active" ? "green" : s === "invited" ? "amber" : "red") as
    | "green"
    | "amber"
    | "red";

export function PersonDrawer({
  id,
  onClose,
  onAction,
  version,
}: {
  id: string;
  onClose: () => void;
  onAction: (k: PersonActionKind, p: PersonLite) => void;
  version?: number;
}) {
  const [p, setP] = useState<PeoplePersonDetail>();
  const [error, setError] = useState<string>();
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    api.peopleActions
      .get(id)
      .then((d) => live && setP(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id, version, n]);

  return (
    <ActionDrawer
      open
      title={p?.name ?? "Person"}
      subtitle={
        p ? p.roles.map((r) => r.name).join(" + ") || "No role" : undefined
      }
      onClose={onClose}
      testId="person-drawer"
    >
      {!p && !error && <p className="text-sm text-ink-muted">Loading…</p>}
      {error && (
        <p className="border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>
      )}
      {p && (
        <PersonSummary
          p={p}
          onAction={onAction}
          onReload={() => setN((x) => x + 1)}
        />
      )}
    </ActionDrawer>
  );
}

/** The profile body shared by the drawer and the person page: status, actions, facts, scheduled changes, permissions. */
export function PersonSummary({
  p,
  onAction,
  onReload,
  links = true,
}: {
  p: PeoplePersonDetail;
  onAction: (k: PersonActionKind, p: PersonLite) => void;
  onReload: () => void;
  links?: boolean;
}) {
  const { openBulkReassign, notify, changed, me } = useActions();
  async function cancelScheduled(changeId: string) {
    try {
      const r = await api.peopleActions.cancelScheduled(changeId);
      notify(r.message);
      onReload();
      changed();
    } catch (e) {
      notify((e as Error).message, null, "error");
    }
  }

  const can = p.can;
  const left = !!p.leftAt;
  const act =
    "border border-border px-3 py-1.5 text-xs font-medium hover:border-ink disabled:opacity-40";
  return (
    <>
      <div className="flex items-start gap-3">
        <Avatar name={p.name} photoUrl={p.photoUrl} size={56} />
        <div className="min-w-0 text-sm">
          <p className="truncate">{p.email ?? "No email"}</p>
          <p className="text-ink-muted">{p.phone ?? "No mobile"}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge tone={statusTone(p.status)}>
              {left ? "Former" : p.status}
            </Badge>
            {p.onLeaveToday && <Badge tone="amber">On leave today</Badge>}
            {p.pending.scheduled > 0 && (
              <Badge tone="dark">Change scheduled</Badge>
            )}
            {p.pending.approvals > 0 && (
              <Badge tone="amber">Waiting for approval</Badge>
            )}
          </div>
        </div>
      </div>
      {!left && (
        <div className="flex flex-wrap gap-2" data-testid="person-actions">
          {can.reassignWork && (
            <button
              type="button"
              className={act}
              onClick={() => openBulkReassign(p.id, onReload)}
              disabled={p.openRecords.total === 0}
              title={
                p.openRecords.total === 0
                  ? "Nothing open to reassign"
                  : undefined
              }
            >
              Reassign work
            </button>
          )}
          {can.changeRole && (
            <button
              type="button"
              className={act}
              onClick={() => onAction("role", p)}
              disabled={p.id === me.id}
              title={
                p.id === me.id ? "You can't change your own role" : undefined
              }
            >
              Change role
            </button>
          )}
          {can.move && (
            <button
              type="button"
              className={act}
              onClick={() => onAction("move", p)}
            >
              Move
            </button>
          )}
          {(can.edit || can.self) && (
            <button
              type="button"
              className={act}
              onClick={() => onAction("edit", p)}
            >
              Edit
            </button>
          )}
          {can.offboard && p.id !== me.id && (
            <button
              type="button"
              className={`${act} text-red`}
              onClick={() => onAction("offboard", p)}
            >
              Offboard
            </button>
          )}
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-ink-muted">Department</dt>
        <dd>{p.department?.name ?? "—"}</dd>
        <dt className="text-ink-muted">Team</dt>
        <dd>{p.team?.name ?? "—"}</dd>
        <dt className="text-ink-muted">Reports to</dt>
        <dd>{p.manager?.name ?? "—"}</dd>
        <dt className="text-ink-muted">Branch</dt>
        <dd>{p.branch?.name ?? "—"}</dd>
        <dt className="text-ink-muted">Joined</dt>
        <dd>
          {fmtDay(p.joiningDate)}
          {p.employmentType
            ? ` · ${peopleEmploymentLabels[p.employmentType]}`
            : ""}
        </dd>
        <dt className="text-ink-muted">Load</dt>
        <dd>{p.loadPct === null ? "—" : <LoadBar pct={p.loadPct} />}</dd>
        <dt className="text-ink-muted">Next leave</dt>
        <dd>{p.nextLeave ? fmtDay(p.nextLeave) : "None booked"}</dd>
        <dt className="text-ink-muted">Open work</dt>
        <dd>
          {p.openRecords.total === 0
            ? "Nothing open"
            : [
                [p.openRecords.tasks.length, "task"],
                [p.openRecords.clients.length, "client"],
                [p.openRecords.leads.length, "lead"],
                [p.openRecords.approvals.length, "approval"],
                [p.openRecords.briefs.length, "brief"],
              ]
                .filter(([c]) => c)
                .map(([c, l]) => `${c} ${l}${c === 1 ? "" : "s"}`)
                .join(", ")}
        </dd>
        {p.reports.length > 0 && (
          <>
            <dt className="text-ink-muted">Reports</dt>
            <dd>{p.reports.map((r) => r.name).join(", ")}</dd>
          </>
        )}
      </dl>
      {p.scheduled.length > 0 && (
        <div className="border border-border px-3 py-2 text-xs">
          <p className="mb-1 font-medium">Scheduled</p>
          {p.scheduled.map((s) => (
            <p
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span>
                {fmtDay(s.effectiveDate)}: {s.summary}{" "}
                <span className="text-ink-muted">({s.reason})</span>
              </span>
              <button
                type="button"
                className="underline"
                onClick={() => cancelScheduled(s.id)}
              >
                Cancel
              </button>
            </p>
          ))}
        </div>
      )}
      {p.approvals.length > 0 && (
        <div className="border border-amber bg-amber/10 px-3 py-2 text-xs">
          {p.approvals.map((a) => (
            <p key={a.id}>Waiting for approval: {a.summary}</p>
          ))}
        </div>
      )}
      {p.permissions.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium">
            What they can do
          </summary>
          <ul className="mt-1 grid gap-0.5">
            {p.permissions.map((x) => (
              <li key={x.capability} className="flex justify-between gap-2">
                <span>{x.label}</span>
                <span className="text-ink-muted">
                  {peopleScopeLabels[x.scope]}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {links && (
        <p className="flex flex-wrap gap-4 text-sm">
          <Link className="underline" href={`/admin/users/${p.id}`}>
            Full profile
          </Link>
          <Link className="underline" href={`/admin/users/${p.id}?tab=history`}>
            History
          </Link>
          {p.onboardingId && (
            <Link
              className="underline"
              href={`/admin/people/${p.onboardingId}`}
            >
              Onboarding
            </Link>
          )}
          {p.offboardingId && (
            <Link
              className="underline"
              href={`/admin/people/${p.offboardingId}`}
            >
              Offboarding
            </Link>
          )}
        </p>
      )}
    </>
  );
}
