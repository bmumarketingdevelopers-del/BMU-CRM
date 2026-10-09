"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  formatINR,
  LEAD_STAGES,
  leadStageLabels,
  SELL_ACTIVITY_KINDS,
  SELL_OUTCOMES,
  sellActivityLabels,
  sellOutcomeLabels,
  services as catalogue,
  type LeadStage,
  type SellActivityKind,
  type SellLeadDetail,
} from "@bmu/shared";
import { HistoryTab } from "@/components/actions/history-tab";
import { RowMenu } from "@/components/actions/row-menu";
import { useActions } from "@/components/actions/actions-provider";
import { leadPerms, useLeadActions } from "@/components/ops/lead-actions";
import { LeadAiTools } from "@/components/ai/lead-ai";
import { Badge, Button, Card, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { CustomFieldsPanel, RecordWorkflows } from "@/components/custom-fields-panel";

const dt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const d = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const istDay = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(x);
const serviceName = (key: string) => catalogue.find((s) => s.id === key)?.name ?? key;
/** "2026-10-05" + "10:00" in IST → ISO instant. */
const istToIso = (day: string, time = "10:00") => new Date(`${day}T${time}:00+05:30`).toISOString();

const KIND_ICON: Record<string, string> = { call: "☎", meeting: "◎", note: "✎", email: "✉", whatsapp: "◌", enquiry: "★", system: "•", stage: "→" };

export function LeadDetail({ id }: { id: string }) {
  const router = useRouter();
  const loaded = useLoad(() => api.sell.lead(id));
  const people = useLoad(() => api.leads.assignees().catch(() => []));
  const [data, setData] = useState<SellLeadDetail>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<SellActivityKind>("call");
  const [lostReason, setLostReason] = useState("");
  const [askLost, setAskLost] = useState(false);
  const v = data ?? loaded.data;
  const [outcome, setOutcome] = useState("");
  const { me, openReassign } = useActions();
  const refresh = () => {
    setData(undefined);
    loaded.reload();
  };
  const leadActions = useLeadActions(refresh);

  async function run(fn: () => Promise<SellLeadDetail | void>, ok?: string) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await fn();
      if (next) setData(next);
      if (ok) setNotice(ok);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function logActivity(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const followDay = String(f.get("followDay") || "");
    const when = String(f.get("when") || "");
    const ok = await run(
      () =>
        api.sell.logActivity(id, {
          kind,
          outcome: (String(f.get("outcome") || "") || undefined) as never,
          body: String(f.get("body") || ""),
          at: when ? new Date(when).toISOString() : undefined,
          nextFollowUpAt: followDay ? istToIso(followDay, String(f.get("followTime") || "10:00")) : undefined,
        }),
      "Saved to the timeline.",
    );
    if (ok) {
      form.reset();
      setOutcome("");
    }
  }

  async function changeStage(stage: LeadStage, reason?: string) {
    if (stage === "lost" && !reason) return setAskLost(true);
    await run(async () => {
      await api.leads.update(id, { stage, lostReason: reason });
      setAskLost(false);
      return api.sell.lead(id);
    }, `Moved to ${leadStageLabels[stage]}.`);
  }

  if (!v) return <LoadState loading={loaded.loading} error={loaded.error} />;
  const l = v.lead;
  const c = l.contact;
  const title = c.company || c.name;
  const open = l.stage !== "won" && l.stage !== "lost";
  const phoneDigits = (c.phone ?? "").replace(/\D/g, "").slice(-10);
  const today = istDay(new Date());
  const conversation = kind !== "note";
  const needsFollowUp = conversation && outcome !== "not_interested";
  const latestSent = v.proposals.find((p) => p.status === "sent" || p.status === "draft");

  return (
    <>
      <PageTitle
        presence={{ entity: "Lead", id: id }}
        title={title}
        subtitle={`${leadStageLabels[l.stage]} · from ${l.source.replace("_", " ")} · came in ${d.format(new Date(l.createdAt))}${v.lastActivityAt ? ` · last activity ${dt.format(new Date(v.lastActivityAt))}` : ""}`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/team/leads" className="text-sm underline">
              All leads
            </Link>
            {open && (
              <Link href={`/team/proposals/new?lead=${l.id}`} className="bg-charcoal px-4 py-2 text-sm font-semibold text-ivory">
                Create proposal
              </Link>
            )}
            <RowMenu label={`More actions for ${title}`} items={leadActions.items(l).filter((i) => i.key !== "history" && i.key !== "proposal")} />
          </div>
        }
      />
      {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm" role="alert">{error}</p>}
      {notice && <p className="mb-4 border border-green bg-green/10 px-4 py-2 text-sm" role="status">{notice}</p>}

      {v.duplicateOf && (
        <Card className="mb-6 border-amber">
          <p className="text-sm">
            <strong>Possible duplicate.</strong> Same email or phone as{" "}
            <Link href={`/team/leads/${v.duplicateOf.id}`} className="underline">
              {v.duplicateOf.name}
            </Link>{" "}
            ({leadStageLabels[v.duplicateOf.stage]}, came in {d.format(new Date(v.duplicateOf.createdAt))}).
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {v.duplicateOf.stage !== "won" && v.duplicateOf.stage !== "lost" && (
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(undefined);
                  try {
                    const r = await api.sell.mergeLead(id);
                    router.push(`/team/leads/${r.mergedInto}`);
                  } catch (e) {
                    setError((e as Error).message);
                    setBusy(false);
                  }
                }}
              >
                Merge into {v.duplicateOf.name}
              </Button>
            )}
            <Button variant="secondary" disabled={busy} onClick={() => run(() => api.sell.keepSeparate(id), "Kept as a separate lead.")}>
              Keep separate
            </Button>
          </div>
        </Card>
      )}
      {v.duplicates.length > 0 && (
        <p className="mb-6 border border-border bg-surface-raised px-4 py-2 text-sm">
          Repeat enquiries from this contact:{" "}
          {v.duplicates.map((x, i) => (
            <span key={x.id}>
              {i > 0 && ", "}
              <Link href={`/team/leads/${x.id}`} className="underline">
                {x.name} ({d.format(new Date(x.createdAt))})
              </Link>
            </span>
          ))}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <LeadAiTools detail={v} onChanged={setData} />
          <Card>
            <h2 className="font-semibold">Log a call, meeting or note</h2>
            <form onSubmit={logActivity} className="mt-3 grid gap-3">
              <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Activity type">
                {SELL_ACTIVITY_KINDS.map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`border px-3 py-1 text-sm ${kind === k ? "border-charcoal bg-charcoal text-ivory" : "border-border"}`}>
                    {sellActivityLabels[k]}
                  </button>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {conversation && (
                  <label className="grid gap-1 text-sm">
                    <span>
                      Outcome <span className="text-red">*</span>
                    </span>
                    <Select name="outcome" required value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome">
                      <option value="">Choose…</option>
                      {SELL_OUTCOMES.map((o) => (
                        <option key={o} value={o}>
                          {sellOutcomeLabels[o]}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                <label className="grid gap-1 text-sm">
                  When (leave empty for now)
                  <Input name="when" type="datetime-local" />
                </label>
              </div>
              <label className="grid gap-1 text-sm">
                What happened
                <textarea name="body" required minLength={2} rows={3} className="w-full border border-border bg-surface-raised px-3 py-2" placeholder="e.g. Spoke to the owner, wants Instagram growth before Diwali. Budget ₹40k/month." />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  <span>
                    Next follow-up {needsFollowUp ? <span className="text-red">*</span> : "(optional)"}
                  </span>
                  <Input name="followDay" type="date" min={today} required={needsFollowUp} aria-label="Next follow-up" />
                </label>
                <label className="grid gap-1 text-sm">
                  At
                  <Input name="followTime" type="time" defaultValue="10:00" />
                </label>
              </div>
              <p className="text-xs text-ink-muted">{conversation ? "Calls, meetings, WhatsApp and email need the outcome and the next follow-up (unless they're not interested). " : ""}You get a reminder in the bell on the follow-up day. Logging a call on a new lead moves it to Contacted.</p>
              <div>
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Save to timeline"}
                </Button>
              </div>
            </form>
          </Card>

          <section aria-label="Activity timeline">
            <h2 className="mb-3 font-semibold">Timeline</h2>
            {v.timeline.length === 0 && <p className="text-sm text-ink-muted">Nothing logged yet.</p>}
            <ol className="relative border-l border-border pl-6">
              {v.timeline.map((t) => (
                <li key={t.id} className="mb-5">
                  <span className="absolute -left-[9px] mt-0.5 grid size-[18px] place-items-center border border-border bg-surface-raised text-[10px]" aria-hidden>
                    {KIND_ICON[t.kind] ?? "•"}
                  </span>
                  <p className="text-sm font-medium">
                    {t.title}
                    <span className="ml-2 text-xs font-normal text-ink-muted">
                      {dt.format(new Date(t.at))}
                      {t.by ? ` · ${t.by}` : ""}
                    </span>
                  </p>
                  {t.body && <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-muted">{t.body}</p>}
                  {t.nextFollowUpAt && <p className="mt-0.5 text-xs">Next follow-up: {dt.format(new Date(t.nextFollowUpAt))}</p>}
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="space-y-4">
          <Card>
            <h2 className="mb-2 font-semibold">Contact</h2>
            <dl className="space-y-1 text-sm">
              <div>{c.name}</div>
              {c.email && (
                <div>
                  <a href={`mailto:${c.email}`} className="underline">
                    {c.email}
                  </a>
                </div>
              )}
              {c.phone && (
                <div className="flex flex-wrap gap-3">
                  <a href={`tel:${c.phone}`} className="underline">
                    {c.phone}
                  </a>
                  {phoneDigits.length === 10 && (
                    <a href={`https://wa.me/91${phoneDigits}`} target="_blank" rel="noreferrer" className="underline">
                      WhatsApp
                    </a>
                  )}
                </div>
              )}
              {l.budgetPaise ? <div>Budget {formatINR(l.budgetPaise)} a month</div> : null}
              {l.serviceIds.length > 0 && <div className="text-ink-muted">Interested in: {l.serviceIds.map(serviceName).join(", ")}</div>}
            </dl>
            <p className="mt-3 whitespace-pre-wrap border-t border-border pt-3 text-sm">“{l.need}”</p>
            {v.client && (
              <Link href={`/team/clients/${v.client.id}`} className="mt-3 inline-block text-sm font-semibold underline">
                Open client: {v.client.name}
              </Link>
            )}
          </Card>

          <Card>
            <h2 className="mb-2 font-semibold">Stage and owner</h2>
            <label className="grid gap-1 text-sm">
              Stage
              <Select aria-label="Stage" value={l.stage} disabled={l.stage === "won" || busy} onChange={(e) => changeStage(e.target.value as LeadStage)}>
                {LEAD_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {leadStageLabels[s]}
                  </option>
                ))}
              </Select>
            </label>
            {askLost && (
              <form
                className="mt-2 grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  changeStage("lost", lostReason.trim());
                }}
              >
                <Input aria-label="Lost reason" placeholder="Why was it lost?" required minLength={3} value={lostReason} onChange={(e) => setLostReason(e.target.value)} />
                <div className="flex gap-2">
                  <Button type="submit" disabled={busy}>
                    Mark lost
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setAskLost(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            {l.lostReason && <p className="mt-2 text-sm text-red">Lost: {l.lostReason}</p>}
            <label className="mt-3 grid gap-1 text-sm">
              Owner
              {v.canAssign && l.owner ? (
                <span className="flex items-center justify-between gap-2">
                  <span>{l.owner.name}</span>
                  {leadPerms(me, l).reassign && (
                    <button type="button" className="text-sm underline" onClick={() => openReassign({ type: "lead_owner", ids: [l.id], title: `Reassign ${title}`, onDone: refresh })}>
                      Reassign
                    </button>
                  )}
                </span>
              ) : v.canAssign ? (
                <Select aria-label="Owner" value={l.owner?.id ?? ""} disabled={busy} onChange={(e) => run(async () => (await api.leads.update(id, { ownerId: e.target.value || null }), api.sell.lead(id)), "Owner updated.")}>
                  <option value="">Unassigned</option>
                  {(people.data ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="block">{l.owner?.name ?? "Unassigned"}</span>
              )}
            </label>
          </Card>

          <Card>
            <h2 className="mb-2 flex items-center justify-between font-semibold">
              Follow-up
              {v.nextFollowUpAt && <Badge tone={v.followUpDue ? (istDay(new Date(v.nextFollowUpAt)) < today ? "red" : "amber") : "neutral"}>{v.followUpDue ? (istDay(new Date(v.nextFollowUpAt)) < today ? "overdue" : "today") : "planned"}</Badge>}
            </h2>
            <p className="text-sm">{v.nextFollowUpAt ? dt.format(new Date(v.nextFollowUpAt)) : "No follow-up set."}</p>
            <form
              className="mt-2 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const day = String(new FormData(e.currentTarget).get("day") || "");
                if (day) run(() => api.sell.setFollowUp(id, istToIso(day)), "Follow-up set. You'll get a reminder that morning.");
              }}
            >
              <Input name="day" type="date" min={today} aria-label="Follow-up date" className="flex-1" />
              <Button type="submit" variant="secondary" disabled={busy}>
                Set
              </Button>
              {v.nextFollowUpAt && (
                <Button type="button" variant="ghost" disabled={busy} onClick={() => run(() => api.sell.setFollowUp(id, null), "Follow-up cleared.")}>
                  Clear
                </Button>
              )}
            </form>
          </Card>

          <Card>
            <h2 className="mb-1 flex items-center justify-between font-semibold">
              Lead score <Badge tone={v.score.score >= 60 ? "green" : v.score.score >= 30 ? "amber" : "neutral"}>{v.score.score} / 100</Badge>
            </h2>
            <p className="mb-2 text-xs text-ink-muted">How likely this lead is to buy, from what they told us.</p>
            <ul className="space-y-2 text-sm">
              {v.score.parts.map((p) => (
                <li key={p.label}>
                  <div className="flex justify-between gap-2">
                    <span>{p.label}</span>
                    <span className="text-ink-muted">
                      +{p.points} of {p.max}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 bg-canvas">
                    <div className="h-1.5 bg-charcoal" style={{ width: `${(p.points / p.max) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h2 className="mb-2 font-semibold">Proposals</h2>
            {v.proposals.length === 0 && <p className="text-sm text-ink-muted">None yet.</p>}
            <ul className="divide-y divide-border text-sm">
              {v.proposals.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                  <Link href={`/team/proposals/${p.id}`} className="underline">
                    v{p.version} · {formatINR(p.totalPaise)}
                  </Link>
                  <span className="text-xs text-ink-muted">
                    {open && latestSent?.id === p.id && (
                      <Link href={`/team/proposals/new?revise=${p.id}`} className="mr-2 text-ink underline">
                        Revise
                      </Link>
                    )}
                    {p.status}
                    {p.discountStatus === "pending" ? " · discount awaiting approval" : ""}
                    {p.viewCount ? ` · opened ${p.viewCount}×` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <CustomFieldsPanel entity="lead" id={id} />
          <RecordWorkflows entity="Lead" id={id} />
        </aside>
      </div>
      <div className="mt-6" id="history">
        <HistoryTab entity="Lead" id={id} />
      </div>
      {leadActions.dialogs}
    </>
  );
}
