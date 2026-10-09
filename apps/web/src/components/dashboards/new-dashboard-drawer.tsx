"use client";

/** v12: "+ New dashboard": name, a starting point (blank, template or copy), who sees it and where. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { DashboardAudience, DashboardPlacement, DashboardStudio } from "@bmu/shared";
import { ActionDrawer, Field, TextArea } from "@/components/actions/action-drawer";
import { Input, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { AudiencePicker, PlacementSelect } from "./audience-picker";

export function NewDashboardDrawer({ open, onClose, studio: given, copyFromId }: { open: boolean; onClose: () => void; studio?: DashboardStudio; copyFromId?: string }) {
  const router = useRouter();
  const [studio, setStudio] = useState<DashboardStudio | undefined>(given);
  const [loadError, setLoadError] = useState<string>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startFrom, setStartFrom] = useState(copyFromId ? "copy" : "blank");
  const [copyFrom, setCopyFrom] = useState(copyFromId ?? "");
  const [placement, setPlacement] = useState<DashboardPlacement>("menu");
  const [audience, setAudience] = useState<DashboardAudience>({ everyone: false, roles: [], specialties: [], userIds: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && !given && !studio) api.dashboards.studio().then(setStudio, (e: Error) => setLoadError(e.message));
  }, [open, given, studio]);
  const s = given ?? studio;

  async function submit() {
    setError(null);
    if (!name.trim()) return setError("Give the dashboard a name");
    if (startFrom === "copy" && !copyFrom) return setError("Pick the dashboard to copy");
    setSaving(true);
    try {
      const d = await api.dashboards.create({ name, description: description || undefined, placement, audience, startFrom, copyFromId: startFrom === "copy" ? copyFrom : undefined });
      onClose();
      router.push(`/admin/dashboards/${d.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const copyable = s ? [...s.builtins.filter((b) => b.builtin !== "client_home"), ...s.custom] : [];
  return (
    <ActionDrawer open={open} title="New dashboard" subtitle="Build it from numbers, charts, lists and any built-in section, then choose who sees it." onClose={onClose} onSubmit={submit} saving={saving} error={error} saveLabel="Create and open the editor" wide testId="new-dashboard-drawer">
      {!s ? (
        <LoadState loading={!loadError} error={loadError} />
      ) : (
        <>
          <Field label="Name" required htmlFor="dash-name">
            <Input id="dash-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales team this month" className="w-full" maxLength={80} />
          </Field>
          <Field label="What it is for" htmlFor="dash-desc">
            <TextArea id="dash-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Shown under the title" maxLength={300} />
          </Field>
          <Field label="Start from">
            <div className="grid gap-2 sm:grid-cols-2">
              {[...s.templates, { key: "copy", name: "Copy of a dashboard", hint: "Any built-in or custom dashboard" }].map((t) => (
                <label key={t.key} className={`flex cursor-pointer gap-2 border px-3 py-2.5 text-sm ${startFrom === t.key ? "border-charcoal" : "border-border hover:border-ink"}`}>
                  <input type="radio" name="startFrom" value={t.key} checked={startFrom === t.key} onChange={() => setStartFrom(t.key)} className="mt-0.5" />
                  <span>
                    <span className="block font-medium">{t.name}</span>
                    <span className="block text-xs text-ink-muted">{t.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          {startFrom === "copy" && (
            <Field label="Dashboard to copy" htmlFor="dash-copy">
              <Select id="dash-copy" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} className="w-full">
                <option value="">Pick one</option>
                {copyable.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.builtin ? " (built-in)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <PlacementSelect value={placement} onChange={setPlacement} />
          <Field label="Who sees it">
            <AudiencePicker value={audience} onChange={setAudience} studio={s} />
          </Field>
        </>
      )}
    </ActionDrawer>
  );
}
