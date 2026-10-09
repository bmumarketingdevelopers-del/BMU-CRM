"use client";

import { useState } from "react";
import type { AuditChainView } from "@bmu/shared";
import { Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default function AuditPage() {
  const rows = useLoad(() => api.audit.list());
  const [chain, setChain] = useState<AuditChainView | { error: string }>();
  const [checking, setChecking] = useState(false);
  async function verify() {
    setChecking(true);
    try {
      setChain(await api.securityAdmin.auditChain());
    } catch (e) {
      setChain({ error: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }
  return (
    <>
      <PageTitle
        title="Audit Log"
        subtitle="Every change to people, roles, prices and the pipeline, newest first. Each entry is linked to the one before it, so an edited or deleted entry shows up when you verify."
        action={
          <Button variant="secondary" disabled={checking} onClick={verify}>
            {checking ? "Checking…" : "Verify chain"}
          </Button>
        }
      />
      {chain && "error" in chain && <p className="mb-4 border border-red bg-red/10 px-3 py-2 text-sm">{chain.error}</p>}
      {chain && !("error" in chain) && (
        <p className={`mb-4 border px-3 py-2 text-sm ${chain.ok ? "border-green bg-green/10" : "border-red bg-red/10"}`}>
          {chain.ok
            ? `Chain intact: ${chain.checked} entries checked${chain.lastSeq ? ` (up to #${chain.lastSeq})` : ""}. Nothing has been edited or deleted.`
            : `Chain broken at entry #${chain.brokenAt?.seq}: ${chain.brokenAt?.reason}. Treat this as a possible tampering incident (see Privacy → Breach runbook).`}
          {chain.unchained > 0 && ` ${chain.unchained} older entries from before v20 are not chained.`}
        </p>
      )}
      <LoadState loading={rows.loading} error={rows.error} />
      {rows.data && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] bg-surface-raised text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Who</th>
                <th className="px-3 py-2">What</th>
                <th className="px-3 py-2">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.data.map((r) => (
                <tr key={r.id} className="border-b border-border align-top">
                  <td className="px-3 py-2 whitespace-nowrap">{fmt.format(new Date(r.at))}</td>
                  <td className="px-3 py-2">{r.actor?.name ?? "System"}</td>
                  <td className="px-3 py-2">
                    <code>{r.action}</code>
                    <div className="text-xs text-ink-muted">
                      {r.entity} {r.entityId.slice(0, 18)}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <details>
                      <summary className="cursor-pointer text-ink-muted">Details</summary>
                      <pre className="mt-2 max-w-xl overflow-x-auto text-xs">{JSON.stringify({ before: r.before, after: r.after }, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
              {rows.data.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-ink-muted">
                    Nothing logged yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
