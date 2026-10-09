"use client";

/**
 * Person page: Overview (profile, actions, everything they own right now) and History (every change from the audit
 * log: invited, moved, role changed, offboarded…). `?tab=history` opens History.
 */
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PeoplePersonDetail } from "@bmu/shared";
import { useActions } from "@/components/actions/actions-provider";
import { HistoryTab } from "@/components/actions/history-tab";
import { RowMenu } from "@/components/actions/row-menu";
import { Avatar, PersonSummary } from "@/components/people/person-drawer";
import { personMenuItems, usePersonActions } from "@/components/people/person-actions";
import { PageTitle } from "@/components/ui";
import { api } from "@/lib/api";

type Tab = "overview" | "history";

export default function PersonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = use(params);
  const { tab: tabParam } = use(searchParams);
  const router = useRouter();
  const { version, changed, openBulkReassign, me } = useActions();
  const [p, setP] = useState<PeoplePersonDetail>();
  const [error, setError] = useState<string>();
  const [n, setN] = useState(0);
  const tab: Tab = tabParam === "history" ? "history" : "overview";
  const reload = () => {
    setN((x) => x + 1);
    changed();
  };
  const pa = usePersonActions(reload);

  useEffect(() => {
    let live = true;
    api.peopleActions
      .get(id)
      .then((d) => {
        if (!live) return;
        setP(d);
        setError(undefined);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id, version, n]);

  const setTab = (t: Tab) => router.replace(t === "history" ? `/admin/users/${id}?tab=history` : `/admin/users/${id}`, { scroll: false });
  const open = p?.openRecords;
  const groups = open
    ? ([
        ["Tasks", open.tasks],
        ["Clients (as AM)", open.clients],
        ["Engagements (as AM)", open.engagements],
        ["Leads", open.leads],
        ["Open requests", open.requests],
        ["Approvals waiting on them", open.approvals],
        ["Creator briefs", open.briefs],
      ] as const)
    : [];

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/admin/users" className="text-ink-muted hover:text-ink">
          ← Users
        </Link>
      </p>
      {!p && !error && <p className="text-sm text-ink-muted">Loading…</p>}
      {error && (
        <p className="border border-red bg-red/10 px-4 py-2 text-sm" role="alert">
          {error}{" "}
          <button type="button" className="underline" onClick={() => setN((x) => x + 1)}>
            Try again
          </button>
        </p>
      )}
      {p && (
        <>
          <div className="flex items-start gap-3">
            <Avatar name={p.name} photoUrl={p.photoUrl} size={48} />
            <div className="min-w-0 flex-1">
              <PageTitle title={p.name} subtitle={p.roles.map((r) => r.name).join(" + ") || "No role"} action={<RowMenu items={personMenuItems(p, p.can, pa.open, { meId: me.id, reassign: () => openBulkReassign(p.id, reload), profile: false })} label={`Actions for ${p.name}`} />} />
            </div>
          </div>
          <div className="mb-4 flex border-b border-border" role="tablist" aria-label="Sections">
            {(["overview", "history"] as Tab[]).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-4 py-2 text-sm ${tab === t ? "border-charcoal font-medium" : "border-transparent text-ink-muted hover:text-ink"}`}>
                {t === "overview" ? "Overview" : "History"}
              </button>
            ))}
          </div>
          {tab === "overview" ? (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <section className="space-y-4 border border-border bg-surface p-4">
                <PersonSummary p={p} onAction={pa.open} onReload={() => setN((x) => x + 1)} links={false} />
                <p className="flex flex-wrap gap-4 text-sm">
                  {p.onboardingId && (
                    <Link className="underline" href={`/admin/people/${p.onboardingId}`}>
                      Onboarding checklist
                    </Link>
                  )}
                  {p.offboardingId && (
                    <Link className="underline" href={`/admin/people/${p.offboardingId}`}>
                      Offboarding checklist
                    </Link>
                  )}
                </p>
              </section>
              <section className="border border-border bg-surface p-4" data-testid="open-records">
                <h2 className="mb-2 font-semibold">What they own now</h2>
                {open && open.total === 0 && <p className="text-sm text-ink-muted">Nothing open. They can be moved or offboarded without a handover.</p>}
                {groups
                  .filter(([, list]) => list.length > 0)
                  .map(([label, list]) => (
                    <div key={label} className="mb-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                        {label} ({list.length})
                      </p>
                      <ul className="mt-1 space-y-0.5 text-sm">
                        {list.slice(0, 12).map((r) => (
                          <li key={r.id} className="truncate">
                            <Link href={r.href} className="hover:underline">
                              {r.title}
                            </Link>
                          </li>
                        ))}
                        {list.length > 12 && <li className="text-xs text-ink-muted">and {list.length - 12} more</li>}
                      </ul>
                    </div>
                  ))}
              </section>
            </div>
          ) : (
            <HistoryTab entity="User" id={p.id} />
          )}
        </>
      )}
      {pa.dialogs}
    </>
  );
}
