"use client";

import { use, useState } from "react";
import Link from "next/link";
import { assetRightsLabels, assetSourceLabels, type AssetDetail, type AssetFileView, type AssetList, type OpsShareLinkView } from "@bmu/shared";
import { KeyValues, Panel } from "@/components/dash";
import { AssetUploader, bytes } from "@/components/creative/asset-uploader";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => Promise.all([api.assets.get(id), api.assets.list({}).catch(() => null)]), { live: ["Asset", "AssetVersion"] });
  const [fresh, setFresh] = useState<AssetDetail>();
  const [seen, setSeen] = useState(loaded.data);
  if (seen !== loaded.data) {
    setSeen(loaded.data);
    setFresh(undefined);
  }
  const [compareId, setCompareId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const a = fresh ?? loaded.data?.[0];
  const lists = loaded.data?.[1] ?? null;
  if (!a) return <LoadState loading={loaded.loading} error={loaded.error} />;
  const compare = a.history.find((v) => v.id === compareId);

  async function act(fn: () => Promise<AssetDetail>) {
    setBusy(true);
    setError(undefined);
    try {
      setFresh(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle
        title={a.title}
        subtitle={`${a.client?.name ?? "BMU"} · ${assetSourceLabels[a.source]} · version ${a.current.number} of ${a.versions}`}
        action={
          <Link href="/team/assets" className="text-sm underline">
            Asset library
          </Link>
        }
      />
      {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Panel
            title={compare ? `v${compare.number} and v${a.current.number} side by side` : "Preview"}
            action={
              a.history.length > 1 ? (
                <label className="flex items-center gap-2 text-xs text-ink-muted">
                  Compare with
                  <Select className="py-1 text-xs" value={compareId ?? ""} onChange={(e) => setCompareId(e.target.value || undefined)}>
                    <option value="">None</option>
                    {a.history
                      .filter((v) => v.id !== a.current.id)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          v{v.number}
                        </option>
                      ))}
                  </Select>
                </label>
              ) : undefined
            }
          >
            <div className={compare ? "grid gap-3 md:grid-cols-2" : ""}>
              {compare && <Preview v={compare} />}
              <Preview v={a.current} />
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              {a.current.name} · {bytes(a.current.sizeBytes)} · uploaded by {a.current.uploadedBy} on {when.format(new Date(a.current.at))}
              {a.current.note ? ` · ${a.current.note}` : ""}
            </p>
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
              {a.kind !== "link" && (
                <a href={a.current.url} download={a.current.name ?? true} className="underline">
                  Download
                </a>
              )}
              {a.deliverable && (
                <Link href={`/team/deliverables/${a.deliverable.id}`} className="underline">
                  From approved work: {a.deliverable.title}
                </Link>
              )}
            </div>
          </Panel>

          <Panel title="Versions" flush>
            <ol className="divide-y divide-border text-sm">
              {a.history.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                    <span className="font-semibold">v{v.number}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-muted">
                      {v.name} · {bytes(v.sizeBytes)} · {v.uploadedBy} · {when.format(new Date(v.at))}
                      {v.note ? ` · ${v.note}` : ""}
                    </span>
                    {v.id === a.current.id ? (
                      <Badge tone="green">Current</Badge>
                    ) : (
                      a.can.edit && (
                        <Button variant="ghost" className="py-1 text-xs" disabled={busy} onClick={() => act(() => api.assets.makeCurrent(a.id, v.id))}>
                          Make current
                        </Button>
                      )
                    )}
                  </li>
                ))}
            </ol>
            {a.can.newVersion && (
              <div className="border-t border-border p-4">
                <AssetUploader target={{ assetId: a.id }} multiple={false} label="Upload a new version" onDone={setFresh} />
              </div>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          {a.can.edit ? <Details key={JSON.stringify([a.title, a.tags, a.collection, a.client, a.clientVisible, a.rights])} a={a} lists={lists} onSaved={setFresh} /> : <ReadOnly a={a} />}
          <Panel title="Tags from the picture" subtitle="Suggested by AI from what is in the image. Search finds these too.">
            <div className="flex flex-wrap gap-1">
              {a.aiTags.length ? a.aiTags.map((t) => <span key={t} className="bg-canvas px-1.5 text-xs">{t}</span>) : <span className="text-xs text-ink-muted">None yet.</span>}
            </div>
            {a.can.edit && a.kind === "image" && (
              <Button variant="secondary" className="mt-2 py-1 text-xs" disabled={busy} onClick={() => act(() => api.assets.aiTags(a.id))}>
                {a.aiTags.length ? "Suggest again" : "Suggest tags"}
              </Button>
            )}
          </Panel>
          {a.can.share && a.kind !== "link" && <Share fileId={a.fileId} />}
          {a.can.archive && (
            <Button variant="ghost" className="text-sm" disabled={busy} onClick={() => act(() => (a.archived ? api.assets.restore(a.id) : api.assets.archive(a.id)))}>
              {a.archived ? "Restore asset" : "Archive asset"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Preview({ v }: { v: AssetFileView }) {
  if (v.kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={v.url} alt={v.name ?? `Version ${v.number}`} className="max-h-[70vh] max-w-full border border-border bg-canvas" />;
  }
  if (v.kind === "video") return <video src={v.url} controls playsInline preload="metadata" className="max-h-[70vh] max-w-full bg-black" />;
  if (v.kind === "pdf") return <iframe src={v.url} title={v.name ?? "PDF"} className="h-[60vh] w-full border border-border bg-white" />;
  return (
    <div className="border border-border bg-canvas p-6 text-sm">
      <a href={v.url} target="_blank" rel="noreferrer" className="break-all font-semibold underline">
        {v.kind === "link" ? v.url : (v.name ?? "Open file")}
      </a>
      <p className="mt-1 text-xs text-ink-muted">{v.kind === "link" ? "Opens in a new tab." : "No preview for this type. Download to open it."}</p>
    </div>
  );
}

function ReadOnly({ a }: { a: AssetDetail }) {
  return (
    <Panel title="Details">
      <KeyValues
        items={[
          { k: "Client", v: a.client?.name ?? "BMU" },
          { k: "Collection", v: a.collection?.name ?? "None" },
          { k: "Tags", v: a.tags.join(", ") || "None" },
          { k: "Rights", v: `${assetRightsLabels[a.rights.state]}${a.rights.expiresAt ? ` (until ${a.rights.expiresAt.slice(0, 10)})` : ""}` },
          { k: "Creator", v: a.rights.creator?.name ?? "None" },
        ]}
      />
    </Panel>
  );
}

function Details({ a, lists, onSaved }: { a: AssetDetail; lists: AssetList | null; onSaved: (a: AssetDetail) => void }) {
  const [title, setTitle] = useState(a.title);
  const [tags, setTags] = useState(a.tags.join(", "));
  const [clientOrgId, setClient] = useState(a.client?.id ?? "");
  const [collectionId, setCollection] = useState(a.collection?.id ?? "");
  const [clientVisible, setVisible] = useState(a.clientVisible);
  const [rightsNote, setRightsNote] = useState(a.rights.note ?? "");
  const [rightsExpireAt, setExpiry] = useState(a.rights.expiresAt?.slice(0, 10) ?? "");
  const [creatorId, setCreator] = useState(a.rights.creator?.id ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const clients = lists?.clients ?? (a.client ? [a.client] : []);
  const collections = (lists?.collections ?? []).filter((c) => !c.client || c.client.id === clientOrgId);
  return (
    <Panel title="Details">
      <form
        className="grid gap-2 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            onSaved(
              await api.assets.update(a.id, {
                title,
                tags: tags
                  .split(",")
                  .map((t) => t.trim().toLowerCase())
                  .filter(Boolean),
                clientOrgId: clientOrgId || null,
                collectionId: collectionId || null,
                clientVisible: clientOrgId ? clientVisible : false,
                rightsNote: rightsNote || null,
                rightsExpireAt: rightsExpireAt || null,
                creatorId: creatorId || null,
              }),
            );
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="grid gap-1">
          <span className="text-xs text-ink-muted">Name</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-ink-muted">Tags (comma separated)</span>
          <Input value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-ink-muted">Client</span>
          <Select value={clientOrgId} onChange={(e) => (setClient(e.target.value), setCollection(""))}>
            <option value="">BMU (no client)</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-ink-muted">Collection</span>
          <Select value={collectionId} onChange={(e) => setCollection(e.target.value)}>
            <option value="">None</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
        <label className={`flex items-center gap-2 ${clientOrgId ? "" : "opacity-50"}`}>
          <input type="checkbox" checked={clientOrgId ? clientVisible : false} disabled={!clientOrgId} onChange={(e) => setVisible(e.target.checked)} /> Show in the client&apos;s asset library
        </label>
        <p className="mt-2 text-xs font-semibold">Usage rights</p>
        <label className="grid gap-1">
          <span className="text-xs text-ink-muted">Creator or photographer</span>
          <Select value={creatorId} onChange={(e) => setCreator(e.target.value)}>
            <option value="">None</option>
            {(lists?.creators ?? (a.rights.creator ? [a.rights.creator] : [])).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-ink-muted">Rights end on (we warn the Account Manager 7 days before)</span>
          <Input type="date" value={rightsExpireAt} onChange={(e) => setExpiry(e.target.value)} />
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-ink-muted">Rights note</span>
          <Input value={rightsNote} onChange={(e) => setRightsNote(e.target.value)} placeholder="e.g. Organic social only, no paid ads" />
        </label>
        {a.rights.state !== "none" && (
          <p>
            <Badge tone={a.rights.state === "expired" ? "red" : a.rights.state === "expiring" ? "amber" : "green"}>{assetRightsLabels[a.rights.state]}</Badge>
          </p>
        )}
        <Button type="submit" disabled={busy} className="mt-2">
          Save details
        </Button>
        {error && <p className="text-red">{error}</p>}
      </form>
    </Panel>
  );
}

function Share({ fileId }: { fileId: string }) {
  const links = useLoad(() => api.ops.files.shares(fileId), { live: false });
  const [days, setDays] = useState("7");
  const [password, setPassword] = useState("");
  const [made, setMade] = useState<OpsShareLinkView[]>([]);
  const [error, setError] = useState<string>();
  const all = [...made, ...(links.data ?? []).filter((l) => !made.some((m) => m.id === l.id))];
  return (
    <Panel title="Share outside BMU" subtitle="A link that stops working after the days you pick. Every view is counted.">
      <form
        className="flex flex-wrap gap-2 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(undefined);
          try {
            const link = await api.ops.files.share(fileId, { expiresInDays: Number(days), password });
            setMade([link, ...made]);
            setPassword("");
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Link lasts">
          {[1, 7, 14, 30, 90].map((d) => (
            <option key={d} value={d}>
              {d} day{d > 1 ? "s" : ""}
            </option>
          ))}
        </Select>
        <Input className="w-36" type="password" placeholder="Password (optional)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="secondary">
          Create link
        </Button>
      </form>
      {error && <p className="mt-2 text-xs text-red">{error}</p>}
      <ul className="mt-3 space-y-2 text-xs">
        {all.map((l) => (
          <li key={l.id} className={l.revoked ? "text-ink-muted line-through" : ""}>
            <input readOnly value={l.url} className="w-full border border-border bg-canvas px-2 py-1 font-mono" onFocus={(e) => e.currentTarget.select()} />
            <span className="text-ink-muted">
              Until {l.expiresAt.slice(0, 10)} · {l.views} view{l.views === 1 ? "" : "s"}
              {l.hasPassword ? " · password" : ""}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
