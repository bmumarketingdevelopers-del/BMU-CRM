"use client";

import { useState } from "react";
import Link from "next/link";
import { assetRightsLabels, assetSourceLabels, type AssetList, type AssetQuery, type AssetRow } from "@bmu/shared";
import { Empty, Panel, StatRow, StatTile } from "@/components/dash";
import { AssetThumb, AssetUploader } from "@/components/creative/asset-uploader";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const rightsTone = (s: AssetRow["rights"]["state"]) => (s === "expired" ? "red" : s === "expiring" ? "amber" : "neutral");

export default function AssetsPage() {
  const [q, setQ] = useState<AssetQuery>({});
  const [search, setSearch] = useState("");
  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle title="Asset library" subtitle="Every logo, photo, video and approved post in one place, with versions, collections and usage rights." />
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ({ ...q, q: search.trim() || undefined });
        }}
      >
        <Input className="min-w-60 flex-1" placeholder="Search names, tags and AI tags" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      <Library key={JSON.stringify(q)} q={q} setQ={setQ} />
    </div>
  );
}

function Library({ q, setQ }: { q: AssetQuery; setQ: (q: AssetQuery) => void }) {
  const loaded = useLoad(() => api.assets.list(q), { live: ["Asset", "AssetVersion", "AssetCollection"] });
  const [fresh, setFresh] = useState<AssetList>();
  const [seen, setSeen] = useState(loaded.data);
  if (seen !== loaded.data) {
    setSeen(loaded.data);
    setFresh(undefined);
  }
  const data = fresh ?? loaded.data;
  const [adding, setAdding] = useState<"upload" | "link" | "collection">();
  const [uploadTo, setUploadTo] = useState<{ clientOrgId: string; collectionId: string; tags: string }>({ clientOrgId: q.clientId ?? "", collectionId: q.collectionId ?? "", tags: "" });
  if (!data) return <LoadState loading={loaded.loading} error={loaded.error} />;
  const refresh = () => api.assets.list(q).then(setFresh);
  const set = (patch: Partial<AssetQuery>) => setQ(Object.fromEntries(Object.entries({ ...q, ...patch }).filter(([, v]) => v)) as AssetQuery);
  const tags = uploadTo.tags
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  return (
    <>
      <StatRow cols={4}>
        <StatTile label="Assets" value={data.total} />
        <StatTile label="Collections" value={data.collections.length} />
        <StatTile label="Rights ending in 30 days" value={data.rightsEnding} tone={data.rightsEnding ? "warn" : "default"} />
        <StatTile label="Tags in use" value={data.tags.length} />
      </StatRow>

      <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
        <Select value={q.clientId ?? ""} onChange={(e) => set({ clientId: e.target.value || undefined, collectionId: undefined })} aria-label="Client">
          <option value="">All clients</option>
          {data.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select value={q.kind ?? ""} onChange={(e) => set({ kind: e.target.value || undefined })} aria-label="Type">
          <option value="">All types</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
          <option value="pdf">PDFs</option>
          <option value="link">Links</option>
          <option value="other">Other files</option>
        </Select>
        <Select value={q.tag ?? ""} onChange={(e) => set({ tag: e.target.value || undefined })} aria-label="Tag">
          <option value="">Any tag</option>
          {data.tags.map((t) => (
            <option key={t.tag} value={t.tag}>
              {t.tag} ({t.count})
            </option>
          ))}
        </Select>
        <Select value={q.rights ?? ""} onChange={(e) => set({ rights: (e.target.value || undefined) as AssetQuery["rights"] })} aria-label="Rights">
          <option value="">Any rights</option>
          <option value="expiring">Rights end soon</option>
          <option value="expired">Rights ended</option>
        </Select>
        <label className="flex items-center gap-1 text-xs text-ink-muted">
          <input type="checkbox" checked={q.archived === "1"} onChange={(e) => set({ archived: e.target.checked ? "1" : undefined })} /> Archived
        </label>
        {Object.keys(q).length > 0 && (
          <button className="text-xs underline" onClick={() => setQ({})}>
            Clear filters
          </button>
        )}
        {data.canUpload && (
          <div className="ml-auto flex gap-2">
            <Button variant={adding === "upload" ? "primary" : "secondary"} onClick={() => setAdding(adding === "upload" ? undefined : "upload")}>
              Upload
            </Button>
            <Button variant={adding === "link" ? "primary" : "secondary"} onClick={() => setAdding(adding === "link" ? undefined : "link")}>
              Add link
            </Button>
            <Button variant={adding === "collection" ? "primary" : "secondary"} onClick={() => setAdding(adding === "collection" ? undefined : "collection")}>
              New collection
            </Button>
          </div>
        )}
      </div>

      {adding === "upload" && (
        <Panel title="Upload to the library" className="mt-4">
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <Select value={uploadTo.clientOrgId} onChange={(e) => setUploadTo({ ...uploadTo, clientOrgId: e.target.value, collectionId: "" })} aria-label="Upload for client">
              <option value="">BMU (no client)</option>
              {data.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select value={uploadTo.collectionId} onChange={(e) => setUploadTo({ ...uploadTo, collectionId: e.target.value })} aria-label="Upload to collection">
              <option value="">No collection</option>
              {data.collections
                .filter((c) => !c.client || c.client.id === uploadTo.clientOrgId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
            <Input className="min-w-48" placeholder="Tags, comma separated" value={uploadTo.tags} onChange={(e) => setUploadTo({ ...uploadTo, tags: e.target.value })} />
          </div>
          <AssetUploader
            target={{ clientOrgId: uploadTo.clientOrgId || null, collectionId: uploadTo.collectionId || null, tags: tags.length ? tags : undefined }}
            onDone={() => refresh()}
          />
        </Panel>
      )}
      {adding === "link" && <LinkForm data={data} onDone={() => (setAdding(undefined), refresh())} />}
      {adding === "collection" && <CollectionForm data={data} onDone={() => (setAdding(undefined), refresh())} />}

      {data.collections.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2 text-sm">
          <button className={`border px-3 py-1 ${!q.collectionId ? "border-charcoal bg-charcoal text-ivory" : "border-border bg-surface-raised"}`} onClick={() => set({ collectionId: undefined })}>
            All
          </button>
          {data.collections.map((c) => (
            <button
              key={c.id}
              title={c.description ?? undefined}
              className={`border px-3 py-1 ${q.collectionId === c.id ? "border-charcoal bg-charcoal text-ivory" : "border-border bg-surface-raised"}`}
              onClick={() => set({ collectionId: c.id })}
            >
              {c.name} <span className="opacity-60">{c.count}</span>
              {c.client && <span className="ml-1 text-xs opacity-60">· {c.client.name}</span>}
            </button>
          ))}
        </div>
      )}

      {data.items.length === 0 ? (
        <div className="mt-6">
          <Empty>{Object.keys(q).length ? "Nothing matches these filters." : "No assets yet. Upload files, or approve work: approved posts land here automatically."}</Empty>
        </div>
      ) : (
        <ul className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {data.items.map((a) => (
            <li key={a.id} className="border border-border bg-surface-raised">
              <Link href={`/team/assets/${a.id}`} className="block">
                <div className="aspect-square overflow-hidden">
                  <AssetThumb kind={a.kind} url={a.current.url} title={a.title} />
                </div>
                <div className="p-3">
                  <p className="truncate text-sm font-semibold">{a.title}</p>
                  <p className="truncate text-xs text-ink-muted">
                    {a.client?.name ?? "BMU"} · {assetSourceLabels[a.source]}
                    {a.versions > 1 ? ` · v${a.current.number} of ${a.versions}` : ""}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {a.rights.state === "expiring" || a.rights.state === "expired" ? <Badge tone={rightsTone(a.rights.state)}>{assetRightsLabels[a.rights.state]}</Badge> : null}
                    {a.clientVisible && <Badge tone="green">Client can see</Badge>}
                    {a.tags.slice(0, 3).map((t) => (
                      <span key={t} className="bg-canvas px-1.5 text-[11px] text-ink-muted">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data.total > data.items.length && <p className="mt-3 text-xs text-ink-muted">Showing {data.items.length} of {data.total}. Search or filter to narrow it down.</p>}
    </>
  );
}

function LinkForm({ data, onDone }: { data: AssetList; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [clientOrgId, setClient] = useState("");
  const [error, setError] = useState<string>();
  return (
    <Panel title="Add a link (Drive, Figma, YouTube…)" className="mt-4">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(undefined);
          try {
            await api.assets.addLink({ url, title: title || undefined, clientOrgId: clientOrgId || null });
            onDone();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Input className="min-w-72 flex-1" type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
        <Input placeholder="Name (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Select value={clientOrgId} onChange={(e) => setClient(e.target.value)} aria-label="Client">
          <option value="">BMU (no client)</option>
          {data.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Button type="submit">Add</Button>
      </form>
      {error && <p className="mt-2 text-sm text-red">{error}</p>}
    </Panel>
  );
}

function CollectionForm({ data, onDone }: { data: AssetList; onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [clientOrgId, setClient] = useState("");
  const [error, setError] = useState<string>();
  return (
    <Panel title="New collection" subtitle="Group assets for a campaign, a shoot or a season." className="mt-4">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(undefined);
          try {
            await api.assets.createCollection({ name, description: description || undefined, clientOrgId: clientOrgId || null });
            onDone();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Input required placeholder="Name (e.g. Diwali 2026)" value={name} onChange={(e) => setName(e.target.value)} />
        <Input className="min-w-60 flex-1" placeholder="What it is for (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <Select value={clientOrgId} onChange={(e) => setClient(e.target.value)} aria-label="Client">
          <option value="">Any client</option>
          {data.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Button type="submit">Create</Button>
      </form>
      {error && <p className="mt-2 text-sm text-red">{error}</p>}
    </Panel>
  );
}
