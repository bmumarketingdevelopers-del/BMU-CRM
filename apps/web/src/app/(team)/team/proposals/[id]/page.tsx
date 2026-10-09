"use client";

import { use, useState } from "react";
import Link from "next/link";
import { formatINR, sellApprovalLevelLabels } from "@bmu/shared";
import { statusBadge } from "@/components/proposal-status";
import { ProposalSummary } from "@/components/proposal-summary";
import { Badge, Button, Card, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const date = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const stepTone = { approved: "green", rejected: "red", pending: "amber", waiting: "neutral", cancelled: "neutral" } as const;

export default function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // Keyed so moving between versions (same route, new id) loads fresh data.
  return <ProposalDetail key={id} id={id} />;
}

function ProposalDetail({ id }: { id: string }) {
  const p = useLoad(() => api.proposals.get(id));
  const inbox = useLoad(() => api.sell.approvals());
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [extendDays, setExtendDays] = useState(7);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      await fn();
      if (ok) setNotice(ok);
      p.reload();
      inbox.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!p.data) return <LoadState loading={p.loading} error={p.error} />;
  const v = p.data;
  const link = typeof window === "undefined" ? `/p/${v.publicToken}` : `${window.location.origin}/p/${v.publicToken}`;
  const steps = v.approvalSteps ?? [];
  const myStep = inbox.data?.pending.find((i) => i.proposalId === v.id && i.canDecide);
  const openChanges = (v.changeRequests ?? []).filter((c) => !c.resolvedAt);
  const canRevise = ["draft", "sent", "expired"].includes(v.status) && !(v.versions ?? []).some((x) => x.status === "accepted");
  const latest = v.supersededById;
  const blocked = v.discountNeedsApproval && !v.discountApproved;

  return (
    <>
      <PageTitle
        title={v.client.company || v.client.name}
        subtitle={`${v.kind === "renewal" ? "Renewal proposal" : "Proposal"} v${v.version} · valid until ${date.format(new Date(v.validUntil))}`}
        action={
          <div className="flex flex-wrap gap-3 text-sm">
            <Link href={`/team/leads/${v.leadId}`} className="underline">
              Lead history
            </Link>
            <Link href="/team/proposals" className="underline">
              All proposals
            </Link>
          </div>
        }
      />
      {error && (
        <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="mb-4 border border-green bg-green/10 px-4 py-2 text-sm" role="status">
          {notice}
        </p>
      )}
      {v.status === "superseded" && (
        <Card className="mb-4 border-amber">
          <p className="text-sm">
            This version was replaced by a newer one. The client&apos;s old link now shows “superseded”.{" "}
            {latest && (
              <Link href={`/team/proposals/${latest}`} className="underline">
                Open the latest version
              </Link>
            )}
          </p>
        </Card>
      )}
      {openChanges.length > 0 && (
        <Card className="mb-4 border-amber">
          <h2 className="font-semibold">The client asked for changes</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {openChanges.map((c) => (
              <li key={c.id}>
                “{c.comment}”
                <span className="block text-xs text-ink-muted">
                  {c.byName} · {date.format(new Date(c.at))} · on v{c.version}
                </span>
              </li>
            ))}
          </ul>
          {canRevise && (
            <Link href={`/team/proposals/new?revise=${v.id}`} className="mt-3 inline-block bg-charcoal px-4 py-2 text-sm font-semibold text-ivory">
              Make a new version
            </Link>
          )}
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <ProposalSummary p={v} />
          </Card>
          {(v.versions?.length ?? 0) > 1 && (
            <Card>
              <h2 className="mb-2 font-semibold">Version history</h2>
              <ol className="divide-y divide-border text-sm">
                {[...(v.versions ?? [])].reverse().map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {x.id === v.id ? <strong>v{x.version} (this one)</strong> : <Link href={`/team/proposals/${x.id}`} className="underline">v{x.version}</Link>} · {formatINR(x.totalPaise)}
                      {x.changeNote && <span className="block text-xs text-ink-muted">{x.changeNote}</span>}
                    </span>
                    <span className="text-xs text-ink-muted">
                      {x.status}
                      {x.sentAt ? ` · sent ${date.format(new Date(x.sentAt))}` : ` · drafted ${date.format(new Date(x.createdAt))}`}
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          )}
          {(v.changeRequests ?? []).some((c) => c.resolvedAt) && (
            <Card>
              <h2 className="mb-2 font-semibold">Earlier change requests</h2>
              <ul className="space-y-2 text-sm">
                {(v.changeRequests ?? [])
                  .filter((c) => c.resolvedAt)
                  .map((c) => (
                    <li key={c.id}>
                      “{c.comment}” <span className="text-xs text-ink-muted">· {c.byName}, v{c.version} · answered with a new version</span>
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card>
            <div className="flex items-center justify-between">
              <span className="text-sm text-ink-muted">Status</span>
              {statusBadge(v)}
            </div>
            <ul className="mt-3 space-y-1 text-sm">
              <li>Created {date.format(new Date(v.createdAt))}</li>
              {v.sentAt && <li>Sent {date.format(new Date(v.sentAt))}</li>}
              {v.viewedAt && (
                <li>
                  First opened by client {date.format(new Date(v.viewedAt))}
                  {v.viewCount ? ` · opened ${v.viewCount} time${v.viewCount === 1 ? "" : "s"}` : ""}
                  {v.lastViewedAt && v.viewCount && v.viewCount > 1 ? ` (last ${date.format(new Date(v.lastViewedAt))})` : ""}
                </li>
              )}
              {v.status === "sent" && !v.viewedAt && <li className="text-ink-muted">Not opened yet</li>}
              {v.acceptedAt && <li>Accepted and signed {date.format(new Date(v.acceptedAt))}</li>}
              {v.signer && (
                <li className="text-ink-muted">
                  Signed by {v.signer.name}
                  {v.signer.designation ? `, ${v.signer.designation}` : ""} ({v.signer.email}){v.signer.ip ? ` from IP ${v.signer.ip}` : ""}
                </li>
              )}
              {v.invoice && (
                <li>
                  Invoice {v.invoice.number}: {formatINR(v.invoice.totalPaise)} ({v.invoice.status})
                </li>
              )}
              {v.owner && <li className="text-ink-muted">Lead owner: {v.owner.name}</li>}
            </ul>
            {v.status === "accepted" && (
              <a href={`/p/${v.publicToken}/agreement`} target="_blank" className="mt-3 inline-block text-sm underline">
                Signed agreement (print or save as PDF)
              </a>
            )}
          </Card>

          {steps.length > 0 && (
            <Card className={blocked ? "border-amber" : ""}>
              <h2 className="font-semibold">Discount approval</h2>
              <p className="mt-1 text-sm text-ink-muted">
                {v.extraDiscountPct}% special discount ({formatINR(v.discountPaise - v.bundleDiscountPaise)}).{" "}
                {v.discountStatus === "approved" ? "Fully approved." : v.discountStatus === "rejected" ? "Rejected: make a new version with a smaller discount." : "Needs approval before it can be sent."}
              </p>
              <ol className="mt-3 space-y-2 text-sm">
                {steps.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-start justify-between gap-2">
                    <span>
                      Step {s.step}: {sellApprovalLevelLabels[s.level]}
                      {s.decider && <span className="block text-xs text-ink-muted">{s.decider}{s.decidedAt ? ` · ${date.format(new Date(s.decidedAt))}` : ""}{s.note ? ` · “${s.note}”` : ""}</span>}
                    </span>
                    <Badge tone={stepTone[s.status]}>{s.status === "waiting" ? "next" : s.status}</Badge>
                  </li>
                ))}
              </ol>
              {myStep && (
                <div className="mt-3 border-t border-border pt-3">
                  {!rejecting ? (
                    <div className="flex flex-wrap gap-2">
                      <Button disabled={busy} onClick={() => act(() => api.sell.approve(myStep.stepId, note || undefined), "Discount approved.")}>
                        Approve discount
                      </Button>
                      <Button variant="secondary" disabled={busy} onClick={() => setRejecting(true)}>
                        Reject
                      </Button>
                    </div>
                  ) : (
                    <form
                      className="grid gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        act(() => api.sell.reject(myStep.stepId, note), "Discount rejected. Sales has been told why.").then(() => setRejecting(false));
                      }}
                    >
                      <Input aria-label="Reason for rejecting" placeholder="Why? (sales will see this)" required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} />
                      <div className="flex gap-2">
                        <Button type="submit" disabled={busy}>
                          Reject discount
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </Card>
          )}

          {v.status === "draft" && (
            <Button className="w-full" disabled={blocked || busy} onClick={() => act(() => api.proposals.send(v.id), "Sent. Share the client link below.")}>
              {blocked ? "Waiting for discount approval" : "Send to client"}
            </Button>
          )}

          {canRevise && openChanges.length === 0 && (
            <Link href={`/team/proposals/new?revise=${v.id}`} className="block border border-border px-4 py-2 text-center text-sm font-semibold">
              Edit as a new version
            </Link>
          )}

          {(v.status === "sent" || v.status === "expired") && (
            <Card className={v.status === "expired" ? "border-red" : ""}>
              <h2 className="text-sm font-semibold">{v.status === "expired" ? "This proposal has expired" : "Validity"}</h2>
              <p className="mt-1 text-sm text-ink-muted">Valid until {date.format(new Date(v.validUntil))}. Extending re-opens the client&apos;s link.</p>
              <div className="mt-2 flex gap-2">
                <Select aria-label="Extend by" value={String(extendDays)} onChange={(e) => setExtendDays(Number(e.target.value))}>
                  {[3, 7, 14, 30].map((n) => (
                    <option key={n} value={n}>
                      {n} days
                    </option>
                  ))}
                </Select>
                <Button variant="secondary" disabled={busy} onClick={() => act(() => api.sell.extend(v.id, extendDays), `Extended by ${extendDays} days.`)}>
                  Extend
                </Button>
              </div>
            </Card>
          )}

          {v.status !== "draft" && (
            <Card>
              <p className="mb-2 text-sm">Client link (view, ask for changes, accept, sign and pay):</p>
              <Input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Client link" />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link);
                      setCopied(true);
                    } catch {
                      setError("Couldn't copy automatically. Select the link and copy it.");
                    }
                  }}
                >
                  {copied ? "Copied" : "Copy link"}
                </Button>
                {v.client.phone && (
                  <a
                    href={`https://wa.me/91${v.client.phone.replace(/\D/g, "").slice(-10)}?text=${encodeURIComponent(`Hi ${v.client.name}, here is your proposal from BMU Marketing: ${link}`)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="self-center text-sm underline"
                  >
                    Share on WhatsApp
                  </a>
                )}
                <a href={`/p/${v.publicToken}?preview=1`} target="_blank" className="self-center text-sm underline">
                  Preview as client
                </a>
              </div>
              <p className="mt-2 text-xs text-ink-muted">Previewing here doesn&apos;t count as a client view.</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
