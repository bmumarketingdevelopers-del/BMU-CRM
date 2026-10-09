"use client";

import { useState } from "react";
import type { SettingsValue, TenantInfo } from "@bmu/shared";
import { KeyValues, Panel } from "@/components/dash";
import { Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Field, ReadOnlyNote, SaveBar, Textarea, useSaver } from "../_platform/kit";

type Tenant = SettingsValue<"tenant">;
const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

export default function TenantPage() {
  const data = useLoad(() => Promise.all([api.settings.all(), api.adminPlatform.access(), api.adminPlatform.tenant().catch(() => null)]));
  if (!data.data) {
    return (
      <>
        <PageTitle title="Tenant Settings" subtitle="Your agency's details used across BMU Hub." />
        <LoadState loading={data.loading} error={data.error} />
      </>
    );
  }
  const [settings, access, info] = data.data;
  return <Editor initial={settings.tenant} canEdit={access.platform} info={info} />;
}

function Editor({ initial, canEdit, info }: { initial: Tenant; canEdit: boolean; info: TenantInfo | null }) {
  const [saved, setSaved] = useState(initial);
  const [t, setT] = useState(initial);
  const { busy, msg, setMsg, save } = useSaver("tenant", (s) => {
    setSaved(s.tenant);
    setT(s.tenant);
  });
  const dirty = JSON.stringify(saved) !== JSON.stringify(t);
  const set = (p: Partial<Tenant>) => setT({ ...t, ...p });
  const problems = [
    !t.name.trim() && "The agency name is required.",
    t.supportEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t.supportEmail) && "The support email doesn't look right.",
    !(t.dataRetentionDays >= 30 && t.dataRetentionDays <= 3650) && "Keep data between 30 and 3650 days.",
  ].filter(Boolean) as string[];

  return (
    <>
      <PageTitle title="Tenant Settings" subtitle="Your agency's details. They appear on proposals, invoices, emails and the client app footer." />
      {!canEdit && <ReadOnlyNote who="platform" />}
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_320px]">
        <Panel title="Agency details">
          <fieldset disabled={!canEdit} className="grid gap-5 sm:grid-cols-2">
            <Field label="Agency name" className="sm:col-span-2">
              <Input value={t.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Support email" hint="Where clients write for help">
              <Input type="email" value={t.supportEmail} maxLength={200} onChange={(e) => set({ supportEmail: e.target.value })} />
            </Field>
            <Field label="Support phone">
              <Input value={t.supportPhone} maxLength={30} placeholder="+91 …" onChange={(e) => set({ supportPhone: e.target.value })} />
            </Field>
            <Field label="Website" className="sm:col-span-2">
              <Input value={t.website} maxLength={200} onChange={(e) => set({ website: e.target.value })} />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <Textarea rows={3} value={t.address} maxLength={500} onChange={(e) => set({ address: e.target.value })} />
            </Field>
            <Field label="Keep client data for" hint="After an engagement ends, personal data older than this can be removed (DPDP). Between 30 and 3650 days.">
              <div className="flex items-center gap-2">
                <Input type="number" min={30} max={3650} className="w-28!" value={t.dataRetentionDays} onChange={(e) => set({ dataRetentionDays: Number(e.target.value) })} />
                <span className="text-sm text-ink-muted">days (≈ {(t.dataRetentionDays / 365).toFixed(1)} years)</span>
              </div>
            </Field>
          </fieldset>
          {canEdit && (
            <SaveBar
              busy={busy}
              dirty={dirty}
              disabled={problems.length > 0}
              msg={problems.length ? { ok: false, text: problems.join(" ") } : msg}
              onSave={() => save(t)}
              onReset={() => {
                setT(saved);
                setMsg(undefined);
              }}
            />
          )}
        </Panel>
        <Panel title="Account">
          {info ? (
            <KeyValues
              items={[
                { k: "Plan", v: <span className="capitalize">{info.plan}</span> },
                { k: "Created", v: day.format(new Date(info.createdAt)) },
                { k: "Clients", v: info.clients },
                { k: "Team members", v: info.staff },
              ]}
            />
          ) : (
            <p className="text-sm text-ink-muted">Plan details are visible to the Founder and Admins.</p>
          )}
        </Panel>
      </div>
    </>
  );
}
