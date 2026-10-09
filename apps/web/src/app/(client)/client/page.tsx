import Link from "next/link";
import type { ReactNode } from "react";
import { dashboardDefaultLayout, formatINR } from "@bmu/shared";
import { DashGrid } from "@/components/dashboards/grid";
import { Panel, StatRow, StatTile } from "@/components/dash";
import { GateTrack } from "@/components/gate-track";
import { Badge, PageTitle } from "@/components/ui";
import { requireMe, serverApi } from "@/lib/session";

export const metadata = { title: "Home | BMU Hub" };

// Client-facing status labels (glossary: Blocked → Waiting on input).
const clientStatus: Record<string, string> = {
  pending_payment: "Awaiting payment",
  onboarding: "Getting started",
  blocked: "Waiting on input",
  planning: "Planning",
  awaiting_plan_approval: "Plan ready for you",
  in_production: "In production",
  in_review: "Ready for your review",
  awaiting_final_payment: "Final payment due",
  delivered: "Delivered",
  active_retainer: "Active",
  paused: "Paused",
  offboarding: "Wrapping up",
  closed: "Closed",
};

type Action = { key: string; title: string; detail?: string; href: string; cta: string; amount?: string };

export default async function ClientHome() {
  const me = await requireMe(["client"]);
  const client = await serverApi();
  const [o, reviews, requests, delivery, dash, meetings, docs] = await Promise.all([
    client.client.overview(),
    client.client.reviews(),
    client.client.requests().catch(() => []),
    client.client.delivery().catch(() => []),
    client.dashboards.home("client").catch(() => null),
    client.meetings.clientList().catch(() => null),
    client.docs.clientList().catch(() => []),
  ]);
  const nextCall = meetings?.upcoming[0];
  const quotes = requests.filter((r) => r.status === "quoted");
  const finals = delivery.filter((d) => d.allApproved && !d.filesReleased);
  const toReview = reviews.filter((r) => r.waitingOnYou);
  const pendingInputs = o.engagements.reduce((s, e) => s + e.requirementsPending, 0);
  const due = o.invoicesDue.reduce((s, i) => s + i.totalPaise - i.paidPaise, 0);
  const openRequests = requests.filter((r) => !["done", "declined"].includes(r.status)).length;
  const canBill = (me.permissions.invoices_payments?.scope ?? "none") !== "none";

  const actions: Action[] = [
    ...o.invoicesDue.map((i) => ({ key: i.id, title: `Invoice ${i.number} is due`, detail: `Due by ${new Date(i.dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}`, href: "/client/billing", cta: "View billing", amount: formatINR(i.totalPaise - i.paidPaise) })),
    ...(pendingInputs > 0 ? [{ key: "inputs", title: `Send us ${pendingInputs} item${pendingInputs > 1 ? "s" : ""} to get started`, detail: "Your project start date is set once we have everything.", href: "/client/onboarding", cta: "Open the checklist" }] : []),
    ...(toReview.length > 0 ? [{ key: "reviews", title: `${toReview.length} draft${toReview.length > 1 ? "s" : ""} ready for your review`, detail: toReview.map((r) => r.title).join(", "), href: "/client/reviews", cta: "Open Review Studio" }] : []),
    ...quotes.map((r) => ({ key: r.id, title: "A quote is ready for your extra request", detail: r.description, href: `/client/requests/${r.id}`, cta: "Review the quote" })),
    ...finals.map((d) => ({ key: d.engagementId, title: `${d.serviceName} is finished`, detail: "Sign off and pay the final invoice to unlock your files.", href: "/client/files", cta: "Go to final delivery" })),
    ...(o.engagements.some((e) => e.status === "awaiting_plan_approval") ? [{ key: "plan", title: "Your plan is ready for approval", href: "/client/approvals", cta: "Review the plan" }] : []),
  ];

  const sections: Record<string, ReactNode> = {
    tiles: (
      <StatRow cols={4}>
        <StatTile label="Active services" value={o.engagements.filter((e) => !["delivered", "closed", "paused"].includes(e.status)).length} />
        <StatTile label="Drafts to review" value={toReview.length} tone={toReview.length ? "good" : "default"} href="/client/reviews" />
        <StatTile label="Open requests" value={openRequests} href="/client/requests" />
        {canBill ? (
          <StatTile label="Amount due" value={formatINR(due)} tone={due ? "warn" : "default"} href="/client/billing" />
        ) : (
          <StatTile label="Files" value="Open" href="/client/files" hint="Approved work and final files" />
        )}
      </StatRow>
    ),
    needs_you: (
      <Panel title="What needs you" subtitle={actions.length ? `${actions.length} thing${actions.length > 1 ? "s" : ""} waiting` : undefined} flush>
        {actions.length ? (
          <ul className="divide-y divide-border">
            {actions.map((a) => (
              <li key={a.key}>
                <Link href={a.href} className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-l-green px-5 py-4 transition-colors hover:bg-canvas/40">
                  <div className="min-w-0">
                    <p className="font-medium">{a.title}</p>
                    {a.detail && <p className="mt-0.5 truncate text-sm text-ink-muted">{a.detail}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    {a.amount && <span className="text-lg font-semibold tabular-nums">{a.amount}</span>}
                    <span className="text-sm text-ink-muted">{a.cta} →</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-8 text-center text-sm text-ink-muted">Nothing is waiting on you right now. We&apos;ll let you know when something is.</p>
        )}
      </Panel>
    ),
    services: (
      <Panel title="Your services" subtitle="Each service moves through five milestones" flush>
        {o.engagements.length ? (
          <ul className="divide-y divide-border">
            {o.engagements.map((e) => (
              <li key={e.id} className="grid gap-4 px-5 py-5 md:grid-cols-[1fr_2fr] md:items-center">
                <div className="flex items-start justify-between gap-2 md:block">
                  <p className="font-medium">
                    {e.serviceName} <span className="text-sm font-normal capitalize text-ink-muted">· {e.tier}</span>
                  </p>
                  <div className="md:mt-1.5">
                    <Badge tone={["in_review", "awaiting_plan_approval", "awaiting_final_payment", "blocked"].includes(e.status) ? "amber" : e.status === "delivered" ? "green" : "dark"}>{clientStatus[e.status] ?? e.status}</Badge>
                  </div>
                </div>
                <GateTrack track={e.track} clientView />
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-8 text-center text-sm text-ink-muted">Your services show here once your agreement is active.</p>
        )}
      </Panel>
    ),
    account_manager: o.accountManager ? (
        <Panel title="Your Account Manager">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              <span className="flex h-11 w-11 items-center justify-center bg-charcoal text-sm font-semibold text-ivory">
                {o.accountManager.name
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((p) => p[0])
                  .join("")}
              </span>
              <div>
                <p className="font-medium">{o.accountManager.name}</p>
                <p className="text-sm text-ink-muted">{o.accountManager.email ?? o.accountManager.phone}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/client/messages" className="border border-border px-4 py-2 text-sm hover:border-ink">
                Send a message
              </Link>
              <Link href="/client/meetings" className="border border-border px-4 py-2 text-sm hover:border-ink" data-testid="home-book-call">
                {nextCall ? "Your calls" : "Book a call"}
              </Link>
            </div>
          </div>
          {(nextCall || docs.length > 0) && (
            <div className="mt-4 grid gap-3 border-t border-border pt-4 text-sm sm:grid-cols-2">
              {nextCall && (
                <p data-testid="next-meeting">
                  <span className="block text-xs uppercase tracking-wide text-ink-muted">Next call</span>
                  {new Date(nextCall.startAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} with {nextCall.host.name}
                </p>
              )}
              {docs.length > 0 && (
                <div>
                  <span className="block text-xs uppercase tracking-wide text-ink-muted">Shared documents</span>
                  {docs.slice(0, 3).map((d) => (
                    <Link key={d.id} href={`/client/docs/${d.id}`} className="block underline">
                      {d.title}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </Panel>
      ) : null,
  };

  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle
        title={`Hello, ${me.name.split(" ")[0]}`}
        subtitle={`${o.clientOrg.name}. Everything we're working on for you, and what needs you.`}
        action={
          <Link href="/client/reports" className="text-sm text-ink-muted hover:text-ink">
            Monthly report →
          </Link>
        }
      />

      <DashGrid host="client_home" items={dash?.layout ?? dashboardDefaultLayout("client_home")} sections={sections} />
    </div>
  );
}
