"use client";

import { use, useState } from "react";
import Link from "next/link";
import type { TeamLeaveCover } from "@bmu/shared";
import { Empty, Panel } from "@/components/dash";
import { Badge, Button, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/** Cover for approved or pending leave: move the tasks due while someone is away. */
export default function LeaveCoverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.teamFlows.leave.cover(id));
  const [fresh, setFresh] = useState<TeamLeaveCover>();
  const [picked, setPicked] = useState<string[]>([]);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const c = fresh ?? loaded.data;

  async function move() {
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.teamFlows.leave.reassign(id, picked, to);
      setNotice(`Moved ${picked.length} task(s) to ${c?.people.find((p) => p.id === to)?.name ?? "the new owner"}.`);
      setFresh(next);
      setPicked([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Link href="/team/approvals" className="text-sm text-ink-muted hover:text-ink">
        ← Approvals
      </Link>
      {!c ? (
        <LoadState loading={loaded.loading} error={loaded.error} />
      ) : (
        <>
          <PageTitle
            title={`Cover for ${c.leave.user.name}`}
            subtitle={`${c.leave.type} leave · ${day(c.leave.from)}${c.leave.to !== c.leave.from ? ` – ${day(c.leave.to)}` : ""} · ${c.leave.status === "pending" ? (c.leave.stage === "hr" ? "waiting for HR" : "waiting for manager") : c.leave.status}`}
          />
          {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
          {notice && <p className="mb-4 border border-green bg-green/10 px-4 py-2 text-sm">{notice}</p>}
          <Panel title="Tasks due while they are away" subtitle="Tick the tasks to move and pick who covers them. People already on leave are marked." flush>
            {c.tasks.length === 0 ? (
              <div className="px-5 py-4">
                <Empty>Nothing due while they are away. No cover needed.</Empty>
              </div>
            ) : (
              <>
                <ul className="divide-y divide-border">
                  {c.tasks.map((t) => (
                    <li key={t.id}>
                      <label className="flex items-start gap-3 px-5 py-2.5 text-sm">
                        <input type="checkbox" className="mt-0.5" checked={picked.includes(t.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, t.id] : picked.filter((x) => x !== t.id))} />
                        <span className="min-w-0">
                          <span className="block truncate">{t.title}</span>
                          <span className="block text-xs text-ink-muted">{[t.client, t.deadline ? `due ${day(t.deadline)}` : null].filter(Boolean).join(" · ")}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
                  <label className="flex items-center gap-2 text-xs text-ink-muted">
                    <input type="checkbox" checked={picked.length === c.tasks.length} onChange={(e) => setPicked(e.target.checked ? c.tasks.map((t) => t.id) : [])} /> Select all
                  </label>
                  <Select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Cover person">
                    <option value="">Move to…</option>
                    {c.people.map((p) => (
                      <option key={p.id} value={p.id} disabled={p.onLeave}>
                        {p.name} · {p.openTasks} open{p.onLeave ? " · on leave" : ""}
                      </option>
                    ))}
                  </Select>
                  <Button disabled={busy || !picked.length || !to} onClick={move}>
                    Move {picked.length || ""} task{picked.length === 1 ? "" : "s"}
                  </Button>
                  {c.people.some((p) => p.onLeave) && <Badge tone="amber">Some teammates are also out</Badge>}
                </div>
              </>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
