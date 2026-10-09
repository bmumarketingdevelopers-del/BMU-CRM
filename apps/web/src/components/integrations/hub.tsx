"use client";
// v19 integrations hub: connect social, ads and analytics accounts, link each one to a client, and watch syncs and
// auto-publishing. Real accounts need app keys on the server; test accounts work without any keys.
import { useEffect, useState } from "react";
import { INTEGRATION_PROVIDERS, PROVIDER_INFO, type ClientRow, type ConnectorStatus, type IntegrationAccountView, type IntegrationProvider, type IntegrationsHubView, type PublicationView, type SyncJobView } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const dtFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const when = (iso: string | null) => (iso ? dtFmt.format(new Date(iso)) : "—");
const KIND_LABEL = { social: "Posts", ads: "Ads", analytics: "Website" } as const;
const JOB_LABEL: Record<SyncJobView["kind"], string> = { publish: "Publish", post_metrics: "Post results", ad_metrics: "Ads and website numbers", refresh: "Sign-in refresh" };

export function IntegrationsHub() {
  const hub = useLoad(() => api.integrations.hub(), { live: ["IntegrationAccount", "PostPublication", "SyncJob"] });
  const clients = useLoad(() => api.clients.list().catch(() => [] as ClientRow[]), { live: false });
  const [banner, setBanner] = useState<{ ok?: string; error?: string }>({});

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const connected = q.get("connected");
    const error = q.get("error");
    if (!connected && !error) return;
    const provider = q.get("provider") as IntegrationProvider | null;
    const label = provider && PROVIDER_INFO[provider] ? PROVIDER_INFO[provider].label : "account";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-off message from the sign-in redirect
    setBanner(error ? { error } : { ok: `Connected ${connected} ${label} account${connected === "1" ? "" : "s"}. Link each one to its client below.` });
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  if (!hub.data) return <LoadState loading={hub.loading} error={hub.error} />;
  const h = hub.data;
  const clientList = clients.data ?? [];
  return (
    <div className="space-y-6">
      {banner.ok && <p className="border border-[#cfe0a8] bg-[#f4f9e8] px-4 py-3 text-sm text-[#4d7010]">{banner.ok}</p>}
      {banner.error && <p className="border border-[#ecc4b9] bg-[#fbefeb] px-4 py-3 text-sm text-[#b4432c]">{banner.error}</p>}
      <StatRow cols={4}>
        <StatTile label="Connected accounts" value={h.accounts.filter((a) => a.status !== "disconnected").length} />
        <StatTile label="Need attention" value={h.accounts.filter((a) => a.status === "error").length} tone={h.accounts.some((a) => a.status === "error") ? "bad" : "default"} />
        <StatTile label="Posts published" value={h.publications.filter((p) => p.status === "published").length} hint="recent" />
        <StatTile label="Posts failed" value={h.publications.filter((p) => p.status === "failed").length} tone={h.publications.some((p) => p.status === "failed") ? "warn" : "default"} />
      </StatRow>
      <Connectors hub={h} clients={clientList} onDone={hub.reload} />
      <Accounts hub={h} clients={clientList} onDone={hub.reload} />
      <Publications rows={h.publications} canManage={h.canManage} onDone={hub.reload} />
      <Jobs rows={h.jobs} />
    </div>
  );
}

function Connectors({ hub, clients, onDone }: { hub: IntegrationsHubView; clients: ClientRow[]; onDone: () => void }) {
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setMsg({});
    try {
      await fn();
    } catch (e) {
      setMsg({ error: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }
  const connect = (p: IntegrationProvider) =>
    run(`c-${p}`, async () => {
      const r = await api.integrations.oauthStart({ provider: p, clientOrgId: clientId || null });
      window.location.href = r.url;
    });
  const addTest = (p: IntegrationProvider) =>
    run(`t-${p}`, async () => {
      const a = await api.integrations.addTest({ provider: p, clientOrgId: clientId || null });
      setMsg({ ok: `Added ${a.name}${a.client ? ` for ${a.client.name}` : ""}. Its numbers fill in on the first sync.` });
      onDone();
    });
  const byProvider = new Map(hub.connectors.map((c) => [c.provider, c]));
  return (
    <Panel
      title="Connect an account"
      subtitle="Pick the client first, then connect their page, channel, ad account or website analytics"
      action={
        <Select aria-label="For client" value={clientId} onChange={(e) => setClientId(e.target.value)} className="!py-1.5 text-sm">
          <option value="">No client yet (link later)</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      }
    >
      {msg.ok && <p className="mb-3 text-sm text-[#5f8a12]">{msg.ok}</p>}
      {msg.error && <p className="mb-3 text-sm text-[#b4432c]">{msg.error}</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {INTEGRATION_PROVIDERS.map((p) => {
          const c = byProvider.get(p) as ConnectorStatus;
          if (!c) return null;
          return (
            <div key={p} className="flex flex-col gap-2 border border-border p-4" data-provider={p}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold">{c.label}</p>
                <Badge tone={c.errors ? "red" : c.accounts ? "green" : "neutral"}>{c.errors ? `${c.errors} need attention` : `${c.accounts} connected`}</Badge>
              </div>
              <p className="text-xs text-ink-muted">
                {KIND_LABEL[c.kind]}
                {c.publishes ? " · publishes approved posts" : " · daily numbers for client dashboards"}
              </p>
              {!c.configured && <p className="text-xs text-ink-muted">Needs {c.missingEnv.join(", ")} in apps/api/.env</p>}
              {hub.canManage && (
                <div className="mt-auto flex flex-wrap gap-2 pt-1">
                  <Button variant="secondary" className="!px-3 !py-1.5 text-xs" disabled={!c.configured || busy !== null} onClick={() => connect(p)} title={c.configured ? undefined : "Add the app keys to the server first"}>
                    {busy === `c-${p}` ? "Opening…" : "Connect"}
                  </Button>
                  {hub.testAccountsAllowed && (
                    <Button variant="ghost" className="!px-3 !py-1.5 text-xs" disabled={busy !== null} onClick={() => addTest(p)}>
                      {busy === `t-${p}` ? "Adding…" : "Add test account"}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-ink-muted">
        Sign-in return address to register with Meta, LinkedIn and Google: <span className="font-mono">{hub.callbackUrl}</span>
      </p>
    </Panel>
  );
}

function statusBadge(a: IntegrationAccountView) {
  if (a.status === "error") return <Badge tone="red">Needs attention</Badge>;
  if (a.status === "disconnected") return <Badge>Disconnected</Badge>;
  return <Badge tone="green">Connected</Badge>;
}

function Accounts({ hub, clients, onDone }: { hub: IntegrationsHubView; clients: ClientRow[]; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Panel title="Accounts" subtitle="Posts publish through the client's account for that channel; numbers sync every morning" flush>
      {error && <p className="px-5 pt-3 text-sm text-[#b4432c]">{error}</p>}
      <DataTable
        rows={hub.accounts}
        rowKey={(a) => a.id}
        empty="No accounts yet. Connect one above, or add a test account to try it out."
        columns={[
          {
            key: "name",
            header: "Account",
            cell: (a) => (
              <div>
                <p className="font-medium">{a.name}</p>
                <p className="text-xs text-ink-muted">
                  {PROVIDER_INFO[a.provider].label}
                  {a.mode === "test" ? " · test account" : ""}
                </p>
              </div>
            ),
          },
          {
            key: "client",
            header: "Client",
            cell: (a) =>
              hub.canManage && a.status !== "disconnected" ? (
                <Select aria-label={`Client for ${a.name}`} value={a.client?.id ?? ""} disabled={busy !== null} onChange={(e) => act(`c-${a.id}`, () => api.integrations.updateAccount(a.id, { clientOrgId: e.target.value || null }))} className="!py-1 text-sm">
                  <option value="">Not linked</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  {a.client && !clients.some((c) => c.id === a.client?.id) && <option value={a.client.id}>{a.client.name}</option>}
                </Select>
              ) : (
                (a.client?.name ?? "—")
              ),
          },
          {
            key: "status",
            header: "Status",
            cell: (a) => (
              <div className="space-y-1">
                {statusBadge(a)}
                {a.lastError && <p className="max-w-[280px] text-xs text-[#b4432c]">{a.lastError}</p>}
              </div>
            ),
          },
          { key: "sync", header: "Last sync", cell: (a) => when(a.lastSyncAt) },
          { key: "pub", header: "Published", align: "right", cell: (a) => (PROVIDER_INFO[a.provider].publishes ? a.published : "—") },
          {
            key: "actions",
            header: "",
            align: "right",
            cell: (a) =>
              hub.canManage && a.status !== "disconnected" ? (
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" className="!px-3 !py-1 text-xs" disabled={busy !== null} onClick={() => act(`s-${a.id}`, () => api.integrations.sync(a.id))}>
                    {busy === `s-${a.id}` ? "Syncing…" : "Sync now"}
                  </Button>
                  <Button
                    variant="ghost"
                    className="!px-3 !py-1 text-xs"
                    disabled={busy !== null}
                    onClick={() => {
                      if (window.confirm(`Disconnect ${a.name}? Scheduled posts for it will stop publishing.`)) void act(`d-${a.id}`, () => api.integrations.disconnect(a.id));
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              ) : null,
          },
        ]}
      />
    </Panel>
  );
}

const PUB_TONE: Record<PublicationView["status"], "neutral" | "green" | "amber" | "red"> = { queued: "neutral", publishing: "amber", published: "green", failed: "red" };
const PUB_LABEL: Record<PublicationView["status"], string> = { queued: "Waiting to retry", publishing: "Publishing", published: "Live", failed: "Failed" };

function Publications({ rows, canManage, onDone }: { rows: PublicationView[]; canManage: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel title="Auto-publishing" subtitle="Approved posts publish at their scheduled time. Failures retry after 5, 15 and 60 minutes." flush>
      {error && <p className="px-5 pt-3 text-sm text-[#b4432c]">{error}</p>}
      <DataTable
        rows={rows}
        rowKey={(r) => r.id}
        empty="Nothing published yet. Approved posts on a connected channel publish on their scheduled day."
        columns={[
          {
            key: "title",
            header: "Post",
            cell: (r) => (
              <div>
                <p className="font-medium">{r.title}</p>
                <p className="text-xs text-ink-muted">
                  {r.client} · {r.accountName}
                </p>
              </div>
            ),
          },
          {
            key: "status",
            header: "Status",
            cell: (r) => (
              <div className="space-y-1">
                <Badge tone={PUB_TONE[r.status]}>{PUB_LABEL[r.status]}</Badge>
                {r.error && <p className="max-w-[300px] text-xs text-[#b4432c]">{r.error}</p>}
                {r.status === "queued" && r.nextAttemptAt && <p className="text-xs text-ink-muted">Next try {when(r.nextAttemptAt)}</p>}
              </div>
            ),
          },
          { key: "tries", header: "Tries", align: "right", cell: (r) => r.attempts },
          { key: "at", header: "Published", cell: (r) => when(r.publishedAt) },
          {
            key: "link",
            header: "",
            align: "right",
            cell: (r) =>
              r.url ? (
                <a href={r.url} target="_blank" rel="noreferrer" className="text-sm underline">
                  View post
                </a>
              ) : canManage && r.status === "failed" ? (
                <Button
                  variant="secondary"
                  className="!px-3 !py-1 text-xs"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(r.id);
                    setError(null);
                    try {
                      await api.integrations.retryPublication(r.id);
                      onDone();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === r.id ? "Retrying…" : "Retry"}
                </Button>
              ) : null,
          },
        ]}
      />
    </Panel>
  );
}

function Jobs({ rows }: { rows: SyncJobView[] }) {
  return (
    <Panel title="Sync log" subtitle="Every publish and every numbers pull, newest first" flush>
      <DataTable
        rows={rows}
        rowKey={(r) => r.id}
        empty="No syncs yet."
        columns={[
          { key: "at", header: "When", cell: (r) => when(r.startedAt) },
          { key: "acct", header: "Account", cell: (r) => `${r.accountName} (${PROVIDER_INFO[r.provider].label})` },
          { key: "kind", header: "Job", cell: (r) => JOB_LABEL[r.kind] },
          { key: "status", header: "Result", cell: (r) => (r.status === "ok" ? <Badge tone="green">Done</Badge> : r.status === "running" ? <Badge tone="amber">Running</Badge> : <Badge tone="red">Failed</Badge>) },
          { key: "items", header: "Items", align: "right", cell: (r) => r.items },
          { key: "err", header: "", cell: (r) => (r.error ? <span className="text-xs text-[#b4432c]">{r.error}</span> : null) },
        ]}
      />
    </Panel>
  );
}
