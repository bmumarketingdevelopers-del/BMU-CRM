"use client";

import { useState } from "react";
import type { AiMeetingNotes, SellLeadDetail } from "@bmu/shared";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { aiPlain } from "@/lib/ai";
import { AiPanel } from "./ai-panel";

type Tab = "brief" | "followup" | "meeting";

/** AI tools on the lead page: brief + next best action, follow-up drafts, meeting notes → actions. */
export function LeadAiTools({ detail, onChanged }: { detail: SellLeadDetail; onChanged: (next: SellLeadDetail) => void }) {
  const [tab, setTab] = useState<Tab>("brief");
  const [channel, setChannel] = useState<"email" | "whatsapp">("email");
  const l = detail.lead;
  const phone = (l.contact.phone ?? "").replace(/\D/g, "").slice(-10);

  const log = async (kind: "email" | "whatsapp" | "meeting", body: string, followUpDate?: string | null) => {
    onChanged(
      await api.sell.logActivity(l.id, {
        kind,
        // Meeting notes mean they spoke; a sent email/WhatsApp has no outcome yet.
        outcome: kind === "meeting" ? "connected" : undefined,
        body: body.slice(0, 4000),
        // Every conversation needs a next follow-up: the one from the notes, else two days from now.
        nextFollowUpAt: followUpIso(followUpDate),
      }),
    );
  };

  const tabs: { value: Tab; label: string }[] = [
    { value: "brief", label: "Lead brief" },
    { value: "followup", label: "Follow-up draft" },
    { value: "meeting", label: "Meeting notes" },
  ];

  return (
    <div>
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="AI tools for this lead">
        {tabs.map((t) => (
          <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)} className={`border px-3 py-1 text-sm ${tab === t.value ? "border-charcoal bg-charcoal text-ivory" : "border-border bg-surface-raised"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-2">
        {tab === "brief" && (
          <AiPanel feature="lead_brief" targetId={l.id} title="AI lead brief" description="Who they are, why the score is what it is, and the next best action." buttonLabel="Write brief" />
        )}
        {tab === "followup" && (
          <AiPanel
            feature="lead_followup"
            targetId={l.id}
            options={{ channel }}
            title="Follow-up draft"
            description="Drafted from the stage and latest activity. You send it yourself."
            buttonLabel="Draft follow-up"
            controls={
              <div className="flex" role="radiogroup" aria-label="Channel">
                {(["email", "whatsapp"] as const).map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={channel === c} onClick={() => setChannel(c)} className={`border px-2.5 py-1.5 text-xs ${channel === c ? "border-charcoal bg-charcoal text-ivory" : "border-border"}`}>
                    {c === "email" ? "Email" : "WhatsApp"}
                  </button>
                ))}
              </div>
            }
            actions={(text) => {
              const plain = aiPlain(text);
              const subject = plain.match(/^Subject:\s*(.+)$/m)?.[1] ?? "";
              const body = plain.replace(/^Subject:.*\n+/m, "");
              return (
                <>
                  {channel === "whatsapp" && phone && (
                    <a className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory" href={`https://wa.me/91${phone}?text=${encodeURIComponent(plain)}`} target="_blank" rel="noreferrer">
                      Open in WhatsApp
                    </a>
                  )}
                  {channel === "email" && l.contact.email && (
                    <a className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory" href={`mailto:${l.contact.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}>
                      Open in email
                    </a>
                  )}
                  <LogButton label="Log as sent" onLog={() => log(channel, `${channel === "email" ? "Email" : "WhatsApp"} sent:\n${plain}`)} />
                </>
              );
            }}
          />
        )}
        {tab === "meeting" && (
          <AiPanel
            feature="meeting_notes"
            targetId={l.id}
            title="Meeting notes → summary and actions"
            description="Paste rough notes or a call transcript. You get a summary, action items and a follow-up date."
            input={{ label: "Notes or transcript", placeholder: "e.g. Met Priya at the clinic. Wants 12 posts and 4 reels a month from November. Budget ₹45k. We will send the proposal by Thursday…", rows: 5, required: true }}
            buttonLabel="Summarise"
            insertLabel="Save to timeline"
            onInsert={async (text, result) => {
              const m = result.data?.kind === "meeting_notes" ? (result.data.value as AiMeetingNotes) : null;
              await log("meeting", aiPlain(text), m?.followUpDate ?? null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function LogButton({ label, onLog }: { label: string; onLog: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | string>("idle");
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        disabled={state === "busy" || state === "done"}
        onClick={async () => {
          setState("busy");
          try {
            await onLog();
            setState("done");
          } catch (e) {
            setState((e as Error).message);
          }
        }}
      >
        {state === "done" ? "Logged ✓" : state === "busy" ? "Saving…" : label}
      </Button>
      {!["idle", "busy", "done"].includes(state) && <span className="text-xs text-red">{state}</span>}
    </>
  );
}

/** The follow-up from the notes at 10am IST, else two days from now. */
function followUpIso(date?: string | null) {
  return new Date(date ? `${date}T10:00:00+05:30` : Date.now() + 2 * 86_400_000).toISOString();
}
