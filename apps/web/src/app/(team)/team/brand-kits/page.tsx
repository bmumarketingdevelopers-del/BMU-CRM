"use client";

import { useState } from "react";
import { BrandKitCard } from "@/components/craft/craft-bits";
import { Empty, Meter } from "@/components/dash";
import { Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export default function BrandKitsPage() {
  const loaded = useLoad(() => api.creative.brandKits(), { live: ["CraftBrandKit"] });
  const [open, setOpen] = useState<string>();
  const [q, setQ] = useState("");
  const kits = (loaded.data ?? []).filter((k) => k.client.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle title="Brand kits" subtitle="Colours, fonts, tone of voice, do's and don'ts and brand files for every client. The creative reviewer checks work against these." />
      {!loaded.data ? (
        <LoadState loading={loaded.loading} error={loaded.error} />
      ) : (
        <>
          <Input className="mb-4 max-w-sm" placeholder="Find a client" value={q} onChange={(e) => setQ(e.target.value)} />
          {kits.length === 0 && <Empty>No clients to show.</Empty>}
          <ul className="space-y-2">
            {kits.map((k) => (
              <li key={k.clientId} className="border border-border bg-surface-raised">
                <button className="flex w-full flex-wrap items-center gap-4 px-4 py-3 text-left" onClick={() => setOpen(open === k.clientId ? undefined : k.clientId)}>
                  <span className="min-w-40 flex-1 font-semibold">{k.client}</span>
                  <span className="flex gap-1">
                    {k.colours.slice(0, 6).map((c) => (
                      <span key={c} className="inline-block h-5 w-5 border border-border" style={{ background: c }} title={c} />
                    ))}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {k.fonts.join(", ") || "No fonts"} · {k.files} file{k.files === 1 ? "" : "s"}
                    {k.updatedAt ? ` · updated ${day.format(new Date(k.updatedAt))}` : ""}
                  </span>
                  <span className="w-40">
                    <Meter value={k.complete} tone={k.complete >= 80 ? "good" : k.complete >= 40 ? "default" : "warn"} label="Complete" />
                  </span>
                </button>
                {open === k.clientId && (
                  <div className="border-t border-border p-4">
                    <KitLoader clientId={k.clientId} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function KitLoader({ clientId }: { clientId: string }) {
  const kit = useLoad(() => api.craft.brandKit(clientId), { live: false });
  if (!kit.data) return <LoadState loading={kit.loading} error={kit.error} />;
  return <BrandKitCard kit={kit.data} readOnly={false} />;
}
