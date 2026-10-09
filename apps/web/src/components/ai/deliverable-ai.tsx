"use client";

import { useState } from "react";
import type { AiGenerateFeature, DeliverableDetail } from "@bmu/shared";
import { api } from "@/lib/api";
import { aiPlain } from "@/lib/ai";
import { AiPanel } from "./ai-panel";

const SOCIAL = ["post", "carousel", "story", "ad", "reel"];
const VIDEO = ["reel", "video"];

/** AI tools on a deliverable: brief, captions, script, QC pre-check and feedback → change list. Results can be posted as an internal note. */
export function DeliverableAiTools({ d, onChanged }: { d: DeliverableDetail; onChanged: (next: DeliverableDetail) => void }) {
  const tabs: { value: AiGenerateFeature; label: string }[] = [
    { value: "creative_brief", label: "Creative brief" },
    ...(SOCIAL.includes(d.type) ? [{ value: "social_captions" as const, label: "Captions & hooks" }] : []),
    ...(VIDEO.includes(d.type) ? [{ value: "video_script" as const, label: "Video script" }] : []),
    { value: "qc_precheck", label: "QC pre-check" },
    ...(d.comments.some((c) => c.author.isClient && !c.internal) ? [{ value: "feedback_summary" as const, label: "Feedback → changes" }] : []),
  ];
  const [tab, setTab] = useState<AiGenerateFeature>("creative_brief");
  const latest = d.versions.at(-1);
  const canNote = d.can.internal && d.can.comment && !!latest;
  const note = canNote
    ? async (text: string) => {
        onChanged(await api.deliverables.comment(d.id, { versionId: latest!.id, body: aiPlain(text).slice(0, 4000), internal: true }));
      }
    : undefined;

  const common = { targetId: d.id, onInsert: note, insertLabel: "Post as internal note" };

  return (
    <div>
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="AI tools for this deliverable">
        {tabs.map((t) => (
          <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)} className={`border px-3 py-1 text-sm ${tab === t.value ? "border-charcoal bg-charcoal text-ivory" : "border-border bg-surface-raised"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-2">
        {tab === "creative_brief" && (
          <AiPanel key="brief" feature="creative_brief" {...common} title="Creative brief" description="Built from the approved plan, requirements received and the brand. Add notes to steer it." input={{ label: "Extra notes (optional)", rows: 2 }} buttonLabel="Write brief" />
        )}
        {tab === "social_captions" && (
          <AiPanel key="captions" feature="social_captions" {...common} title="Captions, hashtags and hooks" description="Options to pick from. The client sees nothing until you send a version." input={{ label: "Topic or angle (optional)", rows: 2 }} buttonLabel="Write captions" />
        )}
        {tab === "video_script" && <AiPanel key="script" feature="video_script" {...common} title="Video script outline" description="Hook, beats, proof and call to action with a shot list." input={{ label: "Angle (optional)", rows: 2 }} buttonLabel="Outline script" />}
        {tab === "qc_precheck" && (
          <AiPanel
            key="qc"
            feature="qc_precheck"
            {...common}
            title="QC pre-check"
            description="Paste the copy from the creative. Flags spelling, brand name, risky claims and style before the QC reviewer sees it."
            input={{ label: "Copy to check", rows: 4, required: true, placeholder: "Paste caption or on-creative text…" }}
            buttonLabel="Check copy"
          />
        )}
        {tab === "feedback_summary" && <AiPanel key="fb" feature="feedback_summary" {...common} title="Client feedback → change list" description="Turns every client comment into a numbered list of changes for the maker." buttonLabel="Make change list" />}
      </div>
    </div>
  );
}
