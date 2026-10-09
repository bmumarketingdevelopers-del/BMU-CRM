"use client";

import type { IntegrationKey, IntegrationStatus } from "@bmu/shared";
import { StatRow, StatTile } from "@/components/dash";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { IntegrationSwitches } from "@/components/ops/integration-switches";
import { IntegrationsHub } from "@/components/integrations/hub";

const TOOL_NAMES: Record<string, string> = { tally: "Tally", zoho_books: "Zoho Books", quickbooks: "QuickBooks", none: "None" };

const INFO: Record<IntegrationKey, { name: string; usedFor: string; steps: string[]; env?: string[] }> = {
  razorpay: {
    name: "Razorpay",
    usedFor: "Online payments for proposals, retainer invoices, project balances and extra requests. Without it, payments run in test mode.",
    env: ["RAZORPAY_KEY_ID=rzp_live_…", "RAZORPAY_KEY_SECRET=…"],
    steps: ["Sign in to the Razorpay Dashboard → Account & Settings → API Keys.", "Generate a key pair (use Test mode keys first).", "Add both values to apps/api/.env as shown below.", "Restart the API."],
  },
  email: {
    name: "Email (SMTP)",
    usedFor: "Sign-in codes, invoice emails and the email channel of notification templates.",
    env: ["SMTP_HOST=smtp.yourprovider.com", "SMTP_PORT=587", "SMTP_USER=…", "SMTP_PASS=…", "SMTP_FROM=BMU Marketing <hello@bmumarketing.in>"],
    steps: ["Create SMTP credentials with your email provider (Google Workspace, Zoho Mail, SES, etc.).", "Add the values to apps/api/.env.", "Restart the API. Until then, emails are written to the server log."],
  },
  whatsapp: {
    name: "WhatsApp",
    usedFor: "WhatsApp channel of notification templates (draft ready, invoices, quotes).",
    env: ["WHATSAPP_TOKEN=…", "WHATSAPP_PHONE_NUMBER_ID=…"],
    steps: ["In Meta Business Manager, set up the WhatsApp Business Platform and a phone number.", "Create a permanent access token for a system user.", "Add the token and phone number ID to apps/api/.env and restart the API. Until then, messages are written to the server log."],
  },
  storage: {
    name: "File storage",
    usedFor: "Drafts, final files, requirement uploads and creator submissions.",
    env: ["STORAGE_DIR=/srv/bmu-files"],
    steps: ["By default files are kept on the API server in apps/api/storage.", "To use a mounted drive or synced folder (for example Google Drive for desktop), set STORAGE_DIR in apps/api/.env to that folder.", "Restart the API. Make sure the folder is backed up."],
  },
  accounting: {
    name: "Accounting",
    usedFor: "Exporting invoices and payments to your accounting software.",
    steps: ["Open Finance → Accounting Sync.", "Choose Tally, Zoho Books or QuickBooks.", "Export invoices and payments from there each month. No key is needed."],
  },
};

export default function IntegrationsPage() {
  const data = useLoad(() => api.adminPlatform.integrations());
  const rows = data.data ?? [];
  const ready = rows.filter((r) => r.configured && !r.usingDefault).length;
  return (
    <>
      <PageTitle title="Integrations" subtitle="Client social, ads and analytics accounts, plus the outside services BMU Hub uses. Keys live only on the server and are never shown here." action={<a href="/admin/developer" className="text-sm underline">API & Webhooks</a>} />
      <IntegrationsHub />
      <h2 className="mb-4 mt-10 text-[15px] font-semibold tracking-tight">Server services</h2>
      {!data.data ? (
        <LoadState loading={data.loading} error={data.error} />
      ) : (
        <>
          <div className="mb-6">
            <StatRow cols={3}>
              <StatTile label="Connected" value={`${ready} of ${rows.length}`} tone={ready === rows.length ? "good" : "default"} />
              <StatTile label="Payments" value={rows.find((r) => r.key === "razorpay")?.configured ? "Live" : "Test mode"} tone={rows.find((r) => r.key === "razorpay")?.configured ? "good" : "warn"} />
              <StatTile label="Email and WhatsApp" value={rows.filter((r) => (r.key === "email" || r.key === "whatsapp") && r.configured).length ? "Sending" : "Log only"} hint="development stub until set up" />
            </StatRow>
          </div>
          <IntegrationSwitches />
          <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
            {rows.map((r) => (
              <Card key={r.key} row={r} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Card({ row }: { row: IntegrationStatus }) {
  const info = INFO[row.key];
  const status = row.key === "storage" ? (row.usingDefault ? { tone: "amber" as const, text: "Using local folder" } : { tone: "green" as const, text: "Custom folder set" }) : row.configured ? { tone: "green" as const, text: row.key === "accounting" ? `Connected · ${TOOL_NAMES[row.accountingTool ?? "none"] ?? row.accountingTool}` : "Configured" } : { tone: "neutral" as const, text: "Not set up" };
  return (
    <section className="flex flex-col border border-border bg-surface-raised">
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">{info.name}</h2>
          <p className="mt-1 text-sm text-ink-muted">{info.usedFor}</p>
        </div>
        <Badge tone={status.tone}>{status.text}</Badge>
      </header>
      <div className="flex-1 space-y-4 p-5">
        <div>
          <p className="mb-2 text-[11px] uppercase tracking-[0.1em] text-ink-muted">How to set up</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm marker:text-ink-muted">
            {info.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
        {info.env && (
          <div>
            <p className="mb-2 text-[11px] uppercase tracking-[0.1em] text-ink-muted">apps/api/.env</p>
            <pre className="overflow-x-auto bg-canvas px-3 py-2 font-mono text-xs leading-relaxed">{info.env.join("\n")}</pre>
          </div>
        )}
        {row.key === "accounting" && (
          <a href="/admin/finance/accounting" className="inline-block text-sm underline">
            Open Accounting Sync
          </a>
        )}
      </div>
    </section>
  );
}
