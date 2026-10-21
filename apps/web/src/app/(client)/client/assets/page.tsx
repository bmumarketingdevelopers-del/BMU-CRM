"use client";

import { useState } from "react";
import { assetRightsLabels, type AssetQuery } from "@bmu/shared";
import { Empty } from "@/components/dash";
import { AssetThumb, bytes } from "@/components/creative/asset-uploader";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { ViewOnlyViewer, canViewOnly } from "@/components/view-only";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function ClientAssetsPage() {
  const [q, setQ] = useState<AssetQuery>({});
  const [search, setSearch] = useState("");
  return (
    <>
      <PageTitle title="Asset library" subtitle="Your approved posts, logos and brand files, always the latest version. Download anything you need." />
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ({ ...q, q: search.trim() || undefined });
        }}
      >
        <Input className="min-w-60 flex-1" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select value={q.kind ?? ""} onChange={(e) => setQ({ ...q, kind: e.target.value || undefined })} aria-label="Type">
          <option value="">All types</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
          <option value="pdf">PDFs</option>
          <option value="link">Links</option>
        </Select>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      <Grid key={JSON.stringify(q)} q={q} />
    </>
  );
}

function Grid({ q }: { q: AssetQuery }) {
  const loaded = useLoad(() => api.assets.clientList(q), { live: false });
  const [viewing, setViewing] = useState<{ url: string; name: string; kind: string }>();
  const data = loaded.data;
  if (!data) return <LoadState loading={loaded.loading} error={loaded.error} />;
  if (!data.items.length) return <Empty>Nothing here yet. Work you approve appears here automatically.</Empty>;
  return (
    <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
      {data.items.map((a) => (
        <li key={a.id} className="border border-border bg-surface-raised">
          <a
            href={a.current.url}
            target="_blank"
            rel="noreferrer"
            className="block aspect-square overflow-hidden"
            // v39: view only before the final payment: the in-app viewer, not a new tab.
            onClick={(e) => {
              if (!a.preview) return;
              e.preventDefault();
              if (canViewOnly(null, a.kind)) setViewing({ url: a.current.url, name: a.title, kind: a.kind });
            }}
            onContextMenu={(e) => a.preview && e.preventDefault()}
          >
            <AssetThumb kind={a.kind} url={a.current.url} title={a.title} />
          </a>
          <div className="p-3">
            <p className="truncate text-sm font-semibold">{a.title}</p>
            <p className="text-xs text-ink-muted">
              {a.collection?.name ?? (a.source === "deliverable" ? "Approved work" : "Brand file")}
              {a.current.sizeBytes ? ` · ${bytes(a.current.sizeBytes)}` : ""}
            </p>
            {(a.rights.state === "expiring" || a.rights.state === "expired") && (
              <p className="mt-1">
                <Badge tone={a.rights.state === "expired" ? "red" : "amber"}>{assetRightsLabels[a.rights.state]}</Badge>
              </p>
            )}
            {a.kind !== "link" &&
              (a.preview ? (
                // v39: a one-time project's work before the final payment: view only, no download.
                <span className="mt-2 block text-xs text-ink-muted">
                  {canViewOnly(null, a.kind) && (
                    <button type="button" className="underline" onClick={() => setViewing({ url: a.current.url, name: a.title, kind: a.kind })}>
                      {a.kind === "video" ? "Watch" : "View"}
                    </button>
                  )}
                  {canViewOnly(null, a.kind) ? " · " : ""}🔒 Download after the final payment
                </span>
              ) : (
                <a href={a.current.url} download={a.current.name ?? true} className="mt-2 inline-block text-xs underline">
                  Download
                </a>
              ))}
          </div>
        </li>
      ))}
      {viewing && <ViewOnlyViewer file={viewing} onClose={() => setViewing(undefined)} />}
    </ul>
  );
}
