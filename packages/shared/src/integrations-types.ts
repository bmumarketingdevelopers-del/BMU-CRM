// v19 integrations, publishing and public API: shared types and validation.
import { z } from "zod";

// ------------------------------------------------------------------------------------------------ connectors

export const INTEGRATION_PROVIDERS = ["instagram", "facebook", "linkedin", "youtube", "meta_ads", "google_ads", "ga4"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** Who signs you in for each provider: one Meta login covers Instagram, Facebook pages and Meta ad accounts. */
export const PROVIDER_INFO: Record<IntegrationProvider, { label: string; kind: "social" | "ads" | "analytics"; login: "meta" | "linkedin" | "google"; publishes: boolean; env: string[] }> = {
  instagram: { label: "Instagram", kind: "social", login: "meta", publishes: true, env: ["META_APP_ID", "META_APP_SECRET"] },
  facebook: { label: "Facebook page", kind: "social", login: "meta", publishes: true, env: ["META_APP_ID", "META_APP_SECRET"] },
  linkedin: { label: "LinkedIn page", kind: "social", login: "linkedin", publishes: true, env: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"] },
  youtube: { label: "YouTube channel", kind: "social", login: "google", publishes: true, env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] },
  meta_ads: { label: "Meta Ads", kind: "ads", login: "meta", publishes: false, env: ["META_APP_ID", "META_APP_SECRET"] },
  google_ads: { label: "Google Ads", kind: "ads", login: "google", publishes: false, env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN"] },
  ga4: { label: "Google Analytics 4", kind: "analytics", login: "google", publishes: false, env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] },
};

/** Content calendar channel → the account kind that can publish it. */
export const CHANNEL_PROVIDER: Partial<Record<string, IntegrationProvider>> = { instagram: "instagram", facebook: "facebook", linkedin: "linkedin", youtube: "youtube" };

export type IntegrationAccountView = {
  id: string;
  provider: IntegrationProvider;
  mode: "live" | "test";
  name: string;
  externalId: string;
  client: { id: string; name: string } | null;
  status: "connected" | "error" | "disconnected";
  lastSyncAt: string | null;
  lastError: string | null;
  connectedBy: string;
  createdAt: string;
  published: number;
};

export type ConnectorStatus = {
  provider: IntegrationProvider;
  label: string;
  kind: "social" | "ads" | "analytics";
  publishes: boolean;
  /** Keys are on the server, so "Connect" opens the provider's sign-in. */
  configured: boolean;
  missingEnv: string[];
  accounts: number;
  errors: number;
};

export type SyncJobView = {
  id: string;
  accountId: string;
  accountName: string;
  provider: IntegrationProvider;
  kind: "publish" | "post_metrics" | "ad_metrics" | "refresh";
  status: "running" | "ok" | "failed";
  items: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type PublicationView = {
  id: string;
  deliverableId: string;
  title: string;
  client: string;
  accountName: string;
  provider: IntegrationProvider;
  status: "queued" | "publishing" | "published" | "failed";
  attempts: number;
  error: string | null;
  url: string | null;
  nextAttemptAt: string | null;
  publishedAt: string | null;
};

export type IntegrationsHubView = {
  connectors: ConnectorStatus[];
  accounts: IntegrationAccountView[];
  jobs: SyncJobView[];
  publications: PublicationView[];
  testAccountsAllowed: boolean;
  callbackUrl: string;
  canManage: boolean;
};

export const testAccountSchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDERS),
  clientOrgId: z.string().min(1).nullable(),
  name: z.string().trim().max(80).optional(),
});
export type TestAccountInput = z.infer<typeof testAccountSchema>;

export const oauthStartSchema = z.object({ provider: z.enum(INTEGRATION_PROVIDERS), clientOrgId: z.string().min(1).nullable() });
export type OauthStartInput = z.infer<typeof oauthStartSchema>;

export const accountUpdateSchema = z.object({ clientOrgId: z.string().min(1).nullable() });
export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>;

// ------------------------------------------------------------------------------------------------ ads and website results

export type AdResultsView = {
  from: string;
  to: string;
  hasData: boolean;
  totals: { spendPaise: number; impressions: number; clicks: number; conversions: number; ctrPct: number | null; cpcPaise: number | null; costPerConversionPaise: number | null; sessions: number; users: number; revenuePaise: number };
  byProvider: { provider: IntegrationProvider; label: string; spendPaise: number; impressions: number; clicks: number; conversions: number; sessions: number; users: number; revenuePaise: number }[];
  daily: { date: string; spendPaise: number; clicks: number; conversions: number; sessions: number }[];
  campaigns: { provider: IntegrationProvider; campaign: string; spendPaise: number; impressions: number; clicks: number; conversions: number }[];
  accounts: { id: string; name: string; provider: IntegrationProvider; mode: "live" | "test"; status: string; lastSyncAt: string | null }[];
};

// ------------------------------------------------------------------------------------------------ public API keys

export const API_SCOPES = ["leads:read", "leads:write", "clients:read", "projects:read", "tasks:read", "tasks:write", "invoices:read", "content:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const apiScopeLabels: Record<ApiScope, string> = {
  "leads:read": "Read leads",
  "leads:write": "Create leads",
  "clients:read": "Read clients",
  "projects:read": "Read projects",
  "tasks:read": "Read tasks",
  "tasks:write": "Create tasks",
  "invoices:read": "Read invoices",
  "content:read": "Read the content calendar",
};

export type ApiKeyView = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  actsAs: { id: string; name: string };
  rateLimitPerMin: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
  rateLimitPerMin: z.number().int().min(10).max(600).default(120),
  expiresInDays: z.number().int().min(1).max(730).nullable().default(null),
});
export type ApiKeyCreateInput = z.input<typeof apiKeyCreateSchema>;
export type ApiKeyCreated = { key: string; row: ApiKeyView };

// ------------------------------------------------------------------------------------------------ outgoing webhooks

/** Events people usually subscribe to. Any audited event type works, and "area.*" or "*" match many. */
export const WEBHOOK_EVENTS: { type: string; label: string }[] = [
  { type: "lead.created", label: "A lead came in" },
  { type: "lead.won", label: "A lead was won" },
  { type: "lead.lost", label: "A lead was lost" },
  { type: "proposal.sent", label: "A proposal was sent" },
  { type: "proposal.accepted", label: "A proposal was accepted" },
  { type: "onboarding.started", label: "A new client was set up" },
  { type: "invoice.issued", label: "An invoice was issued" },
  { type: "invoice.paid", label: "A payment was received" },
  { type: "task.created", label: "A task was created" },
  { type: "deliverable.approved", label: "Work was approved" },
  { type: "deliverable.published", label: "A post went live" },
  { type: "post.publish_failed", label: "A post could not be published" },
  { type: "meeting.booked", label: "A meeting was booked" },
  { type: "form.submitted", label: "A form was submitted" },
];

export const webhookEventPattern = z
  .string()
  .trim()
  .regex(/^(\*|[a-z_]+\.(\*|[a-z_]+))$/, "Use an event like lead.created, an area like lead.*, or * for everything");

export const webhookCreateSchema = z.object({
  url: z.string().trim().url("Enter a full web address starting with https://").max(500),
  description: z.string().trim().max(200).optional(),
  events: z.array(webhookEventPattern).min(1).max(40),
});
export type WebhookCreateInput = z.infer<typeof webhookCreateSchema>;

export const webhookUpdateSchema = z.object({
  url: z.string().trim().url().max(500).optional(),
  description: z.string().trim().max(200).optional(),
  events: z.array(webhookEventPattern).min(1).max(40).optional(),
  active: z.boolean().optional(),
});
export type WebhookUpdateInput = z.infer<typeof webhookUpdateSchema>;

export type WebhookView = {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  failingSince: string | null;
  createdAt: string;
  stats: { delivered: number; pending: number; dead: number; lastDeliveredAt: string | null };
};

export type WebhookCreated = { secret: string; row: WebhookView };

export type WebhookDeliveryView = {
  id: string;
  type: string;
  status: "pending" | "delivered" | "dead";
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  durationMs: number | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

/** The envelope every webhook receives. Verify X-BMU-Signature: sha256=HMAC_SHA256(secret, `${X-BMU-Timestamp}.${body}`). */
export type WebhookPayload = {
  id: string;
  type: string;
  occurredAt: string;
  entity: string;
  entityId: string;
  data: Record<string, unknown> | null;
};

// ------------------------------------------------------------------------------------------------ accounting exports

export const ACCOUNTING_FORMATS = ["csv", "tally_xml", "zoho_invoices", "zoho_payments"] as const;
export type AccountingFormat = (typeof ACCOUNTING_FORMATS)[number];
export const accountingFormatLabels: Record<AccountingFormat, string> = {
  csv: "Voucher list (CSV, any software)",
  tally_xml: "Tally Prime import (XML)",
  zoho_invoices: "Zoho Books invoices (CSV)",
  zoho_payments: "Zoho Books customer payments (CSV)",
};
