"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DOC_KINDS, docKindLabels, type DocKind, type DocRow } from "@bmu/shared";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { when } from "@/components/request-bits";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

function Rows({ rows, base, team }: { rows: DocRow[]; base: string; team: boolean }) {
  return (
    <div className="border-t border-border" data-testid="doc-list">
      {rows.map((d) => (
        <Link key={d.id} href={`${base}/${d.id}`} className="flex items-center justify-between gap-3 border-b border-border py-3 text-sm hover:bg-canvas/40">
          <div className="min-w-0">
            <p className="font-medium">{d.title}</p>
            <p className="text-xs text-ink-muted">
              {docKindLabels[d.kind]}
              {d.client ? ` · ${d.client.name}` : ""}
              {d.engagement ? ` · ${d.engagement.name}` : ""}
              {d.lead ? ` · Lead: ${d.lead.name}` : ""} · {d.words} words
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs text-ink-muted">
            {team && d.clientVisible && <Badge tone="green">Shared</Badge>}
            {d.updatedBy ? `${d.updatedBy}, ` : ""}
            {when.format(new Date(d.updatedAt))}
          </div>
        </Link>
      ))}
      {rows.length === 0 && <p className="py-8 text-center text-sm text-ink-muted">No documents yet.</p>}
    </div>
  );
}

export function TeamDocs() {
  const list = useLoad(() => api.docs.list(), { live: ["CollabDoc"] });
  const clients = useLoad(() => api.clients.list().catch(() => []), { live: false });
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<DocKind>("brief");
  const [clientOrgId, setClientOrgId] = useState("");
  const [error, setError] = useState<string>();
  return (
    <>
      <PageTitle title="Documents" subtitle="Briefs, proposal drafts and notes that several people can edit at the same time. Share one with the client to work on it together." />
      <div className="mb-6 flex flex-wrap items-end gap-2 border border-border p-4">
        <Input className="max-w-sm" placeholder="New document title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New document title" />
        <Select value={kind} onChange={(e) => setKind(e.target.value as DocKind)} aria-label="Kind">
          {DOC_KINDS.map((k) => (
            <option key={k} value={k}>
              {docKindLabels[k]}
            </option>
          ))}
        </Select>
        <Select value={clientOrgId} onChange={(e) => setClientOrgId(e.target.value)} aria-label="Client">
          <option value="">No client (internal)</option>
          {clients.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Button
          disabled={title.trim().length < 2}
          data-testid="doc-create"
          onClick={() =>
            api.docs
              .create({ title: title.trim(), kind, clientOrgId: clientOrgId || null })
              .then((d) => router.push(`/team/docs/${d.id}`))
              .catch((e: Error) => setError(e.message))
          }
        >
          Create
        </Button>
        {error && <p className="w-full text-xs text-red">{error}</p>}
      </div>
      {list.data ? <Rows rows={list.data} base="/team/docs" team /> : <LoadState loading={list.loading} error={list.error} />}
    </>
  );
}

export function ClientDocs() {
  const list = useLoad(() => api.docs.clientList(), { live: ["CollabDoc"] });
  return (
    <>
      <PageTitle title="Documents" subtitle="Briefs and plans your BMU team shared with you. You can edit them together at the same time." />
      {list.data ? <Rows rows={list.data} base="/client/docs" team={false} /> : <LoadState loading={list.loading} error={list.error} />}
    </>
  );
}

/** "Shared brief" box on a project page: opens the project's brief, creating it the first time. */
export function ProjectBriefLink({ engagementId, title, text }: { engagementId: string; title: string; text?: string }) {
  const docs = useLoad(() => api.docs.list({ engagementId }).catch(() => [] as DocRow[]), { live: ["CollabDoc"] });
  const router = useRouter();
  const [error, setError] = useState<string>();
  if (!docs.data) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="project-docs">
      {docs.data.map((d) => (
        <Link key={d.id} href={`/team/docs/${d.id}`} className="border border-border px-3 py-1.5 hover:border-ink">
          {d.title}
          {d.clientVisible ? " · shared" : ""}
        </Link>
      ))}
      {!docs.data.some((d) => d.kind === "brief") && (
        <Button
          variant="secondary"
          data-testid="open-shared-brief"
          onClick={() =>
            api.docs
              .create({ title: `${title} brief`, kind: "brief", engagementId, text })
              .then((d) => router.push(`/team/docs/${d.id}`))
              .catch((e: Error) => setError(e.message))
          }
        >
          Start a shared brief
        </Button>
      )}
      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}
