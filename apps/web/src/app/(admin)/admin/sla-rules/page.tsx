"use client";

import { useState } from "react";
import { REQUEST_TYPES, requestTypeLabels, SLA_FIRST_REPLY_MIN, type RequestType, type SettingsValue } from "@bmu/shared";
import { BarList, Panel } from "@/components/dash";
import { Input, LoadState, PageTitle, Select } from "@/components/ui";
import { ReadOnlyNote, SaveBar, useSaver, useSettingsAndAccess } from "../_platform/kit";

type Sla = SettingsValue<"sla">;
const DAY = 9 * 60; // working minutes in a 9:30–18:30 day

const fmtMinutes = (m: number) => {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return [h ? `${h} h` : "", r ? `${r} min` : ""].filter(Boolean).join(" ") || "0 min";
};

export default function SlaRulesPage() {
  const data = useSettingsAndAccess();
  if (!data.data) {
    return (
      <>
        <PageTitle title="SLA Rules" subtitle="How fast we reply to clients." />
        <LoadState loading={data.loading} error={data.error} />
      </>
    );
  }
  return <Editor initial={data.data.settings.sla} canEdit={data.data.access.operations} />;
}

function Editor({ initial, canEdit }: { initial: Sla; canEdit: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [sla, setSla] = useState(initial);
  const { busy, msg, setMsg, save } = useSaver("sla", (s) => {
    setSaved(s.sla);
    setSla(s.sla);
  });
  const dirty = JSON.stringify(saved) !== JSON.stringify(sla);
  const set = (t: RequestType, minutes: number) => setSla({ ...sla, firstReplyMinutes: { ...sla.firstReplyMinutes, [t]: minutes } });
  const bad = REQUEST_TYPES.filter((t) => !(sla.firstReplyMinutes[t] >= 15 && sla.firstReplyMinutes[t] <= 5400));

  return (
    <>
      <PageTitle title="SLA Rules" subtitle="How fast the Client Manager must send the first reply to each kind of client request. Timers count working hours only (9:30–18:30, Monday to Saturday, holidays skipped)." />
      {!canEdit && <ReadOnlyNote who="operations" />}
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_340px]">
        <Panel title="First reply to a client request" subtitle="Applies to requests created after you save. Between 15 minutes and 10 working days." flush>
          <ul className="divide-y divide-border">
            {REQUEST_TYPES.map((t) => {
              const m = sla.firstReplyMinutes[t];
              return (
                <li key={t} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{requestTypeLabels[t].team}</p>
                    <p className="text-xs text-ink-muted">
                      Client sees “{requestTypeLabels[t].client}” · default {fmtMinutes(SLA_FIRST_REPLY_MIN[t])}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    {canEdit ? (
                      <>
                        <Input type="number" min={0} max={90} className="w-20!" aria-label={`${requestTypeLabels[t].team} hours`} value={Math.floor(m / 60)} onChange={(e) => set(t, Math.max(0, Number(e.target.value)) * 60 + (m % 60))} />
                        <span className="text-ink-muted">h</span>
                        <Select aria-label={`${requestTypeLabels[t].team} minutes`} value={m % 60} onChange={(e) => set(t, Math.floor(m / 60) * 60 + Number(e.target.value))}>
                          {[...new Set([0, 15, 30, 45, m % 60])].sort((a, b) => a - b).map((x) => (
                            <option key={x} value={x}>
                              {x}
                            </option>
                          ))}
                        </Select>
                        <span className="text-ink-muted">min</span>
                      </>
                    ) : (
                      <span className="font-medium">{fmtMinutes(m)}</span>
                    )}
                    <span className="w-28 whitespace-nowrap text-right text-xs text-ink-muted">{m >= DAY ? `≈ ${(m / DAY).toFixed(m % DAY ? 1 : 0)} working day${m === DAY ? "" : "s"}` : "same day"}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
        <div className="space-y-6">
          <Panel title="At a glance" subtitle="Working time allowed for the first reply">
            <BarList items={REQUEST_TYPES.map((t) => ({ label: requestTypeLabels[t].team, value: sla.firstReplyMinutes[t], highlight: t === "urgent" }))} format={fmtMinutes} />
          </Panel>
          <Panel title="Replies to client messages" subtitle="Expected reply time for messages in the client app">
            {canEdit ? (
              <Select className="w-full py-2" value={sla.messageReply} onChange={(e) => setSla({ ...sla, messageReply: e.target.value as Sla["messageReply"] })}>
                <option value="same_working_day">Same working day</option>
                <option value="next_working_day">By the next working day</option>
              </Select>
            ) : (
              <p className="text-sm font-medium">{sla.messageReply === "same_working_day" ? "Same working day" : "By the next working day"}</p>
            )}
          </Panel>
        </div>
      </div>
      {canEdit && (
        <SaveBar
          busy={busy}
          dirty={dirty}
          disabled={bad.length > 0}
          msg={bad.length ? { ok: false, text: `${bad.map((t) => requestTypeLabels[t].team).join(", ")}: choose between 15 minutes and 90 hours.` } : msg}
          onSave={() => save(sla)}
          onReset={() => {
            setSla(saved);
            setMsg(undefined);
          }}
        />
      )}
    </>
  );
}
