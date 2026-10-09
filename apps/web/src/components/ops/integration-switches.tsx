"use client";

/** Admin → Integrations: turn each service on or off for the agency (keys stay on the server; disconnect needs a reason). */
import { useState } from "react";
import type { OpsIntegrationRow } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Badge, LoadState } from "@/components/ui";
import { errMsg, fmtDay, GhostButton, ReasonDialog } from "./kit";

export function IntegrationSwitches() {
  const list = useLoad(() => api.ops.admin.integrations());
  const [off, setOff] = useState<OpsIntegrationRow | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean }>();
  async function connect(r: OpsIntegrationRow) {
    setMsg(undefined);
    try {
      setMsg({ text: (await api.ops.admin.connect(r.key)).message });
      list.reload();
    } catch (e) {
      setMsg({ text: errMsg(e), bad: true });
    }
  }
  return (
    <section className="mb-6 border border-border bg-surface-raised" data-testid="integration-switches">
      <header className="border-b border-border px-5 py-3">
        <h2 className="text-[15px] font-semibold">Connect or disconnect</h2>
        <p className="text-sm text-ink-muted">Founders and Admins only. A service can be connected once its keys are on the server.</p>
      </header>
      {msg && <p className={`border-b border-border px-5 py-2 text-sm ${msg.bad ? "text-red" : ""}`} role="status">{msg.text}</p>}
      {!list.data ? (
        <div className="p-5">
          <LoadState loading={list.loading} error={list.error} />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {list.data.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm" data-integration={r.key}>
              <span>
                <span className="font-medium">{r.label}</span>{" "}
                {r.connected ? <Badge tone="green">Connected</Badge> : r.configured ? <Badge tone="neutral">Ready to connect</Badge> : <Badge tone="neutral">No keys yet</Badge>}
                {r.connected && r.connectedBy && (
                  <span className="block text-xs text-ink-muted">
                    by {r.connectedBy}
                    {r.connectedAt ? ` on ${fmtDay(r.connectedAt)}` : ""}
                  </span>
                )}
              </span>
              {r.connected ? (
                <GhostButton onClick={() => setOff(r)}>Disconnect</GhostButton>
              ) : (
                <GhostButton onClick={() => connect(r)} disabled={!r.configured}>
                  Connect
                </GhostButton>
              )}
            </li>
          ))}
        </ul>
      )}
      <ReasonDialog
        open={!!off}
        title={`Disconnect ${off?.label ?? ""}?`}
        confirm="Disconnect"
        danger
        onClose={() => setOff(null)}
        onConfirm={async (reason) => {
          const r = await api.ops.admin.disconnect(off!.key, reason);
          setMsg({ text: r.message });
          list.reload();
        }}
      >
        <p className="text-sm text-ink-muted">Anything that depends on it stops until it is connected again.</p>
      </ReasonDialog>
    </section>
  );
}
