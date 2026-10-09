"use client";

import { useState } from "react";
import { NOTIFICATION_KINDS, OPS_WHATSAPP_STATUSES, opsWhatsappStatusLabels, type OpsWhatsappStatus, type SettingsValue } from "@bmu/shared";
import { Panel, Tabs } from "@/components/dash";
import { Badge, Input, LoadState, PageTitle } from "@/components/ui";
import { ReadOnlyNote, SaveBar, useSaver, useSettingsAndAccess } from "../_platform/kit";

type Templates = SettingsValue<"notificationTemplates">;
type Channel = "inApp" | "email" | "whatsapp";
const CHANNELS: { key: Channel; label: string }[] = [
  { key: "inApp", label: "In-app" },
  { key: "email", label: "Email" },
  { key: "whatsapp", label: "WhatsApp" },
];

const SAMPLE: Record<string, string> = {
  draft_ready: "Your Instagram post for Diwali is ready for review.",
  invoice_issued: "Invoice BMU/2026-10/0042 for ₹35,400 is ready. Due on 15 Oct.",
  request_quote: "We've sent a quote for your extra request: 3 extra reels.",
  message: "Ananya from BMU: “Sharing the updated calendar for next week.”",
  request_created: "Sunrise Bakery raised an urgent request: Fix today's banner.",
  qc_waiting: "Version 2 of “Diwali offer post” is waiting for QC.",
  qc_failed: "QC failed “Diwali offer post”: price does not match the brief.",
  changes_requested: "Sunrise Bakery asked for changes on “Diwali offer post”.",
  addon_paid: "Sunrise Bakery paid for an extra request. Work can be scheduled.",
  leave_request: "Rahul asked for leave on 20–21 Oct.",
};

export default function NotificationTemplatesPage() {
  const data = useSettingsAndAccess();
  if (!data.data) {
    return (
      <>
        <PageTitle title="Notification Templates" subtitle="Which alerts go out, on which channel, and what they say." />
        <LoadState loading={data.loading} error={data.error} />
      </>
    );
  }
  return <Editor initial={data.data.settings.notificationTemplates} canEdit={data.data.access.platform} brand={data.data.settings.branding.clientAppName} />;
}

function Editor({ initial, canEdit, brand }: { initial: Templates; canEdit: boolean; brand: string }) {
  const fill = (t: Templates) => Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k.key, t[k.key] ?? { inApp: true, email: false, whatsapp: false, text: "" }])) as Templates;
  const [saved, setSaved] = useState(() => fill(initial));
  const [t, setT] = useState(() => fill(initial));
  const [selected, setSelected] = useState(NOTIFICATION_KINDS[0].key);
  const [channel, setChannel] = useState<Channel>("inApp");
  const { busy, msg, setMsg, save } = useSaver("notificationTemplates", (s) => {
    setSaved(fill(s.notificationTemplates));
    setT(fill(s.notificationTemplates));
  });
  const dirty = JSON.stringify(saved) !== JSON.stringify(t);
  const patch = (key: string, p: Partial<Templates[string]>) => setT({ ...t, [key]: { ...t[key], ...p } });
  const kind = NOTIFICATION_KINDS.find((k) => k.key === selected)!;
  const body = t[selected].text.trim() || SAMPLE[selected] || kind.label;

  return (
    <>
      <PageTitle title="Notification Templates" subtitle="Which alerts go out, on which channel, and what they say. Leave the text empty to use the standard wording." />
      {!canEdit && <ReadOnlyNote who="platform" />}
      <p className="mb-6 border border-amber bg-amber/15 px-4 py-3 text-sm">
        <strong className="font-medium">Development mode:</strong> in-app notifications are delivered. Email and WhatsApp are not sent yet; they are written to the server log until SMTP and WhatsApp are set up in{" "}
        <a href="/admin/integrations" className="underline">
          Integrations
        </a>
        .
      </p>
      <div className="grid gap-6 [&>*]:min-w-0 xl:grid-cols-[1fr_360px]">
        <Panel flush className="min-w-0" title="Alerts" subtitle="Tick the channels for each alert">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-border text-[11px] uppercase tracking-[0.1em] text-ink-muted">
                  <th className="px-4 py-2.5 text-left font-medium">Alert</th>
                  {CHANNELS.map((c) => (
                    <th key={c.key} className="px-2 py-2.5 text-center font-medium">
                      {c.label}
                    </th>
                  ))}
                  <th className="px-2 py-2.5 text-left font-medium">WhatsApp (Meta)</th>
                  <th className="px-4 py-2.5 text-left font-medium">Custom text</th>
                </tr>
              </thead>
              <tbody>
                {NOTIFICATION_KINDS.map((k) => (
                  <tr key={k.key} onClick={() => setSelected(k.key)} className={`cursor-pointer border-b border-border last:border-0 ${selected === k.key ? "bg-canvas/60" : "hover:bg-canvas/30"}`}>
                    <td className="px-4 py-3">
                      <span className="block font-medium">{k.label}</span>
                      <span className="text-xs text-ink-muted">{k.audience === "client" ? "To clients" : "To the team"}</span>
                    </td>
                    {CHANNELS.map((c) => (
                      <td key={c.key} className="px-2 py-3 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[#121F2F]"
                          aria-label={`${k.label}: ${c.label}`}
                          disabled={!canEdit || (c.key === "whatsapp" && t[k.key].whatsappStatus !== "approved" && !t[k.key].whatsapp)}
                          title={c.key === "whatsapp" && t[k.key].whatsappStatus !== "approved" ? "WhatsApp can only be turned on once Meta has approved the template" : undefined}
                          checked={t[k.key][c.key]}
                          onChange={(e) => patch(k.key, { [c.key]: e.target.checked })}
                        />
                      </td>
                    ))}
                    <td className="px-2 py-3">
                      <select
                        className="border border-border bg-surface-raised px-2 py-1 text-xs"
                        aria-label={`${k.label}: WhatsApp approval`}
                        disabled={!canEdit}
                        value={t[k.key].whatsappStatus ?? "not_submitted"}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const st = e.target.value as OpsWhatsappStatus;
                          patch(k.key, { whatsappStatus: st, ...(st !== "approved" ? { whatsapp: false } : {}) });
                        }}
                      >
                        {OPS_WHATSAPP_STATUSES.map((st) => (
                          <option key={st} value={st}>
                            {opsWhatsappStatusLabels[st]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <Input className="py-1.5" maxLength={500} disabled={!canEdit} placeholder="Standard wording" value={t[k.key].text} onFocus={() => setSelected(k.key)} onChange={(e) => patch(k.key, { text: e.target.value })} aria-label={`${k.label}: custom text`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Preview" subtitle={kind.label} action={<Tabs value={channel} onChange={setChannel} options={CHANNELS.map((c) => ({ value: c.key, label: c.label }))} />}>
          {!t[selected][channel] && (
            <p className="mb-4">
              <Badge tone="amber">Off for this alert</Badge>
            </p>
          )}
          {channel === "inApp" && (
            <div className="border border-border bg-surface-raised p-4 shadow-[0_8px_24px_-12px_rgba(18,31,47,0.25)]">
              <div className="flex items-start gap-3">
                <span className="mt-1.5 h-2 w-2 shrink-0 bg-green" />
                <div>
                  <p className="text-sm font-medium">{kind.label}</p>
                  <p className="mt-0.5 text-sm text-ink-muted">{body}</p>
                  <p className="mt-2 text-[11px] text-ink-muted">Just now</p>
                </div>
              </div>
            </div>
          )}
          {channel === "email" && (
            <div className="border border-border">
              <div className="border-b border-border px-4 py-2 text-xs text-ink-muted">
                <p>
                  From: <span className="text-ink">{brand}</span>
                </p>
                <p>
                  Subject: <span className="text-ink">{kind.label}</span>
                </p>
              </div>
              <div className="space-y-3 p-4 text-sm">
                <p>Hello,</p>
                <p>{body}</p>
                <span className="inline-block bg-charcoal px-3 py-1.5 text-xs text-ivory">Open {brand}</span>
                <p className="text-xs text-ink-muted">You are receiving this because you have an account on {brand}.</p>
              </div>
            </div>
          )}
          {channel === "whatsapp" && (
            <div className="bg-[#efeae2] p-4">
              <div className="ml-auto max-w-[85%] bg-white p-3 text-sm shadow-sm">
                <p className="font-medium">{kind.label}</p>
                <p className="mt-1">{body}</p>
                <p className="mt-1 text-right text-[10px] text-ink-muted">10:42</p>
              </div>
            </div>
          )}
        </Panel>
      </div>
      {canEdit && (
        <SaveBar
          busy={busy}
          dirty={dirty}
          msg={msg}
          onSave={() => save(t)}
          onReset={() => {
            setT(saved);
            setMsg(undefined);
          }}
        />
      )}
    </>
  );
}
