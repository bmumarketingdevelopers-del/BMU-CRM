"use client";
// v10 craft: side-by-side version compare for designs (images) and links, with each version's client pins.
import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { DeliverableDetail, VersionView } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const dayFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

export default function ComparePage() {
  const { id } = useParams<{ id: string }>()!;
  const loaded = useLoad(() => api.deliverables.get(id));
  const d = loaded.data;
  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle
        title={d ? `Compare: ${d.title}` : "Compare versions"}
        subtitle={d ? `${d.client.name} · ${d.versions.length} versions. Pins are the client's comments on each version.` : undefined}
        action={
          <Link href={`/team/deliverables/${id}`} className="text-sm text-ink-muted hover:text-ink">
            Open in Review Studio →
          </Link>
        }
      />
      {!d ? <LoadState loading={loaded.loading} error={loaded.error} /> : d.versions.length < 2 ? <p className="text-sm text-ink-muted">Compare needs at least two versions.</p> : <Compare d={d} />}
    </div>
  );
}

function Compare({ d }: { d: DeliverableDetail }) {
  const n = d.versions.length;
  const [left, setLeft] = useState(d.versions[n - 2].id);
  const [right, setRight] = useState(d.versions[n - 1].id);
  const pick = (vid: string) => d.versions.find((v) => v.id === vid)!;
  return (
    <div className="grid gap-4 md:grid-cols-2" data-compare>
      <Side d={d} v={pick(left)} onPick={setLeft} />
      <Side d={d} v={pick(right)} onPick={setRight} />
    </div>
  );
}

function Side({ d, v, onPick }: { d: DeliverableDetail; v: VersionView; onPick: (id: string) => void }) {
  const pins = d.comments.filter((c) => c.versionId === v.id && !c.internal);
  return (
    <Panel
      title={`Version ${v.number}`}
      subtitle={`${v.uploadedBy} · ${dayFmt.format(new Date(v.at))}${v.qc.at(-1) ? ` · QC ${v.qc.at(-1)!.result === "pass" ? "passed" : "failed"}` : ""}${v.approved ? " · approved" : ""}`}
      action={
        <Select aria-label="Pick a version" value={v.id} onChange={(e) => onPick(e.target.value)}>
          {d.versions.map((x) => (
            <option key={x.id} value={x.id}>
              v{x.number}
            </option>
          ))}
        </Select>
      }
    >
      {v.kind === "image" ? (
        <div className="relative border border-border bg-canvas">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={v.url} alt={v.name ?? `Version ${v.number}`} className="block w-full" />
          {pins.map((c, i) =>
            c.anchor && "x" in c.anchor ? (
              <span key={c.id} title={c.body} className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center bg-charcoal text-[11px] text-ivory" style={{ left: `${c.anchor.x}%`, top: `${c.anchor.y}%` }}>
                {i + 1}
              </span>
            ) : null,
          )}
        </div>
      ) : (
        <a href={v.url} target="_blank" rel="noreferrer" className="block border border-border p-4 text-sm underline">
          {v.name ?? v.url} ↗
        </a>
      )}
      {v.note && <p className="mt-2 text-xs text-ink-muted">Note: {v.note}</p>}
      <ol className="mt-3 space-y-1 text-sm">
        {pins.map((c, i) => (
          <li key={c.id}>
            <span className="mr-1.5 inline-block w-5 bg-charcoal text-center text-[11px] text-ivory">{i + 1}</span>
            {c.body} <span className="text-xs text-ink-muted">· {c.author.name}</span>
          </li>
        ))}
        {!pins.length && <li className="text-xs text-ink-muted">No client comments on this version.</li>}
      </ol>
    </Panel>
  );
}
