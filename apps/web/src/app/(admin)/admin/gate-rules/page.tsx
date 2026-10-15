"use client";

import { useState, type ReactNode } from "react";
import { GATES, type SettingsValue } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { Badge, Input, LoadState, PageTitle } from "@/components/ui";
import { ReadOnlyNote, SaveBar, useSaver, useSettingsAndAccess } from "../_platform/kit";

type Rules = SettingsValue<"gateRules">;

export default function GateRulesPage() {
  const data = useSettingsAndAccess();
  if (!data.data) {
    return (
      <>
        <PageTitle title="Gate Rules" subtitle="The five milestones every engagement passes through." />
        <LoadState loading={data.loading} error={data.error} />
      </>
    );
  }
  return <Editor initial={data.data.settings.gateRules} canEdit={data.data.access.operations} />;
}

function Lock() {
  return (
    <Badge tone="dark">
      <svg aria-hidden width="10" height="11" viewBox="0 0 10 11" className="mr-1 inline-block align-[-1px]" fill="none" stroke="currentColor" strokeWidth="1.3">
        <rect x="1" y="4.5" width="8" height="6" />
        <path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" />
      </svg>
      Locked
    </Badge>
  );
}

function Rule({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <div className="max-w-md">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function Editor({ initial, canEdit }: { initial: Rules; canEdit: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [rules, setRules] = useState(initial);
  const { busy, msg, setMsg, save } = useSaver("gateRules", (s) => {
    setSaved(s.gateRules);
    setRules(s.gateRules);
  });
  const dirty = JSON.stringify(saved) !== JSON.stringify(rules);
  const daysOk = Number.isInteger(rules.planDeadlineWorkingDays) && rules.planDeadlineWorkingDays >= 1 && rules.planDeadlineWorkingDays <= 30;

  const extra: Record<string, ReactNode> = {
    G1: (
      <Rule title="Plan deadline after requirements are complete" hint="Working days the strategist gets to deliver the plan once the Client Manager marks requirements complete (RCD). Holidays and Sundays are skipped.">
        {canEdit ? (
          <label className="flex items-center gap-2 text-sm">
            <Input type="number" min={1} max={30} className="w-20!" value={rules.planDeadlineWorkingDays} onChange={(e) => setRules({ ...rules, planDeadlineWorkingDays: Number(e.target.value) })} aria-label="Working days" />
            <span className="whitespace-nowrap">working days</span>
          </label>
        ) : (
          <span className="text-sm font-medium">{rules.planDeadlineWorkingDays} working days</span>
        )}
      </Rule>
    ),
    G3: (
      <Rule title="Hold production when an invoice is overdue" hint="When on, production cannot start for a client with an overdue invoice until Finance clears it.">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-[#121F2F]" disabled={!canEdit} checked={rules.blockProductionOnOverdueInvoice} onChange={(e) => setRules({ ...rules, blockProductionOnOverdueInvoice: e.target.checked })} />
          {rules.blockProductionOnOverdueInvoice ? "On" : "Off"}
        </label>
      </Rule>
    ),
    G4: (
      <Rule title="Internal QC must pass before anything is sent to the client" hint="Protects the client's brand. This rule cannot be switched off.">
        <Lock />
      </Rule>
    ),
    G5: (
      <Rule title="Final files are released only after the final payment" hint="Downloads, deploys and handover unlock after written sign-off and payment. This rule cannot be switched off.">
        <Lock />
      </Rule>
    ),
  };

  return (
    <>
      <PageTitle title="Gate Rules" subtitle="The five milestones every engagement passes through, what is needed to pass each one, and the rules you can adjust." />
      {!canEdit && <ReadOnlyNote who="operations" />}
      <ol className="relative space-y-4">
        {GATES.map((g, i) => (
          <li key={g.id}>
            <Panel>
              <div className="flex flex-wrap items-start gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center bg-charcoal text-sm font-semibold text-ivory">{g.id}</span>
                <div className="min-w-0 flex-1 space-y-4">
                  <div>
                    <p className="text-[15px] font-semibold tracking-tight">
                      Gate {i + 1}: {g.name}
                    </p>
                    <p className="mt-1 text-sm">
                      <span className="text-ink-muted">Passes when </span>
                      {g.unlock_when}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-ink-muted">Until then, locked:</span>
                      {g.locks.map((l) => (
                        <Badge key={l}>{l}</Badge>
                      ))}
                      {"effect" in g && g.effect && <span className="ml-1 text-ink-muted">· After passing: {g.effect}</span>}
                    </div>
                  </div>
                  {extra[g.id]}
                </div>
              </div>
            </Panel>
          </li>
        ))}
      </ol>
      {canEdit && (
        <SaveBar
          busy={busy}
          dirty={dirty}
          disabled={!daysOk}
          msg={!daysOk ? { ok: false, text: "The plan deadline must be between 1 and 30 working days." } : msg}
          onSave={() => save(rules)}
          onReset={() => {
            setRules(saved);
            setMsg(undefined);
          }}
        />
      )}
    </>
  );
}
