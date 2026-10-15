"use client";

import Link from "next/link";
import { useState } from "react";
import { REQUEST_TYPES, requestTypeLabels, type RequestType } from "@bmu/shared";
import { RequestStatusBadge, RequestTypeLabel, when } from "@/components/request-bits";
import { Button, Card, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function ClientRequestsPage() {
  const list = useLoad(() => api.client.requests());
  const overview = useLoad(() => api.client.overview());
  const [type, setType] = useState<RequestType>("change");
  const [engagementId, setEngagementId] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<string>();

  const services = overview.data?.engagements ?? [];
  const chosen = engagementId || services[0]?.id || "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.client.createRequest({ engagementId: chosen, type, description });
      setDescription("");
      setSent(r.type === "new_scope" ? "Got it. We'll check the scope and send you a quote." : "Got it. Your Client Manager will reply soon.");
      list.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle title="Requests" subtitle="Ask for a change, an extra piece of work, or anything else. Every request gets a reply within working hours." />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div>
          <LoadState loading={list.loading && !list.data} error={list.error} />
          <Card className="p-0">
            <ul className="divide-y divide-border text-sm">
              {list.data?.map((r) => (
                <li key={r.id}>
                  <Link href={`/client/requests/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-canvas/40">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{r.description}</span>
                      <span className="text-xs text-ink-muted">
                        <RequestTypeLabel type={r.type} side="client" /> · {r.engagement.serviceName} · {when.format(new Date(r.createdAt))}
                      </span>
                    </span>
                    <RequestStatusBadge status={r.status} side="client" />
                  </Link>
                </li>
              ))}
              {list.data?.length === 0 && <li className="px-4 py-6 text-center text-ink-muted">No requests yet.</li>}
            </ul>
          </Card>
        </div>

        <Card>
          <h2 className="mb-3 font-semibold">New request</h2>
          {services.length === 0 ? (
            <p className="text-sm text-ink-muted">You can raise requests once a service is active.</p>
          ) : (
            <form onSubmit={submit} className="grid gap-3 text-sm">
              <div className="grid gap-1">
                {REQUEST_TYPES.map((t) => (
                  <label key={t} className={`flex cursor-pointer gap-2 border px-3 py-2 ${type === t ? "border-charcoal bg-canvas/50" : "border-border"}`}>
                    <input type="radio" name="type" checked={type === t} onChange={() => setType(t)} />
                    <span>
                      <span className="font-medium">{requestTypeLabels[t].client}</span>
                      <span className="block text-xs text-ink-muted">{requestTypeLabels[t].hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {services.length > 1 && (
                <label className="grid gap-1">
                  <span className="text-xs text-ink-muted">Service</span>
                  <Select value={chosen} onChange={(e) => setEngagementId(e.target.value)}>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.serviceName}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              <textarea
                className="w-full border border-border bg-surface px-3 py-2"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What do you need?"
                required
                minLength={5}
              />
              <Button type="submit" disabled={busy}>
                Send request
              </Button>
              {sent && <p className="text-green-700 text-sm">{sent}</p>}
              {error && <p className="text-sm text-red">{error}</p>}
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
