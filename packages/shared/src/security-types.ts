// v20 hardening: field-level permissions, sessions, two-factor, passkeys and DPDP data-protection tools.
import { z } from "zod";
import { TEAM_ROLES, CLIENT_ROLES } from "./roles.js";

// ------------------------------------------------------------------------------------------------ field-level permissions

export type FieldMode = "edit" | "read" | "hidden";
export const FIELD_MODES: FieldMode[] = ["edit", "read", "hidden"];
export const fieldModeLabels: Record<FieldMode, string> = { edit: "Can change", read: "Can see", hidden: "Hidden" };

/**
 * Sensitive fields that can be hidden or made read-only per role. The server removes hidden values from every
 * response (web, app, public API), from search and from what the AI is given, and refuses changes to read-only ones.
 * `defaults` lists the roles that can change the field; `readers` the roles that can only see it; everyone else is hidden.
 */
export const PROTECTED_FIELDS = [
  {
    key: "lead.budget",
    label: "Lead budget",
    area: "Sales",
    description: "The budget a lead told us (leads, lead briefs, AI answers, public API).",
    editors: ["founder", "admin", "sales_manager", "sales_executive", "am_lead"],
    readers: ["account_manager", "strategist", "finance"],
  },
  {
    key: "people.cost_rates",
    label: "Hourly cost rates",
    area: "People",
    description: "What each role costs per hour, and cost per person in Profit and Profitability.",
    editors: ["founder", "admin", "finance"],
    readers: [],
  },
  {
    key: "finance.margins",
    label: "Profit and margin",
    area: "Finance",
    description: "Profit amounts and margin percentages per client, project, service and person.",
    editors: ["founder", "admin", "finance"],
    readers: ["am_lead"],
  },
  {
    key: "creator.rates",
    label: "Creator rate cards",
    area: "Creators",
    description: "What each creator charges per post, reel or video.",
    editors: ["founder", "admin", "department_head", "producer", "finance", "am_lead", "account_manager"],
    readers: ["strategist"],
  },
  {
    key: "people.contact",
    label: "Team phone numbers",
    area: "People",
    description: "Personal phone numbers of team members.",
    editors: ["founder", "admin", "hr_ops"],
    readers: ["department_head", "am_lead", "producer"],
  },
] as const;
export type ProtectedFieldKey = (typeof PROTECTED_FIELDS)[number]["key"];

/** Org overrides: field → role → mode. Missing entries use the defaults above. */
export type FieldAccessSettings = Partial<Record<string, Partial<Record<string, FieldMode>>>>;

export const ALL_ROLES: string[] = [...TEAM_ROLES, ...CLIENT_ROLES];

export function defaultFieldMode(field: string, role: string): FieldMode {
  const f = PROTECTED_FIELDS.find((x) => x.key === field);
  if (!f) return "edit";
  if ((f.editors as readonly string[]).includes(role)) return "edit";
  if ((f.readers as readonly string[]).includes(role)) return "read";
  return "hidden";
}

const RANK: Record<FieldMode, number> = { hidden: 0, read: 1, edit: 2 };

/** A person's mode for a field: the most open of their roles (Founder always edits). */
export function fieldModeFor(field: string, roles: string[], overrides: FieldAccessSettings = {}): FieldMode {
  if (roles.includes("founder")) return "edit";
  let best: FieldMode = "hidden";
  for (const role of roles.length ? roles : ["__none__"]) {
    const m = overrides[field]?.[role] ?? defaultFieldMode(field, role);
    if (RANK[m] > RANK[best]) best = m;
  }
  return best;
}

export const fieldAccessSaveSchema = z.object({
  fields: z.record(z.string(), z.record(z.string(), z.enum(["edit", "read", "hidden"]))),
});
export type FieldAccessSave = z.infer<typeof fieldAccessSaveSchema>;

export type FieldAccessView = {
  fields: { key: string; label: string; area: string; description: string; modes: Record<string, FieldMode>; custom?: { entity: string; id: string } }[];
  roles: { id: string; label: string; client: boolean }[];
  canEdit: boolean;
};

export type ViewAsView = {
  person: { id: string; name: string; roles: string[]; type: string };
  capabilities: { capability: string; label: string; scope: string }[];
  fields: { key: string; label: string; mode: FieldMode }[];
  menu: string[];
  sample: { title: string; shown: Record<string, unknown>; hiddenKeys: string[] } | null;
};

// ------------------------------------------------------------------------------------------------ sessions and sign-in

export type SessionView = { id: string; method: string; device: string; ip: string | null; createdAt: string; lastSeenAt: string; expiresAt: string | null; current: boolean };

/** Sign-in that needs a second step returns this instead of a token. */
export type SecondFactorChallenge = { needsSecondFactor: true; challenge: string; methods: ("totp" | "recovery" | "passkey")[] };

export type TotpSetup = { secret: string; otpauthUrl: string };
export type SecurityOverview = {
  totp: { enabled: boolean; recoveryCodesLeft: number };
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  sessions: SessionView[];
  required: boolean;
  /** v42: the Google account this person's "Continue with Google" is tied to (null: not tied yet). */
  google: { email: string } | null;
};

export const totpCodeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app") });
export const secondFactorSchema = z.object({
  challenge: z.string().min(10),
  code: z.string().trim().min(6).max(20),
});
export const passkeyNameSchema = z.object({ name: z.string().trim().min(1).max(60) });

export const securitySettingsSchema = z.object({
  require2faRoles: z.array(z.string()).max(30),
  sessionDays: z.number().int().min(1).max(90),
});
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;
/** Roles the spec says must use two-factor. Off for the demo data until the Founder turns it on. */
export const TWO_FACTOR_ROLES = ["founder", "admin", "finance"];

// ------------------------------------------------------------------------------------------------ DPDP

export const PRIVACY_NOTICE_VERSION = "2026-10";

export const CONSENT_PURPOSES = ["service", "marketing", "whatsapp", "analytics"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export const consentPurposeLabels: Record<ConsentPurpose, string> = {
  service: "Reply to the enquiry and deliver the work",
  marketing: "Marketing emails and offers",
  whatsapp: "Updates on WhatsApp",
  analytics: "Website analytics",
};

/** The privacy notice: what we keep, why, and for how long. Shown on /privacy and linked from every form. */
export const PRIVACY_NOTICE: { data: string; purpose: string; kept: string }[] = [
  { data: "Name, phone, email and company from enquiries", purpose: "Reply to you, send a proposal and deliver the work you buy", kept: "Lost leads: 24 months, then anonymised" },
  { data: "Briefs, files and messages you send", purpose: "Deliver and improve the work, keep a record of approvals", kept: "While you are a client, then 3 years" },
  { data: "Invoices and payments", purpose: "Billing and tax law (GST)", kept: "8 years, as the law requires" },
  { data: "Sign-in codes and device sessions", purpose: "Keep your account secure", kept: "Codes: 30 days; sessions: until you sign out" },
  { data: "Website and app usage", purpose: "Fix problems and measure what works (only with your consent)", kept: "14 months" },
];

export const DATA_REQUEST_KINDS = ["export", "correction", "deletion"] as const;
export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number];
export const dataRequestKindLabels: Record<DataRequestKind, string> = { export: "Copy of my data", correction: "Correct my data", deletion: "Delete my data" };
export const DATA_REQUEST_DAYS = 30;

export const dataRequestCreateSchema = z.object({
  kind: z.enum(DATA_REQUEST_KINDS),
  requesterName: z.string().trim().min(2).max(120),
  requesterEmail: z.string().trim().email("Enter a valid email"),
  details: z.string().trim().max(2000).optional(),
});
export const dataRequestUpdateSchema = z.object({
  status: z.enum(["open", "in_progress", "done", "rejected"]).optional(),
  assigneeId: z.string().nullable().optional(),
  resolution: z.string().trim().max(2000).optional(),
  subjectType: z.enum(["lead", "client", "user"]).optional(),
  subjectId: z.string().nullable().optional(),
});
export type DataRequestView = {
  id: string;
  kind: DataRequestKind;
  requesterName: string;
  requesterEmail: string;
  details: string | null;
  status: "open" | "in_progress" | "done" | "rejected";
  subjectType: string;
  subjectId: string | null;
  matches: { type: "lead" | "client" | "user"; id: string; name: string }[];
  dueAt: string;
  overdue: boolean;
  assignee: { id: string; name: string } | null;
  resolution: string | null;
  completedAt: string | null;
  createdAt: string;
};

export const RETENTION_TYPES = [
  { recordType: "lost_lead", label: "Lost leads (contact details)", defaultDays: 730, actions: ["anonymise", "delete"] },
  { recordType: "otp_code", label: "Sign-in codes", defaultDays: 30, actions: ["delete"] },
  { recordType: "notification", label: "Read notifications", defaultDays: 180, actions: ["delete"] },
  { recordType: "email_outbox", label: "Sent email copies", defaultDays: 365, actions: ["delete"] },
  { recordType: "webhook_delivery", label: "Webhook delivery log", defaultDays: 90, actions: ["delete"] },
  { recordType: "form_submission", label: "Form submissions", defaultDays: 730, actions: ["anonymise", "delete"] },
  { recordType: "audit_ip", label: "IP addresses in the audit log", defaultDays: 365, actions: ["anonymise"] },
  { recordType: "revoked_session", label: "Signed-out device sessions", defaultDays: 90, actions: ["delete"] },
] as const;
export type RetentionType = (typeof RETENTION_TYPES)[number]["recordType"];
export type RetentionRuleView = { recordType: RetentionType; label: string; keepDays: number; action: "anonymise" | "delete"; enabled: boolean; lastRunAt: string | null; lastCount: number | null; actions: readonly string[] };
export const retentionSaveSchema = z.object({
  rules: z.array(z.object({ recordType: z.string(), keepDays: z.number().int().min(1).max(3650), action: z.enum(["anonymise", "delete"]), enabled: z.boolean() })).max(20),
});

export type ConsentView = { id: string; subjectType: string; subjectId: string; email: string | null; phone: string | null; purpose: ConsentPurpose; granted: boolean; source: string; noticeVersion: string; createdAt: string; withdrawnAt: string | null };

export type AuditChainView = { ok: boolean; checked: number; fromSeq: number | null; lastSeq: number | null; brokenAt: { seq: number; id: string; reason: string } | null; unchained: number };

export type DpdpOverview = {
  requests: DataRequestView[];
  retention: RetentionRuleView[];
  consents: { total: number; marketing: number; withdrawn: number; recent: ConsentView[] };
  noticeVersion: string;
  breachRunbook: { step: string; detail: string }[];
};

/** DPDP Act 2023 / DPDP Rules: what to do in the first hours after a personal-data breach. */
export const BREACH_RUNBOOK: { step: string; detail: string }[] = [
  { step: "Contain", detail: "Revoke exposed keys and sessions (Security → Sign out everyone), rotate INTEGRATIONS_KEY/JWT_SECRET if leaked, block the hole." },
  { step: "Assess", detail: "Use the Audit Log (verify the chain) and System Health to find what data, whose, and since when." },
  { step: "Tell the Data Protection Board", detail: "Report the breach to the Data Protection Board of India without delay, with a detailed report within 72 hours." },
  { step: "Tell the people affected", detail: "Plain-language notice to each affected person: what happened, what data, the risk, what we did and what they can do." },
  { step: "Record and learn", detail: "Write up the timeline and fixes; keep it with the audit export for at least a year." },
];
