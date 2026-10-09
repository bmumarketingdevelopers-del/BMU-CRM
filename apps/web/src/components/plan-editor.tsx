"use client";

import { useState } from "react";
import type { PlanContent } from "@bmu/shared";
import { Button, Input, Select } from "@/components/ui";

export const DELIVERABLE_TYPES = ["post", "carousel", "reel", "story", "video", "blog", "ad", "page", "other"];

const empty: PlanContent = { objectives: "", audience: "", pillars: [], creativeDirection: "", deliverables: [] };
const area = "w-full border border-border bg-surface-raised px-3 py-2 text-sm";

/** Strategist's plan form. The parent decides what Save and Submit do. */
export function PlanEditor({
  initial,
  busy,
  onSave,
  onSubmit,
}: {
  initial: PlanContent | null;
  busy: boolean;
  onSave: (c: PlanContent) => void;
  onSubmit: (c: PlanContent) => void;
}) {
  const [c, setC] = useState<PlanContent>(initial ?? empty);
  const [pillars, setPillars] = useState((initial?.pillars ?? []).join(", "));
  const set = <K extends keyof PlanContent>(k: K, v: PlanContent[K]) => setC((p) => ({ ...p, [k]: v }));
  const content = (): PlanContent => ({ ...c, pillars: pillars.split(",").map((p) => p.trim()).filter(Boolean) });
  const setDeliverable = (i: number, patch: Partial<PlanContent["deliverables"][number]>) =>
    set("deliverables", c.deliverables.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  return (
    <div className="space-y-4 text-sm">
      <label className="block">
        <span className="font-medium">Objectives</span>
        <textarea className={area} rows={3} value={c.objectives} onChange={(e) => set("objectives", e.target.value)} placeholder="What this month must achieve" />
      </label>
      <label className="block">
        <span className="font-medium">Audience</span>
        <textarea className={area} rows={2} value={c.audience} onChange={(e) => set("audience", e.target.value)} placeholder="Who we are talking to" />
      </label>
      <label className="block">
        <span className="font-medium">Content pillars</span>
        <Input value={pillars} onChange={(e) => setPillars(e.target.value)} placeholder="Comma separated, e.g. Projects, Customer stories, Offers" />
      </label>
      <label className="block">
        <span className="font-medium">Creative direction</span>
        <textarea className={area} rows={3} value={c.creativeDirection} onChange={(e) => set("creativeDirection", e.target.value)} placeholder="Look, tone, references" />
      </label>

      <div>
        <p className="font-medium">Deliverables</p>
        <div className="mt-2 space-y-2">
          {c.deliverables.map((d, i) => (
            <div key={i} className="flex flex-wrap gap-2">
              <Select value={d.type} onChange={(e) => setDeliverable(i, { type: e.target.value })} aria-label="Type">
                {DELIVERABLE_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
              <Input className="min-w-[200px] flex-1" value={d.title} onChange={(e) => setDeliverable(i, { title: e.target.value })} placeholder="Title" aria-label="Title" />
              <Input className="w-40" type="date" value={d.due ?? ""} onChange={(e) => setDeliverable(i, { due: e.target.value || undefined })} aria-label="Due date" />
              <Button variant="ghost" onClick={() => set("deliverables", c.deliverables.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
        </div>
        <Button variant="secondary" className="mt-2" onClick={() => set("deliverables", [...c.deliverables, { type: "post", title: "" }])}>
          Add deliverable
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button variant="secondary" disabled={busy} onClick={() => onSave(content())}>
          Save draft
        </Button>
        <Button disabled={busy || c.deliverables.length === 0} onClick={() => onSubmit(content())}>
          Submit for internal review
        </Button>
      </div>
    </div>
  );
}
