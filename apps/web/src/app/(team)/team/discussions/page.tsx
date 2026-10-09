"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Badge, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { useActions } from "@/components/actions/actions-provider";
import { AddButton, EmptyAdd, fmtDay } from "@/components/ops/kit";
import { DiscussionDrawer } from "@/components/ops/discussion-drawer";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function DiscussionsPage() {
  return (
    <Suspense fallback={<LoadState loading />}>
      <Discussions />
    </Suspense>
  );
}

function Discussions() {
  const params = useSearchParams()!; // never null in the App Router (src/pages only holds the API route)
  const router = useRouter();
  const { notify } = useActions();
  const list = useLoad(() => api.ops.threads.list());
  const [creating, setCreating] = useState(params.get("new") === "1");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const rows = (list.data ?? []).filter((t) => (!kind || t.kind === kind) && (!q.trim() || [t.title, t.client.name, t.engagement].some((x) => x?.toLowerCase().includes(q.trim().toLowerCase()))));
  return (
    <>
      <PageTitle
        title="Discussions"
        subtitle="Project threads with the client's team, and internal threads for the people you add."
        action={
          <AddButton onClick={() => setCreating(true)} testId="new-discussion">
            Start discussion
          </AddButton>
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <Input placeholder="Search title or client…" aria-label="Search discussions" value={q} onChange={(e) => setQ(e.target.value)} className="sm:col-span-2" />
        <Select aria-label="Filter by type" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Project and internal</option>
          <option value="project">Project</option>
          <option value="internal">Internal</option>
        </Select>
      </div>
      {!list.data ? (
        <LoadState loading={list.loading} error={list.error} />
      ) : list.data.length === 0 ? (
        <EmptyAdd title="No discussions yet" body="Start one about a project, or an internal thread with the people who need to weigh in." action={<AddButton onClick={() => setCreating(true)}>Start the first discussion</AddButton>} />
      ) : (
        <div className="border-t border-border">
          {rows.map((t) => (
            <Link key={t.id} href={`/team/discussions/${t.id}`} className="flex items-center justify-between gap-3 border-b border-border py-4 text-sm hover:bg-canvas/40" data-thread={t.title}>
              <div className="min-w-0">
                <p className="font-medium">
                  {t.title} <Badge tone={t.kind === "internal" ? "neutral" : "green"}>{t.kind === "internal" ? "Internal" : "Project"}</Badge>
                </p>
                <p className="text-xs text-ink-muted">
                  {t.client.name}
                  {t.engagement ? ` · ${t.engagement}` : ""}
                  {t.kind === "internal" && t.participants.length ? ` · ${t.participants.join(", ")}` : ""}
                </p>
                <p className="truncate text-xs text-ink-muted">{t.lastMessage ? `${t.lastMessage.author}: ${t.lastMessage.body}` : "No messages yet"}</p>
              </div>
              <span className="shrink-0 text-xs text-ink-muted">{fmtDay(t.lastMessage?.at ?? t.createdAt)}</span>
            </Link>
          ))}
          {rows.length === 0 && <p className="py-8 text-center text-sm text-ink-muted">No discussions match.</p>}
        </div>
      )}
      <DiscussionDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(id, m) => {
          notify(m);
          router.push(`/team/discussions/${id}`);
        }}
      />
    </>
  );
}
