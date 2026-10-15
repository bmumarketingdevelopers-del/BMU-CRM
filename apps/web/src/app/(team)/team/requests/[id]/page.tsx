"use client";

import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import { formatINR, rupeesToPaise, type AiTriage, type DecideRequest, type RequestView } from "@bmu/shared";
import { AiPanel } from "@/components/ai/ai-panel";
import { aiPlain } from "@/lib/ai";
import { RequestStatusBadge, RequestTypeLabel, SlaBadge, when } from "@/components/request-bits";
import { Button, Card, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { useActions } from "@/components/actions/actions-provider";
import { ConvertToTasksDrawer, CustomQuoteDialog } from "@/components/clients/request-drawers";
import { CustomFieldsPanel, RecordWorkflows } from "@/components/custom-fields-panel";

export default function TeamRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.requests.get(id));
  const addOns = useLoad(() => api.requests.addOns());
  const [fresh, setFresh] = useState<RequestView>();
  const [message, setMessage] = useState("");
  const typed = useRef("");
  useEffect(() => {
    typed.current = message;
  }, [message]);
  const [internal, setInternal] = useState(false);
  const [addOnId, setAddOnId] = useState("");
  const [qty, setQty] = useState(1);
  const [custom, setCustom] = useState("");
  const [timeline, setTimeline] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const r = fresh ?? loaded.data;
  const { openReassign, openNew, canNew, notify } = useActions();
  const [panel, setPanel] = useState<"convert" | "custom" | null>(null);
  const refresh = (m?: string) => {
    if (m) notify(m);
    api.requests.get(id).then(setFresh, () => undefined);
  };

  async function decide(input: DecideRequest) {
    setBusy(true);
    setError(undefined);
    const sent = message;
    try {
      setFresh(await api.requests.decide(id, input));
      // Keep anything typed while the request was saving (live updates can show the reply before it returns).
      if (typed.current === sent) {
        setMessage("");
        setInternal(false);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!r) return <LoadState loading={loaded.loading} error={loaded.error} />;
  const priced = addOns.data?.filter((a) => a.pricePaise) ?? [];
  const pick = priced.find((a) => a.id === addOnId);
  const decided = !["received", "scope_check", "rescheduled"].includes(r.status);
  const msg = message.trim() || undefined;

  return (
    <>
      <Link href="/team/requests" className="text-sm underline">
        ← Requests inbox
      </Link>
      <PageTitle
        presence={{ entity: "Request", id: id }}
        title={r.client.name}
        subtitle={`${r.engagement.serviceName} · raised by ${r.createdBy} on ${when.format(new Date(r.createdAt))}`}
        action={
          <div className="flex gap-2">
            <SlaBadge sla={r.sla} />
            <RequestStatusBadge status={r.status} side="team" />
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="grid min-w-0 content-start gap-4">
          <Card>
            <p className="text-xs text-ink-muted">
              <RequestTypeLabel type={r.type} side="team" />
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words">{r.description}</p>
          </Card>
          <Card>
            <h2 className="mb-3 font-medium">Conversation</h2>
            <ol className="space-y-2">
              {r.comments.map((c) => (
                <li key={c.id} className={`border-l-2 px-3 py-2 text-sm ${c.internal ? "border-amber bg-amber/10" : c.isClient ? "border-green bg-green/5" : "border-ink/30"}`}>
                  <p className="text-xs text-ink-muted">
                    <span className="font-medium text-ink">{c.author}</span> {c.internal && "· 🔒 Internal"} · {when.format(new Date(c.at))}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words">{c.body}</p>
                </li>
              ))}
              {r.comments.length === 0 && <li className="text-sm text-ink-muted">No replies yet.</li>}
            </ol>
            <form
              className="mt-4 grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                decide({ action: "reply", message, internal });
              }}
            >
              <textarea className="w-full border border-border bg-surface px-3 py-2 text-sm" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Reply to the client, or add a note to send with an action" />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="secondary" disabled={busy || !message.trim()}>
                  {internal ? "Add internal note" : "Reply"}
                </Button>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> 🔒 Internal
                </label>
              </div>
            </form>
          </Card>
          <AiPanel
            feature="reply_suggest"
            targetId={r.id}
            options={{ kind: "request" }}
            title="Suggested reply"
            description="Drafted from the request, the conversation and the contract. Insert puts it in the reply box; you send it."
            buttonLabel="Suggest reply"
            insertLabel="Put in reply box"
            onInsert={(text) => {
              setMessage(aiPlain(text));
              setInternal(false);
            }}
          />
        </div>

        <div className="grid min-w-0 content-start gap-4">
          <Card>
            <h2 className="font-medium">Handling</h2>
            <dl className="mt-2 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 text-sm" data-testid="request-handling">
              <dt className="text-ink-muted">Assigned to</dt>
              <dd>{r.assignee?.name ?? "Client Manager"}</dd>
              {r.neededBy && (
                <>
                  <dt className="text-ink-muted">Needed by</dt>
                  <dd>{new Date(r.neededBy).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</dd>
                </>
              )}
              {r.raisedOnBehalf && (
                <>
                  <dt className="text-ink-muted">Raised</dt>
                  <dd>By the team for the client</dd>
                </>
              )}
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              {r.can.decide && (
                <Button variant="secondary" onClick={() => openReassign({ type: "request", ids: [r.id], title: "Reassign request", onDone: () => refresh() })}>
                  Reassign
                </Button>
              )}
              {r.can.decide && ["in_scope", "paid", "in_progress", "approved"].includes(r.status) && (
                <Button variant="secondary" onClick={() => setPanel("convert")}>
                  Convert to tasks
                </Button>
              )}
              {r.can.decide && !["quoted", "approved", "paid", "in_progress", "done", "declined"].includes(r.status) && (
                <Button variant="secondary" onClick={() => setPanel("custom")}>
                  Custom price
                </Button>
              )}
              {canNew("approval") && (
                <Button variant="ghost" onClick={() => openNew("approval", { requestId: r.id, clientId: r.client.id }, () => refresh())}>
                  Ask for approval
                </Button>
              )}
            </div>
          </Card>
          <CustomFieldsPanel entity="request" id={r.id} />
          <RecordWorkflows entity="Request" id={r.id} />
          {r.can.decide && !decided && (
            <AiPanel
              feature="request_triage"
              targetId={r.id}
              title="Triage"
              description="In scope or a new direction, how urgent, and which add-on to quote."
              buttonLabel="Triage request"
              insertLabel="Use suggested add-on"
              canInsert={(res) => res.data?.kind === "triage" && !!(res.data.value as AiTriage).addOn}
              onInsert={(_text, res) => {
                const t = res.data?.kind === "triage" ? (res.data.value as AiTriage) : null;
                if (!t?.addOn) throw new Error("No add-on was suggested for this request.");
                setAddOnId(t.addOn.id);
                setQty(1);
              }}
            />
          )}
          {r.can.decide && !["quoted", "approved"].includes(r.status) && (
            <Card>
              <h2 className="font-medium">Decide</h2>
              <div className="mt-3 grid gap-2">
                {r.type !== "new_scope" && !decided && (
                  <Button disabled={busy} onClick={() => decide(r.type === "urgent" ? { action: "accept_urgent", message: msg } : { action: "in_scope", message: msg })}>
                    {r.type === "urgent" ? "Accept urgent request" : "In scope: start work"}
                  </Button>
                )}
                {["in_progress", "paid", "in_scope"].includes(r.status) && (
                  <Button disabled={busy} onClick={() => decide({ action: "done", message: msg })}>
                    Mark done
                  </Button>
                )}
              </div>

              {!["approved", "paid", "in_progress", "quoted"].includes(r.status) && (
                <div className="mt-5 grid gap-2 border-t border-border pt-4 text-sm">
                  <p className="font-medium">New direction: send a quote</p>
                  <Select value={addOnId} onChange={(e) => setAddOnId(e.target.value)}>
                    <option value="">Pick an add-on…</option>
                    {priced.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {formatINR(a.pricePaise!)}
                        {a.unit ? ` / ${a.unit}` : ""}
                      </option>
                    ))}
                  </Select>
                  <div className="flex gap-2">
                    <Input type="number" min={1} max={100} value={qty} onChange={(e) => setQty(Number(e.target.value) || 1)} className="w-20" aria-label="Quantity" />
                    <Input value={timeline} onChange={(e) => setTimeline(e.target.value)} placeholder="Timeline, e.g. 3 working days" />
                  </div>
                  {r.can.quoteCustom && <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Or a custom amount in ₹ (Founder/Branch Manager)" inputMode="decimal" />}
                  {pick && !custom && <p className="text-xs text-ink-muted">Quote: {formatINR(pick.pricePaise! * qty)} + GST</p>}
                  <Button
                    disabled={busy || timeline.trim().length < 2 || (!addOnId && !custom)}
                    onClick={() =>
                      decide(
                        custom
                          ? { action: "quote", customAmountPaise: rupeesToPaise(Number(custom)), quantity: 1, timeline, message: msg }
                          : { action: "quote", addOnId, quantity: qty, timeline, message: msg },
                      )
                    }
                  >
                    Send quote for approval
                  </Button>
                  <p className="text-xs text-ink-muted">Work starts only after the client owner approves in writing and pays.</p>
                </div>
              )}

              <div className="mt-5 grid gap-2 border-t border-border pt-4">
                <Button variant="secondary" disabled={busy || !msg} onClick={() => decide({ action: "reschedule", timeline: timeline || "Next cycle", message: message })}>
                  Reschedule (uses note + timeline)
                </Button>
                <Button variant="ghost" disabled={busy || !msg} onClick={() => decide({ action: "decline", message: message })}>
                  Decline with note
                </Button>
              </div>
            </Card>
          )}
          {r.quote && (
            <Card>
              <h2 className="font-medium">Quote</h2>
              <p className="mt-1 text-sm">
                {formatINR(r.quote.amountPaise)} + GST {formatINR(r.quote.gstPaise)} = <strong>{formatINR(r.quote.totalPaise)}</strong>
              </p>
              {r.quote.timeline && <p className="text-xs text-ink-muted">{r.quote.timeline}</p>}
              {r.approval && <p className="mt-2 text-xs text-ink-muted">Approved by {r.approval.by}, {when.format(new Date(r.approval.at))}</p>}
              {r.invoice && (
                <p className="mt-2 text-xs text-ink-muted">
                  Invoice {r.invoice.number} · {r.invoice.status}
                </p>
              )}
            </Card>
          )}
          {(r.rating || !!r.reopenCount || r.status === "done") && (
            <Card>
              <h2 className="font-medium">Client satisfaction</h2>
              {r.rating ? (
                <p className="mt-1 text-sm" data-testid="team-request-rating">
                  {r.rating.value === "up" ? "👍 Happy" : "👎 Not happy"} · {r.rating.by}, {when.format(new Date(r.rating.at))}
                  {r.rating.comment && <span className="mt-1 block text-ink-muted">“{r.rating.comment}”</span>}
                </p>
              ) : (
                <p className="mt-1 text-sm text-ink-muted">{r.status === "done" ? "Not rated yet. The client was asked when you marked it done." : "Rating opens when the request is done."}</p>
              )}
              {!!r.reopenCount && <p className="mt-2 text-xs text-amber">Reopened by the client {r.reopenCount === 1 ? "once" : `${r.reopenCount} times`}.</p>}
            </Card>
          )}
          {error && <p className="text-sm text-red">{error}</p>}
        </div>
      </div>
      {panel === "convert" && <ConvertToTasksDrawer requestId={r.id} open onClose={() => setPanel(null)} onDone={(m) => refresh(m)} />}
      {panel === "custom" && <CustomQuoteDialog requestId={r.id} open onClose={() => setPanel(null)} onDone={(m) => refresh(m)} />}
    </>
  );
}
