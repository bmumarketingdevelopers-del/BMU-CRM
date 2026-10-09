"use client";

/** "+ New → File upload" (also on client and project pages): upload into a client's folder, tagged and linked to a project. */
import { useState } from "react";
import { OPS_FILE_FOLDERS, opsFileFolderLabels, type OpsFileFolder } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ActionDrawer, Field, inputCls, type SaveMode } from "@/components/actions/action-drawer";
import type { NewDrawerProps } from "@/components/actions/new-registry";
import { errMsg } from "./kit";

export function FileUploadDrawer({ open, onClose, prefill, onSaved }: NewDrawerProps) {
  const opts = useLoad(() => api.ops.threads.options());
  const [clientOrgId, setClient] = useState(prefill?.clientId ?? "");
  const [engagementId, setEngagement] = useState(prefill?.engagementId ?? "");
  const [folder, setFolder] = useState<OpsFileFolder>((prefill?.folder as OpsFileFolder) ?? "working");
  const [tags, setTags] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const client = opts.data?.clients.find((c) => c.id === clientOrgId) ?? (prefill?.engagementId ? opts.data?.clients.find((c) => c.engagements.some((e) => e.id === prefill.engagementId)) : undefined);
  const clientId = client?.id ?? clientOrgId;

  async function save(mode: SaveMode) {
    setError(undefined);
    const e: Record<string, string> = {};
    if (!clientId) e.client = "Pick the client";
    if (!files.length) e.file = "Choose at least one file";
    if (files.some((f) => f.size > 200 * 1024 * 1024)) e.file = "Files can be up to 200 MB each";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      let last: string | undefined;
      for (const f of files) last = (await api.ops.files.upload(f, { clientOrgId: clientId, engagementId: engagementId || undefined, folder, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) })).id;
      onSaved(last, files.length === 1 ? `${files[0].name} uploaded` : `${files.length} files uploaded`);
      setFiles([]);
      if (mode !== "another") onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionDrawer open={open} title="Upload files" subtitle="Team uploads stay internal. Final files reach the client only when released after Gate 5." onClose={onClose} onSubmit={save} saving={saving} error={error ?? opts.error} saveLabel="Upload" allowAnother testId="file-upload-drawer">
      <Field label="Client" required error={errors.client}>
        <select className={inputCls} value={clientId} onChange={(e) => (setClient(e.target.value), setEngagement(""))} aria-label="Client">
          <option value="">{opts.loading ? "Loading…" : "Pick a client…"}</option>
          {opts.data?.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      {client && client.engagements.length > 0 && (
        <Field label="Project">
          <select className={inputCls} value={engagementId} onChange={(e) => setEngagement(e.target.value)} aria-label="Project">
            <option value="">Not for one project</option>
            {client.engagements.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Folder" required>
        <select className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value as OpsFileFolder)} aria-label="Folder">
          {OPS_FILE_FOLDERS.filter((f) => f !== "from_client").map((f) => (
            <option key={f} value={f}>
              {opsFileFolderLabels[f]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Files" required error={errors.file} hint="Up to 200 MB each.">
        <input type="file" multiple className={inputCls} onChange={(e) => setFiles([...(e.target.files ?? [])])} aria-label="Files" />
      </Field>
      <Field label="Tags" hint="Separate with commas, e.g. logo, diwali">
        <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
      </Field>
    </ActionDrawer>
  );
}
