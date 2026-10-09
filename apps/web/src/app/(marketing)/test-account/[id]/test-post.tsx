"use client";
// v19: the "live link" of a post published to a test account, so the whole publishing flow can be tried without real
// Meta, LinkedIn or Google keys.
import { PROVIDER_INFO, type IntegrationProvider } from "@bmu/shared";
import { Badge, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const dtFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function TestPost({ id }: { id: string }) {
  const post = useLoad(() => api.integrations.testPost(id), { live: false });
  if (!post.data) return <LoadState loading={post.loading} error={post.error} />;
  const p = post.data;
  const label = PROVIDER_INFO[p.provider as IntegrationProvider]?.label ?? p.provider;
  return (
    <article className="border border-border bg-surface-raised p-6" data-testid="test-post">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{p.account}</p>
          <p className="text-xs text-ink-muted">
            {label} · {dtFmt.format(new Date(p.publishedAt))}
          </p>
        </div>
        <Badge tone="amber">Test account</Badge>
      </div>
      <h1 className="mt-4 text-lg font-semibold tracking-tight">{p.title}</h1>
      {p.caption && <p className="mt-2 whitespace-pre-wrap text-sm">{p.caption}</p>}
      <p className="mt-6 border-t border-border pt-4 text-xs text-ink-muted">This post was published by BMU Hub to a test account. Nothing was posted to {label}. Connect the real account in Integrations to publish for real.</p>
    </article>
  );
}
