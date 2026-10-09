"use client";

import { useState } from "react";
import type { ServiceNotificationPref, ServiceNotificationPrefsView } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { Button, Input, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

type Routing = Pick<ServiceNotificationPrefsView, "quietStart" | "quietEnd" | "digest" | "digestHour">;

/**
 * Each person chooses which alerts reach them in the app, by email and on WhatsApp, plus quiet hours and a daily
 * digest (v17). Saved on the server and respected everywhere. Money and approval alerts are never held back.
 */
export function NotificationPrefsPanel() {
  const state = useLoad(() => api.service.prefs());
  const [draft, setDraft] = useState<ServiceNotificationPref[]>();
  const [routing, setRouting] = useState<Routing>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const prefs = draft ?? state.data?.prefs;
  const r: Routing | undefined = routing ?? (state.data ? { quietStart: state.data.quietStart, quietEnd: state.data.quietEnd, digest: state.data.digest, digestHour: state.data.digestHour } : undefined);
  const dirty = !!draft || !!routing;
  const hasPhone = !!state.data?.phone;

  function toggle(kind: string, field: "inApp" | "email" | "whatsapp") {
    setMsg(undefined);
    setDraft((prefs ?? []).map((p) => (p.kind === kind ? { ...p, [field]: !p[field] } : p)));
  }
  const setR = (patch: Partial<Routing>) => {
    setMsg(undefined);
    if (r) setRouting({ ...r, ...patch });
  };

  async function save() {
    if (!prefs || !r) return;
    if (!!r.quietStart !== !!r.quietEnd) {
      setMsg({ ok: false, text: "Set both quiet hours times, or neither." });
      return;
    }
    setBusy(true);
    setMsg(undefined);
    try {
      const v = await api.service.savePrefs({ prefs: prefs.map((p) => ({ kind: p.kind, inApp: p.inApp, email: p.email, whatsapp: p.whatsapp })), quietStart: r.quietStart || null, quietEnd: r.quietEnd || null, digest: r.digest, digestHour: r.digestHour });
      setDraft(undefined);
      setRouting(undefined);
      state.reload();
      setMsg({ ok: true, text: `Saved. We'll use these from now on.${v.waiting ? ` ${v.waiting} alert${v.waiting === 1 ? " is" : "s are"} waiting for quiet hours or your digest.` : ""}` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="What we tell you about"
      subtitle={state.data ? `${state.data.email ? `Emails go to ${state.data.email}.` : "Add an email address to get emails."} ${hasPhone ? `WhatsApp goes to ${state.data.phone}.` : "Add a phone number to get WhatsApp alerts."}` : undefined}
      action={prefs && <Button className="px-3 py-1 text-xs" disabled={busy || !dirty} onClick={save}>{busy ? "Saving…" : "Save"}</Button>}
      flush
    >
      {!prefs || !r ? (
        <div className="p-5">
          <LoadState loading={state.loading} error={state.error} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="notification-prefs">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                <th className="px-5 py-2 font-normal">Alert</th>
                <th className="px-3 py-2 text-center font-normal">In the app</th>
                <th className="px-3 py-2 text-center font-normal">Email</th>
                <th className="px-3 py-2 text-center font-normal">WhatsApp</th>
              </tr>
            </thead>
            <tbody>
              {prefs.map((p) => (
                <tr key={p.kind} className="border-b border-border last:border-0">
                  <td className="px-5 py-2.5">
                    {p.label}
                    {p.locked && <span className="block text-[11px] text-ink-muted">Always shown in the app (money and approvals)</span>}
                    {!p.orgEmail && <span className="block text-[11px] text-ink-muted">Email for this is off for everyone</span>}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <input type="checkbox" aria-label={`${p.label} in the app`} checked={p.locked || p.inApp} disabled={p.locked || !p.orgInApp} onChange={() => toggle(p.kind, "inApp")} />
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <input type="checkbox" aria-label={`${p.label} by email`} checked={p.email && p.orgEmail} disabled={!p.orgEmail} onChange={() => toggle(p.kind, "email")} />
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <input type="checkbox" aria-label={`${p.label} on WhatsApp`} checked={p.whatsapp && hasPhone} disabled={!hasPhone} onChange={() => toggle(p.kind, "whatsapp")} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid gap-4 border-t border-border px-5 py-4 text-sm sm:grid-cols-2" data-testid="notification-routing">
            <div>
              <p className="font-medium">Quiet hours</p>
              <p className="mb-2 text-xs text-ink-muted">Emails and WhatsApp alerts wait until quiet hours end (India time). Money and approval alerts still come through.</p>
              <div className="flex items-center gap-2">
                <Input className="w-28" type="time" value={r.quietStart ?? ""} onChange={(e) => setR({ quietStart: e.target.value || null })} aria-label="Quiet from" />
                <span>to</span>
                <Input className="w-28" type="time" value={r.quietEnd ?? ""} onChange={(e) => setR({ quietEnd: e.target.value || null })} aria-label="Quiet until" />
                {(r.quietStart || r.quietEnd) && (
                  <button className="text-xs underline" onClick={() => setR({ quietStart: null, quietEnd: null })}>
                    Off
                  </button>
                )}
              </div>
            </div>
            <div>
              <p className="font-medium">Daily digest</p>
              <p className="mb-2 text-xs text-ink-muted">Get one email a day with everything, instead of an email per alert.</p>
              <div className="flex items-center gap-2">
                <Select value={r.digest} onChange={(e) => setR({ digest: e.target.value as Routing["digest"] })} aria-label="Digest">
                  <option value="off">Off, email me each time</option>
                  <option value="daily">One email a day</option>
                </Select>
                {r.digest === "daily" && (
                  <Select value={r.digestHour} onChange={(e) => setR({ digestHour: Number(e.target.value) })} aria-label="Digest time">
                    {Array.from({ length: 17 }, (_, i) => i + 6).map((h) => (
                      <option key={h} value={h}>
                        at {h > 12 ? `${h - 12} pm` : h === 12 ? "12 pm" : `${h} am`}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            </div>
          </div>
          {msg && <p className={`px-5 py-3 text-sm ${msg.ok ? "text-[#5f8a12]" : "text-red"}`}>{msg.text}</p>}
        </div>
      )}
    </Panel>
  );
}
