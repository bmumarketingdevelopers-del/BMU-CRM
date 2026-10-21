"use client";

// v35: every file sent to and received from clients, by anyone, on the Founder's Weekly Review. Hidden for others
// (the API answers 403). The Founder also gets a daily summary notification after 19:00 IST.
import Link from "next/link";
import { useState } from "react";
import { opsFileDirectionLabels, opsFileSourceLabels } from "@bmu/shared";
import { Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { Badge, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { fmtSize } from "./kit";

const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

type Days = "1" | "7" | "30";

export function ClientFilesPanel() {
  const [days, setDays] = useState<Days>("7");
  // Keyed by the period so each one loads fresh.
  return <Feed key={days} days={days} setDays={setDays} />;
}

function Feed({ days, setDays }: { days: Days; setDays: (d: Days) => void }) {
  const s = useLoad(() => api.ops.files.clientFeed(Number(days)), { live: ["File", "Message", "Version"] });
  if (!s.data) return s.error ? null : <LoadState loading={s.loading} />;
  const d = s.data;
  return (
    <Panel
      className="min-w-0"
      title="Client files"
      subtitle="Every file sent to and received from clients, by anyone: chat, work for review, uploads, brand kits and assets."
      action={
        <span className="flex items-center gap-3">
          <Tabs value={days} onChange={setDays} options={[{ value: "1", label: "Today" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} />
          <Link href="/team/files?shared=clients" className="text-xs text-ink-muted hover:text-ink">
            All →
          </Link>
        </span>
      }
    >
      {!d ? (
        <LoadState loading />
      ) : (
        <div className="space-y-4" data-testid="client-files">
          <StatRow cols={2}>
            <StatTile label="Sent to clients" value={d.sent} />
            <StatTile label="Received from clients" value={d.received} tone={d.received ? "good" : "default"} />
          </StatRow>
          {d.rows.length === 0 ? (
            <p className="text-sm text-ink-muted">No files shared with clients in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                    <th className="py-2 pr-3">File</th>
                    <th className="py-2 pr-3">Client</th>
                    <th className="py-2 pr-3">Shared</th>
                    <th className="py-2 pr-3">By</th>
                    <th className="py-2 text-right">When</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.id} className="border-b border-border">
                      <td className="py-2 pr-3">
                        <a href={r.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                          {r.name}
                        </a>
                        <span className="block text-xs text-ink-muted">{[opsFileSourceLabels[r.source], fmtSize(r.sizeBytes)].filter(Boolean).join(" · ")}</span>
                      </td>
                      <td className="py-2 pr-3">
                        {r.client ? (
                          <Link href={`/team/clients/${r.client.id}`} className="hover:underline">
                            {r.client.name}
                          </Link>
                        ) : (
                          "—"
                        )}
                        {r.engagement && <span className="block text-xs text-ink-muted">{r.engagement.name}</span>}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone={r.direction === "to_client" ? "green" : "amber"}>{opsFileDirectionLabels[r.direction]}</Badge>
                      </td>
                      <td className="py-2 pr-3">{r.uploadedBy ?? "—"}</td>
                      <td className="py-2 text-right whitespace-nowrap text-ink-muted">{when.format(new Date(r.sharedAt))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
