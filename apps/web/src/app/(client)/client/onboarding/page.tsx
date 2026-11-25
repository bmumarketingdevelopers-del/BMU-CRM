"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { billingLabels, planLabels, type Plan, type SubServiceBilling } from "@bmu/shared";
import { ClientChecklist } from "@/components/client-checklist";
import { Empty, Panel } from "@/components/dash";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { clientProjectStatus } from "@/lib/client-labels";
import { useLoad } from "@/lib/use-load";

const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const day = (iso: string) => fmt.format(new Date(iso));
const accountStatus: Record<string, string> = { lead: "New", onboarding: "Getting started", active: "Active", on_hold: "On hold", inactive: "Inactive" };
const billing = (b: string) => billingLabels[b as SubServiceBilling] ?? b;
const plan = (p: string) => `${planLabels[p as Plan] ?? p} plan`;
const site = (w: string) => (/^https?:\/\//i.test(w) ? w : `https://${w}`);
const DONE = ["delivered", "closed"];

/** The client's onboarding record: when they joined, their Client Manager, and the services and projects they chose. */
export default function OnboardingPage() {
  const o = useLoad(() => api.client.onboardingDetails());
  const d = o.data;
  if (!d) return <LoadState loading={o.loading} error={o.error} />;
  const { company: c, manager: m } = d;

  return (
    <>
      <PageTitle title="Onboarding" subtitle="When you joined BMU, who looks after you, and what you chose." />
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0" data-testid="client-onboarding">
        <Panel title="Your account" action={<Badge tone={d.status === "active" ? "green" : "neutral"}>{accountStatus[d.status] ?? d.status}</Badge>}>
          <Details
            rows={[
              ["Company", c.name],
              ["Onboarded on", day(d.onboardedAt)],
              ["Account created", day(d.accountCreatedAt)],
              ["First project started", d.firstProjectStartedAt ? day(d.firstProjectStartedAt) : "Not started yet"],
              ["Industry", c.industry],
              ["Website", c.website && <a href={site(c.website)} target="_blank" rel="noreferrer" className="underline">{c.website}</a>],
              ["Brands", c.brands.join(", ")],
              ["Your contact", [c.contact.name, c.contact.phone, c.contact.email].filter(Boolean).join(" · ")],
            ]}
          />
        </Panel>

        <Panel title="Your Client Manager" subtitle="Your main contact at BMU">
          {m ? (
            <>
              <Details
                rows={[
                  ["Name", m.name],
                  ["Phone", m.phone && <a href={`tel:${m.phone}`} className="underline">{m.phone}</a>],
                  ["Email", m.email && <a href={`mailto:${m.email}`} className="break-all underline">{m.email}</a>],
                ]}
              />
              <Link href="/client/messages" className="mt-5 inline-block bg-charcoal px-4 py-2 text-sm font-medium text-ivory hover:opacity-90">
                Send a message
              </Link>
            </>
          ) : (
            <p className="text-sm text-ink-muted">Your Client Manager is being assigned. We will let you know.</p>
          )}
        </Panel>
      </div>

      {d.services.length > 0 && (
        <Panel title="Services you chose" className="mt-6" flush>
          <ul className="divide-y divide-border">
            {d.services.map((s) => (
              <Item
                key={s.id}
                title={s.name}
                detail={s.description}
                meta={[s.group, s.plan && plan(s.plan), billing(s.billing), s.startDate && `From ${day(s.startDate)}`]}
                badge={<Badge tone={s.status === "active" ? "green" : "amber"}>{s.status === "active" ? "Active" : "Paused"}</Badge>}
              />
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Your projects" className="mt-6" flush>
        {d.projects.length ? (
          <ul className="divide-y divide-border">
            {d.projects.map((p) => (
              <Item
                key={p.id}
                title={p.name}
                detail={p.includes.join(", ")}
                meta={[
                  p.plan && plan(p.plan),
                  billing(p.billingType),
                  `Added ${day(p.addedAt)}`,
                  p.startedAt ? `Started ${day(p.startedAt)}` : "Start date not set yet",
                  p.endDate && `${DONE.includes(p.status) ? "Ended" : "Until"} ${day(p.endDate)}`,
                  p.manager && `Managed by ${p.manager}`,
                ]}
                badge={<Badge tone={DONE.includes(p.status) ? "neutral" : "green"}>{clientProjectStatus[p.status] ?? p.status.replaceAll("_", " ")}</Badge>}
              />
            ))}
          </ul>
        ) : (
          <Empty>No projects yet.</Empty>
        )}
      </Panel>

      <ClientChecklist kind="access" />
    </>
  );
}

/** Label and value lines; lines with nothing to show are left out. */
function Details({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
      {rows
        .filter(([, v]) => v)
        .map(([label, v]) => (
          <div key={label} className="contents">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="min-w-0 max-sm:-mt-2">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function Item({ title, detail, meta, badge }: { title: string; detail?: string; meta: (string | null | false | undefined | "")[]; badge: ReactNode }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {detail && <p className="mt-0.5 text-ink-muted">{detail}</p>}
        <p className="mt-1 text-xs text-ink-muted">{meta.filter(Boolean).join(" · ")}</p>
      </div>
      {badge}
    </li>
  );
}
