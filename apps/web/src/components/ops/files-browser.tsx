"use client";

/**
 * Files: every client's files by folder (From client, Working, Final, Brand assets, General). Upload, move, rename and
 * tag, release finals to the client after Gate 5, share links with expiry and an optional password, archive, history.
 * Used at /team/files and, filtered, on client and project pages.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { OPS_FILE_FOLDERS, opsFileDirectionLabels, opsFileFolderLabels, opsFileSourceLabels, type OpsFileFolder, type OpsFileRow, type OpsShareLinkView } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Badge, Input, LoadState, Select } from "@/components/ui";
import { ActionDialog, Field, inputCls } from "@/components/actions/action-drawer";
import { useActions } from "@/components/actions/actions-provider";
import { BulkBar, BulkButton, useSelection } from "@/components/actions/bulk-bar";
import { HistoryTab } from "@/components/actions/history-tab";
import { RowMenu } from "@/components/actions/row-menu";
import { SavedViewsMenu } from "@/components/actions/saved-views-menu";
import { CsvButton } from "@/components/charts";
import { AddButton, EmptyAdd, errMsg, fmtDay, fmtSize, ReasonDialog } from "./kit";

/** v35: "clients" = sent to or received from clients. */
type Shared = "" | "clients" | "to_client" | "from_client" | "internal";
type F = { q: string; folder: "" | OpsFileFolder; client: string; project: string; archived: boolean; shared?: Shared; dept?: string };
const DIRECTION_TONE = { to_client: "green", from_client: "amber", internal: "neutral" } as const;

export function FilesBrowser({ clientOrgId, engagementId, compact, shared = "" }: { clientOrgId?: string; engagementId?: string; compact?: boolean; shared?: Shared }) {
  const { openNew, canNew, notify, version, changed } = useActions();
  const EMPTY: F = { q: "", folder: "", client: clientOrgId ?? "", project: engagementId ?? "", archived: false, shared };
  const [f, setF] = useState<F>(EMPTY);
  const archivedRef = useRef(false);
  const list = useLoad(() => api.ops.files.list({ clientOrgId, engagementId, archived: archivedRef.current ? "1" : undefined }));
  const [editing, setEditing] = useState<OpsFileRow | null>(null);
  const [sharing, setSharing] = useState<OpsFileRow | null>(null);
  const [history, setHistory] = useState<OpsFileRow | null>(null);
  const [archiving, setArchiving] = useState<string[] | null>(null);
  const [bulkMove, setBulkMove] = useState("");
  const reload = list.reload;
  useEffect(() => {
    if (version) reload();
  }, [version, reload]);
  useEffect(() => {
    if (archivedRef.current !== f.archived) {
      archivedRef.current = f.archived;
      reload();
    }
  }, [f.archived, reload]);

  const rows = useMemo(() => list.data?.rows ?? [], [list.data]);
  const clients = list.data?.clients ?? [];
  const client = clients.find((c) => c.id === f.client);
  const shown = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return rows.filter((r) => {
      if (f.folder && r.folder !== f.folder) return false;
      if (f.client && r.client?.id !== f.client) return false;
      if (f.project && r.engagement?.id !== f.project) return false;
      if (f.shared === "clients" ? r.direction === "internal" : f.shared && r.direction !== f.shared) return false;
      if (f.dept && (f.dept === "client" ? !!r.department : r.department?.id !== f.dept)) return false;
      if (q && ![r.name, r.client?.name, r.engagement?.name, r.uploadedBy, r.sharedBy, ...r.tags].some((x) => x?.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [rows, f]);
  const ids = useMemo(() => shown.map((r) => r.id), [shown]);
  const sel = useSelection(ids);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) if ((!f.client || r.client?.id === f.client) && (!f.project || r.engagement?.id === f.project)) m[r.folder] = (m[r.folder] ?? 0) + 1;
    return m;
  }, [rows, f.client, f.project]);
  const upload = canNew("file") ? () => openNew("file", { clientId: f.client || clientOrgId, engagementId: f.project || engagementId, folder: f.folder && f.folder !== "from_client" ? f.folder : undefined }, () => reload()) : null;

  async function release(r: OpsFileRow) {
    try {
      const x = await api.ops.files.release(r.id);
      notify(x.message);
      reload();
    } catch (e) {
      notify(errMsg(e), null, "error");
    }
  }
  async function bulkUpdate(fn: (r: OpsFileRow) => Parameters<typeof api.ops.files.update>[1], done: string) {
    const picked = rows.filter((r) => sel.has(r.id) && r.can.edit);
    const failed: string[] = [];
    for (const r of picked) {
      try {
        await api.ops.files.update(r.id, fn(r));
      } catch (e) {
        failed.push(`${r.name}: ${errMsg(e)}`);
      }
    }
    notify(failed.length ? `${picked.length - failed.length} updated. Not updated: ${failed.join("; ")}` : done, null, failed.length ? "error" : "ok");
    sel.clear();
    reload();
  }
  async function archive(list: string[], reason: string) {
    const failed: string[] = [];
    let undo = null;
    for (const id of list) {
      try {
        const r = await api.actions.archive("file", id, reason);
        if (list.length === 1) undo = r.undo;
      } catch (e) {
        failed.push(`${rows.find((x) => x.id === id)?.name ?? id}: ${errMsg(e)}`);
      }
    }
    if (failed.length === list.length) throw new Error(failed.join("; "));
    notify(failed.length ? `${list.length - failed.length} archived. Not archived: ${failed.join("; ")}` : list.length === 1 ? "File archived" : `${list.length} files archived`, undo, failed.length ? "error" : "ok");
    sel.clear();
    changed();
    reload();
  }

  return (
    <section aria-label="Files" className="border border-border bg-surface-raised" data-testid="files-browser">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="font-semibold">Files</h2>
        <div className="flex flex-wrap items-center gap-2">
          {upload && (
            <AddButton onClick={upload} testId="upload-files">
              + Upload
            </AddButton>
          )}
          {!compact && (
            <>
              <CsvButton
                rows={shown}
                filename="files.csv"
                label="Export"
                columns={[
                  { header: "Name", value: (r: OpsFileRow) => r.name },
                  { header: "Folder", value: (r) => opsFileFolderLabels[r.folder] },
                  { header: "Department", value: (r) => r.department?.name ?? "Client file" },
                  { header: "Shared", value: (r) => (r.direction ? opsFileDirectionLabels[r.direction] : "") },
                  { header: "Where", value: (r) => (r.source ? opsFileSourceLabels[r.source] : "") },
                  { header: "Shared by", value: (r) => r.sharedBy ?? "" },
                  { header: "Client", value: (r) => r.client?.name ?? "" },
                  { header: "Project", value: (r) => r.engagement?.name ?? "" },
                  { header: "Tags", value: (r) => r.tags.join("; ") },
                  { header: "Size (KB)", value: (r) => (r.sizeBytes ? Math.round(r.sizeBytes / 1024) : "") },
                  { header: "Uploaded by", value: (r) => r.uploadedBy ?? "" },
                  { header: "Uploaded", value: (r) => r.createdAt.slice(0, 10) },
                  { header: "Released", value: (r) => (r.released ? "yes" : "no") },
                ]}
              />
              <SavedViewsMenu entity="files" filters={f} onApply={(x) => setF({ ...EMPTY, ...(x as Partial<F>) })} />
            </>
          )}
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2 text-sm" role="tablist" aria-label="Folders">
        {(["", ...OPS_FILE_FOLDERS] as const).map((k) => (
          <button key={k || "all"} type="button" role="tab" aria-selected={f.folder === k} onClick={() => setF({ ...f, folder: k })} className={`shrink-0 border px-3 py-1 ${f.folder === k ? "border-charcoal bg-charcoal text-ivory" : "border-transparent hover:border-border"}`}>
            {k ? opsFileFolderLabels[k] : "All"} <span className="opacity-70">{k ? (counts[k] ?? 0) : Object.values(counts).reduce((a, b) => a + b, 0)}</span>
          </button>
        ))}
      </div>
      <div className="grid gap-2 border-b border-border p-3 sm:grid-cols-2 lg:grid-cols-4" role="search" aria-label="Filter files">
        <Input placeholder="Search name, tag or person…" aria-label="Search files" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <Select aria-label="Department" value={f.dept ?? ""} onChange={(e) => setF({ ...f, dept: e.target.value })}>
          <option value="">Every department</option>
          <option value="client">Client files</option>
          {list.data?.departments?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Shared" value={f.shared ?? ""} onChange={(e) => setF({ ...f, shared: e.target.value as Shared })}>
          <option value="">Shared or not</option>
          <option value="clients">With clients (both ways)</option>
          <option value="to_client">Sent to clients</option>
          <option value="from_client">From clients</option>
          <option value="internal">Internal only</option>
        </Select>
        {!clientOrgId && (
          <Select aria-label="Filter by client" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value, project: "" })}>
            <option value="">Every client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        {!engagementId && (
          <Select aria-label="Filter by project" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} disabled={!client}>
            <option value="">{client ? "Every project" : "Pick a client first"}</option>
            {client?.engagements.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs text-ink-muted">
        <span>
          {shown.length} of {rows.length} files
        </span>
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" className="accent-[#8BB72C]" checked={f.archived} onChange={(e) => setF({ ...f, archived: e.target.checked })} /> Show archived
        </label>
      </div>
      {!list.data ? (
        <div className="p-4">
          <LoadState loading={list.loading} error={list.error} />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyAdd title={f.archived ? "No archived files" : "No files yet"} body="Upload working files, finals and brand assets. Clients' uploads land in From client." action={upload && !f.archived ? <AddButton onClick={upload}>+ Upload the first file</AddButton> : undefined} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm" data-testid="file-table">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                <th className="w-8 px-3 py-2">
                  <input type="checkbox" className="accent-[#8BB72C]" aria-label="Select all files" checked={sel.allSelected} onChange={sel.toggleAll} />
                </th>
                <th className="px-3 py-2">File</th>
                <th className="px-3 py-2">Folder</th>
                <th className="px-3 py-2">Shared</th>
                {!clientOrgId && <th className="px-3 py-2">Client</th>}
                <th className="px-3 py-2">Uploaded</th>
                <th className="px-3 py-2 text-right">Size</th>
                <th className="w-10 px-3 py-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b border-border align-top" data-file={r.name}>
                  <td className="px-3 py-2">
                    <input type="checkbox" className="accent-[#8BB72C]" aria-label={`Select ${r.name}`} checked={sel.has(r.id)} onChange={() => sel.toggle(r.id)} />
                  </td>
                  <td className="px-3 py-2">
                    <a href={r.url} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">
                      {r.name}
                    </a>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {r.released && <Badge tone="green">released to client</Badge>}
                      {r.shares > 0 && <Badge>shared {r.shares}</Badge>}
                      {r.archivedAt && <Badge tone="neutral">archived</Badge>}
                      {r.tags.map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {opsFileFolderLabels[r.folder]}
                    <span className="block text-xs text-ink-muted">{r.department?.name ?? "Client file"}</span>
                  </td>
                  <td className="px-3 py-2" data-testid="file-shared">
                    {r.direction && <Badge tone={DIRECTION_TONE[r.direction]}>{opsFileDirectionLabels[r.direction]}</Badge>}
                    <span className="mt-0.5 block text-xs text-ink-muted">
                      {[r.source ? opsFileSourceLabels[r.source] : null, r.direction !== "internal" ? r.sharedBy : null].filter(Boolean).join(" · ")}
                    </span>
                  </td>
                  {!clientOrgId && (
                    <td className="px-3 py-2">
                      {r.client?.name ?? "—"}
                      {r.engagement && <span className="block text-xs text-ink-muted">{r.engagement.name}</span>}
                    </td>
                  )}
                  <td className="whitespace-nowrap px-3 py-2 text-ink-muted">
                    {fmtDay(r.createdAt)}
                    {r.uploadedBy && <span className="block text-xs">{r.uploadedBy}</span>}
                  </td>
                  <td className="px-3 py-2 text-right text-ink-muted">{fmtSize(r.sizeBytes)}</td>
                  <td className="px-3 py-2">
                    <RowMenu
                      label={`More actions for ${r.name}`}
                      items={[
                        { key: "open", label: "Open / download", href: r.url },
                        { key: "edit", label: "Move, rename or tag", hidden: !r.can.edit || !!r.archivedAt, onSelect: () => setEditing(r) },
                        { key: "release", label: "Release to client", hidden: r.folder !== "final" || r.released || !r.can.release, disabledReason: r.releaseBlockedReason, onSelect: () => release(r) },
                        { key: "share", label: "Share link", hidden: !r.can.share || !!r.archivedAt, onSelect: () => setSharing(r) },
                        { key: "history", label: "History", onSelect: () => setHistory(r) },
                        { key: "archive", label: "Archive", danger: true, hidden: !r.can.archive || !!r.archivedAt, onSelect: () => setArchiving([r.id]) },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-ink-muted">
                    No files match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <BulkBar count={sel.count} onClear={sel.clear} label="files">
        <select
          aria-label="Move selected to folder"
          className="border border-ivory/40 bg-charcoal px-2 py-1 text-xs"
          value={bulkMove}
          onChange={(e) => {
            const folder = e.target.value as OpsFileFolder;
            setBulkMove("");
            if (folder) bulkUpdate(() => ({ folder }), `Moved to ${opsFileFolderLabels[folder]}`);
          }}
        >
          <option value="">Move to folder…</option>
          {OPS_FILE_FOLDERS.filter((x) => x !== "from_client").map((x) => (
            <option key={x} value={x}>
              {opsFileFolderLabels[x]}
            </option>
          ))}
        </select>
        <BulkButton
          onClick={() => {
            const tag = window.prompt("Tag to add to the selected files")?.trim();
            if (tag) bulkUpdate((r) => ({ tags: [...new Set([...r.tags, tag])] }), `Tagged "${tag}"`);
          }}
        >
          Tag
        </BulkButton>
        <BulkButton onClick={() => setArchiving(sel.ids)}>Archive</BulkButton>
      </BulkBar>
      {editing && <EditFileDialog file={editing} departments={list.data?.departments ?? []} engagements={clients.find((c) => c.id === editing.client?.id)?.engagements ?? []} onClose={() => setEditing(null)} onDone={(m) => (notify(m), reload())} />}
      {sharing && <ShareDialog file={sharing} onClose={() => (setSharing(null), reload())} />}
      {history && (
        <ActionDialog open title={`History of ${history.name}`} onClose={() => setHistory(null)} testId="file-history">
          <HistoryTab entity="File" id={history.id} />
        </ActionDialog>
      )}
      <ReasonDialog open={!!archiving} title={archiving?.length === 1 ? "Archive this file?" : `Archive ${archiving?.length ?? 0} files?`} confirm="Archive" danger onClose={() => setArchiving(null)} onConfirm={(reason) => archive(archiving ?? [], reason)}>
        <p className="text-sm text-ink-muted">Archived files are hidden from the client and the team lists. Undo from the toast.</p>
      </ReasonDialog>
    </section>
  );
}

function EditFileDialog({ file, engagements, departments, onClose, onDone }: { file: OpsFileRow; engagements: { id: string; name: string }[]; departments: { id: string; name: string }[]; onClose: () => void; onDone: (message: string) => void }) {
  const [name, setName] = useState(file.name);
  const [folder, setFolder] = useState<OpsFileFolder>(file.folder);
  const [tags, setTags] = useState(file.tags.join(", "));
  const [engagementId, setEngagement] = useState(file.engagement?.id ?? "");
  const [departmentId, setDepartment] = useState(file.department?.id ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!name.trim()) return setError("Give the file a name");
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.ops.files.update(file.id, { name: name.trim(), folder, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), engagementId: engagementId || null, departmentId: departmentId || null });
      onDone(r.message);
      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog
      open
      title="Move, rename, tag or change department"
      onClose={onClose}
      testId="file-edit-dialog"
      footer={
        <>
          <button type="button" disabled={busy} onClick={save} className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40">
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={onClose} className="ml-auto px-3 py-2 text-sm text-ink-muted hover:text-ink">
            Cancel
          </button>
        </>
      }
    >
      <Field label="Name" required>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" />
      </Field>
      <Field label="Folder" required hint={folder === "final" && !file.released ? "Finals reach the client only when released after Gate 5." : undefined}>
        <select className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value as OpsFileFolder)} aria-label="Folder">
          {OPS_FILE_FOLDERS.filter((x) => x !== "from_client" || file.folder === "from_client").map((x) => (
            <option key={x} value={x}>
              {opsFileFolderLabels[x]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Department" hint="Team members see their own department's files; Client files are for everyone working on the client.">
        <select className={inputCls} value={departmentId} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
          <option value="">Client file (no department)</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>
      {engagements.length > 0 && (
        <Field label="Project">
          <select className={inputCls} value={engagementId} onChange={(e) => setEngagement(e.target.value)} aria-label="Project">
            <option value="">Not for one project</option>
            {engagements.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Tags" hint="Separate with commas">
        <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
      </Field>
      {error && <p className="text-sm text-red" role="alert">{error}</p>}
    </ActionDialog>
  );
}

function ShareDialog({ file, onClose }: { file: OpsFileRow; onClose: () => void }) {
  const links = useLoad(() => api.ops.files.shares(file.id));
  const [days, setDays] = useState("7");
  const [password, setPassword] = useState("");
  const [made, setMade] = useState<OpsShareLinkView | null>(null);
  const [now] = useState(() => Date.now());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function create() {
    const n = Number(days);
    if (!(n >= 1 && n <= 90)) return setError("Pick 1 to 90 days");
    if (password && password.length < 4) return setError("Use at least 4 characters for the password");
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.ops.files.share(file.id, { expiresInDays: n, password });
      setMade(r);
      setPassword("");
      links.reload();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    try {
      await api.ops.files.revokeShare(id);
      links.reload();
    } catch (e) {
      setError(errMsg(e));
    }
  }
  return (
    <ActionDialog
      open
      title={`Share ${file.name}`}
      onClose={onClose}
      testId="share-dialog"
      footer={
        <>
          <button type="button" disabled={busy} onClick={create} className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40">
            {busy ? "Creating…" : "Create link"}
          </button>
          <button type="button" onClick={onClose} className="ml-auto px-3 py-2 text-sm text-ink-muted hover:text-ink">
            Done
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-muted">Anyone with the link can download this file until it expires. Add a password for anything sensitive.</p>
      <Field label="Expires after" required>
        <select className={inputCls} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Expires after">
          {[1, 3, 7, 14, 30, 90].map((d) => (
            <option key={d} value={d}>
              {d} day{d === 1 ? "" : "s"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Password (optional)">
        <input className={inputCls} type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
      </Field>
      {error && <p className="text-sm text-red" role="alert">{error}</p>}
      {made && (
        <div className="border border-green bg-green/10 p-3 text-sm" data-testid="share-made">
          <p className="font-medium">Link ready{made.hasPassword ? " (password protected)" : ""}</p>
          <div className="mt-2 flex gap-2">
            <input readOnly className={inputCls} value={made.url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="border border-border px-3 text-xs" onClick={() => navigator.clipboard?.writeText(made.url)}>
              Copy
            </button>
          </div>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-xs font-medium">Links</h3>
        {links.loading && <p className="text-xs text-ink-muted">Loading…</p>}
        {links.data?.length === 0 && <p className="text-xs text-ink-muted">No links yet.</p>}
        <ul className="divide-y divide-border text-xs">
          {links.data?.map((l) => {
            const expired = Date.parse(l.expiresAt) < now;
            return (
              <li key={l.id} className="flex items-center justify-between gap-2 py-1.5">
                <span>
                  {l.revoked ? "Revoked" : expired ? "Expired" : `Expires ${fmtDay(l.expiresAt)}`} · {l.views} view{l.views === 1 ? "" : "s"}
                  {l.hasPassword ? " · password" : ""} · {l.createdBy}
                </span>
                {!l.revoked && !expired && (
                  <button type="button" className="text-red underline" onClick={() => revoke(l.id)}>
                    Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </ActionDialog>
  );
}
