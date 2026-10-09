"use client";
// v19: API keys, outgoing webhooks and the public API reference.
import { useState } from "react";
import { API_SCOPES, PUBLIC_ROUTES, WEBHOOK_EVENTS, apiScopeLabels, type ApiKeyView, type ApiScope, type WebhookDeliveryView, type WebhookView } from "@bmu/shared";
import { DataTable, Panel } from "@/components/dash";
import { Badge, Button, Input, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Field, FormNote, WithData, fmtDateTime } from "../_insights/kit";

export default function DeveloperPage() {
  return (
    <>
      <PageTitle title="API & Webhooks" subtitle="Let your own tools read and add BMU Hub records, and get told the moment something happens." action={<a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="text-sm underline">OpenAPI document</a>} />
      <div className="space-y-6">
        <Keys />
        <Webhooks />
        <Reference />
      </div>
    </>
  );
}

/** A secret shown once, with a copy button. */
function OneTime({ label, value, onClose }: { label: string; value: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-4 border border-[#cfe0a8] bg-[#f4f9e8] p-4" data-testid="one-time-secret">
      <p className="text-sm font-medium">{label}</p>
      <p className="mt-1 text-xs text-ink-muted">Copy it now. It is shown only once; BMU Hub keeps only a fingerprint.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="break-all bg-surface-raised px-2 py-1 font-mono text-xs">{value}</code>
        <Button
          variant="secondary"
          className="!px-3 !py-1 text-xs"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

function Keys() {
  const keys = useLoad(() => api.developer.keys(), { live: ["ApiKey"] });
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>(["leads:read"]);
  const [limit, setLimit] = useState("120");
  const [expires, setExpires] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg({});
    try {
      const r = await api.developer.createKey({ name, scopes, rateLimitPerMin: Number(limit) || 120, expiresInDays: expires ? Number(expires) : null });
      setCreated(r.key);
      setName("");
      keys.reload();
    } catch (err) {
      setMsg({ error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function revoke(k: ApiKeyView) {
    if (!window.confirm(`Revoke “${k.name}”? Anything using it stops working straight away.`)) return;
    try {
      await api.developer.revokeKey(k.id);
      keys.reload();
    } catch (err) {
      setMsg({ error: (err as Error).message });
    }
  }
  return (
    <Panel title="API keys" subtitle="A key acts as you, limited to the scopes you tick. Send it as Authorization: Bearer bmu_…">
      {created && <OneTime label="Your new API key" value={created} onClose={() => setCreated(null)} />}
      <form onSubmit={create} className="mb-6 space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Zapier leads sync" required minLength={2} className="w-full" />
          </Field>
          <Field label="Requests per minute">
            <Input type="number" min={10} max={600} value={limit} onChange={(e) => setLimit(e.target.value)} className="w-full" />
          </Field>
          <Field label="Expires">
            <Select value={expires} onChange={(e) => setExpires(e.target.value)} className="w-full !py-2">
              <option value="">Never</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm text-ink-muted">What it can do</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {API_SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))} />
                {apiScopeLabels[s]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex items-center gap-4">
          <Button disabled={busy || !scopes.length}>{busy ? "Creating…" : "Create key"}</Button>
          <FormNote error={msg.error} ok={msg.ok} />
        </div>
      </form>
      <WithData state={keys}>
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={(k) => k.id}
            empty="No keys yet."
            columns={[
              {
                key: "name",
                header: "Key",
                cell: (k) => (
                  <div>
                    <p className="font-medium">{k.name}</p>
                    <p className="font-mono text-xs text-ink-muted">{k.prefix}</p>
                  </div>
                ),
              },
              { key: "scopes", header: "Scopes", cell: (k) => <span className="text-xs">{k.scopes.map((s) => apiScopeLabels[s]).join(", ")}</span> },
              { key: "who", header: "Acts as", cell: (k) => k.actsAs.name },
              { key: "used", header: "Last used", cell: (k) => fmtDateTime(k.lastUsedAt) },
              { key: "limit", header: "Per minute", align: "right", cell: (k) => k.rateLimitPerMin },
              {
                key: "state",
                header: "",
                align: "right",
                cell: (k) =>
                  k.revokedAt ? (
                    <Badge>Revoked</Badge>
                  ) : k.expiresAt && new Date(k.expiresAt) < new Date() ? (
                    <Badge tone="amber">Expired</Badge>
                  ) : (
                    <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => void revoke(k)}>
                      Revoke
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </WithData>
    </Panel>
  );
}

function Webhooks() {
  const hooks = useLoad(() => api.developer.webhooks(), { live: ["WebhookSubscription", "WebhookDelivery"] });
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>(["lead.created"]);
  const [custom, setCustom] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function act(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    setMsg({});
    try {
      await fn();
      if (ok) setMsg({ ok });
      hooks.reload();
    } catch (err) {
      setMsg({ error: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    const all = [...events, ...custom.split(/[\s,]+/).filter(Boolean)];
    await act("create", async () => {
      const r = await api.developer.createWebhook({ url, description: description || undefined, events: [...new Set(all)] });
      setSecret(r.secret);
      setUrl("");
      setDescription("");
      setCustom("");
    });
  }
  return (
    <Panel title="Webhooks" subtitle="BMU Hub POSTs a signed JSON message to your address when these things happen. Failed deliveries retry for about a day.">
      {secret && <OneTime label="Signing secret" value={secret} onClose={() => setSecret(null)} />}
      <form onSubmit={create} className="mb-6 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Send to (https address)">
            <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.zapier.com/…" required className="w-full" />
          </Field>
          <Field label="Note (optional)">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="New leads into Google Sheets" className="w-full" />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm text-ink-muted">Events</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {WEBHOOK_EVENTS.map((ev) => (
              <label key={ev.type} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={events.includes(ev.type)} onChange={(e) => setEvents((cur) => (e.target.checked ? [...cur, ev.type] : cur.filter((x) => x !== ev.type)))} />
                {ev.label} <span className="font-mono text-xs text-ink-muted">{ev.type}</span>
              </label>
            ))}
          </div>
          <div className="mt-3 max-w-md">
            <Field label="Other events" hint="Any event from the Audit Log, an area like invoice.*, or * for everything">
              <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="task.*" className="w-full" />
            </Field>
          </div>
        </fieldset>
        <div className="flex items-center gap-4">
          <Button disabled={busy !== null || (!events.length && !custom.trim())}>{busy === "create" ? "Adding…" : "Add webhook"}</Button>
          <FormNote error={msg.error} ok={msg.ok} />
        </div>
      </form>
      <WithData state={hooks}>
        {(rows) =>
          rows.length === 0 ? (
            <p className="text-sm text-ink-muted">No webhooks yet.</p>
          ) : (
            <ul className="divide-y divide-border border border-border">
              {rows.map((w) => (
                <li key={w.id} className="p-4" data-testid="webhook-row">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-all font-mono text-sm">{w.url}</p>
                      {w.description && <p className="text-sm text-ink-muted">{w.description}</p>}
                      <p className="mt-1 text-xs text-ink-muted">{w.events.join(", ")}</p>
                      <p className="mt-1 text-xs text-ink-muted">
                        {w.stats.delivered} delivered · {w.stats.pending} waiting · {w.stats.dead} gave up · last {fmtDateTime(w.stats.lastDeliveredAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <HookState w={w} />
                      <Button variant="secondary" className="!px-3 !py-1 text-xs" disabled={busy !== null} onClick={() => act(`t-${w.id}`, () => api.developer.testWebhook(w.id), "Test message queued. Open Deliveries to see the result.")}>
                        Send test
                      </Button>
                      <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => setOpen(open === w.id ? null : w.id)}>
                        {open === w.id ? "Hide deliveries" : "Deliveries"}
                      </Button>
                      <Button variant="ghost" className="!px-3 !py-1 text-xs" disabled={busy !== null} onClick={() => act(`p-${w.id}`, () => api.developer.updateWebhook(w.id, { active: !w.active }))}>
                        {w.active ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        variant="ghost"
                        className="!px-3 !py-1 text-xs"
                        disabled={busy !== null}
                        onClick={() => {
                          if (window.confirm("Make a new signing secret? The old one stops working straight away.")) void act(`r-${w.id}`, async () => setSecret((await api.developer.rotateSecret(w.id)).secret));
                        }}
                      >
                        New secret
                      </Button>
                      <Button
                        variant="ghost"
                        className="!px-3 !py-1 text-xs"
                        disabled={busy !== null}
                        onClick={() => {
                          if (window.confirm("Delete this webhook and its delivery history?")) void act(`d-${w.id}`, () => api.developer.deleteWebhook(w.id));
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                  {open === w.id && <Deliveries id={w.id} />}
                </li>
              ))}
            </ul>
          )
        }
      </WithData>
    </Panel>
  );
}

function HookState({ w }: { w: WebhookView }) {
  if (!w.active) return <Badge>Paused</Badge>;
  if (w.failingSince) return <Badge tone="red">Failing since {fmtDateTime(w.failingSince)}</Badge>;
  return <Badge tone="green">Active</Badge>;
}

const DELIVERY_TONE: Record<WebhookDeliveryView["status"], "green" | "amber" | "red"> = { delivered: "green", pending: "amber", dead: "red" };
const DELIVERY_LABEL: Record<WebhookDeliveryView["status"], string> = { delivered: "Delivered", pending: "Retrying", dead: "Gave up" };

function Deliveries({ id }: { id: string }) {
  const list = useLoad(() => api.developer.deliveries(id), { live: ["WebhookDelivery"] });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-4">
      {error && <p className="mb-2 text-sm text-[#b4432c]">{error}</p>}
      <WithData state={list}>
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={(d) => d.id}
            empty="No deliveries yet."
            columns={[
              { key: "at", header: "When", cell: (d) => fmtDateTime(d.createdAt) },
              { key: "type", header: "Event", cell: (d) => <span className="font-mono text-xs">{d.type}</span> },
              { key: "status", header: "Result", cell: (d) => <Badge tone={DELIVERY_TONE[d.status]}>{DELIVERY_LABEL[d.status]}</Badge> },
              { key: "code", header: "Response", cell: (d) => (d.lastStatus ? `HTTP ${d.lastStatus}` : (d.lastError ?? "—")) },
              { key: "tries", header: "Tries", align: "right", cell: (d) => d.attempts },
              { key: "next", header: "Next try", cell: (d) => (d.status === "pending" ? fmtDateTime(d.nextAttemptAt) : "—") },
              {
                key: "redo",
                header: "",
                align: "right",
                cell: (d) =>
                  d.status === "pending" ? null : (
                    <Button
                      variant="ghost"
                      className="!px-3 !py-1 text-xs"
                      onClick={async () => {
                        setError(null);
                        try {
                          await api.developer.redeliver(d.id);
                          list.reload();
                        } catch (err) {
                          setError((err as Error).message);
                        }
                      }}
                    >
                      Send again
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </WithData>
    </div>
  );
}

function Reference() {
  return (
    <Panel title="API reference" subtitle="Base address: your API URL (for example https://api.yourdomain.in). Money is in paise; lists are newest first with nextCursor paging.">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.1em] text-ink-muted">
              <th className="py-2 pr-4">Request</th>
              <th className="py-2 pr-4">What it does</th>
              <th className="py-2">Scope</th>
            </tr>
          </thead>
          <tbody>
            {PUBLIC_ROUTES.map((r) => (
              <tr key={r.id} className="border-b border-border align-top">
                <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
                  {r.method} {r.path}
                </td>
                <td className="py-2 pr-4">{r.summary}</td>
                <td className="py-2 font-mono text-xs">{r.scope ?? "any key"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-[11px] uppercase tracking-[0.1em] text-ink-muted">Try it</p>
          <pre className="overflow-x-auto bg-canvas px-3 py-2 font-mono text-xs leading-relaxed">{`curl -H "Authorization: Bearer bmu_…" \\
  "http://localhost:4000/v1/leads?limit=10"`}</pre>
        </div>
        <div>
          <p className="mb-2 text-[11px] uppercase tracking-[0.1em] text-ink-muted">Check a webhook signature (Node)</p>
          <pre className="overflow-x-auto bg-canvas px-3 py-2 font-mono text-xs leading-relaxed">{`const sig = "sha256=" + crypto
  .createHmac("sha256", SECRET)
  .update(req.headers["x-bmu-timestamp"] + "." + rawBody)
  .digest("hex");
if (sig !== req.headers["x-bmu-signature"]) reject();`}</pre>
        </div>
      </div>
    </Panel>
  );
}
