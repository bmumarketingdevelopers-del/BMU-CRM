// v11 clients: adding clients by hand (no lead), migrated clients, edit with field-level rights, client users,
// brands/locations, CM reassignment, add service / change tier quotes, pause, offboarding, health override, and the
// request actions (raise on behalf, reassign, add-on quote limit, convert to tasks, internal approval).
import { z } from "zod";
import { TIERS, type Tier } from "./catalogue.js";
import { REQUEST_TYPES } from "./requests.js";
import { SERVICE_GSTIN_RE } from "./service-flows.js";
import { CLIENT_TEAM_ROLES, type ClientTeamRole } from "./workspace-types.js";

const hasAny = (roles: string[], allowed: readonly string[]) => roles.some((r) => allowed.includes(r));

// ------------------------------------------------------------------ Who may do what

/** add_client: Founder, Branch Manager, Sales Manager, CM Lead. */
/** v33: Client Managers add (and migrate) clients too; the client is theirs. */
export const CLIENTS_ADD_ROLES = ["founder", "admin", "sales_manager", "am_lead", "account_manager"] as const;
/** v33: a Client Manager without a leadership role: the clients they add are always their own. */
export const clientsAddsOwnOnly = (me: Who) => staff(me) && me.roles.includes("account_manager") && !hasAny(me.roles, ["founder", "admin", "sales_manager", "am_lead"]);
/** assign_reassign_am: CM Lead, Branch Manager, Founder. */
export const CLIENTS_AM_ROLES = ["founder", "admin", "am_lead"] as const;
/** cancel / offboard client: Admin, CM Lead (Admin approves). */
export const CLIENTS_OFFBOARD_ROLES = ["founder", "admin", "am_lead"] as const;
/** add_engagement: CM (propose), Sales Manager, Admin. */
export const CLIENTS_ENGAGEMENT_ROLES = ["founder", "admin", "am_lead", "sales_manager", "account_manager"] as const;
/** People whose list of clients shows everyone. */
export const CLIENTS_SEE_ALL_ROLES = ["founder", "admin", "am_lead", "finance", "department_head", "sales_manager"] as const;

type Who = { type?: string; roles: string[] };
const staff = (me: Who) => me.type !== "client" && me.type !== "creator";
export const clientsCanAdd = (me: Who) => staff(me) && hasAny(me.roles, CLIENTS_ADD_ROLES);
export const clientsCanReassignAm = (me: Who) => staff(me) && hasAny(me.roles, CLIENTS_AM_ROLES);
export const clientsCanOffboard = (me: Who) => staff(me) && hasAny(me.roles, CLIENTS_OFFBOARD_ROLES);
export const clientsCanAddEngagement = (me: Who) => staff(me) && hasAny(me.roles, CLIENTS_ENGAGEMENT_ROLES);
export const clientsCanImport = (me: Who) => staff(me) && hasAny(me.roles, ["founder", "admin", "am_lead"]);
/** raise_request on behalf of a client: the CM (own clients) and leadership. */
export const clientsCanRaiseRequest = (me: Who) => staff(me) && hasAny(me.roles, ["founder", "admin", "am_lead", "account_manager"]);
/** Request internal approval: any staff. */
export const clientsCanAskApproval = (me: Who) => staff(me);

// ------------------------------------------------------------------ Field rules

export const CLIENTS_INDUSTRIES = ["Restaurants & cafes", "Retail", "Real estate", "Healthcare", "Education", "Fitness & wellness", "Beauty & salons", "Hospitality", "Manufacturing", "Technology", "Finance", "Fashion", "Food brands", "Other"] as const;

/** 10-digit Indian mobile (optionally +91), or any number with 8-15 digits. */
const phone = z
  .string()
  .trim()
  .refine((v) => /^(\+?91)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, "")) || /^\+?\d{8,15}$/.test(v.replace(/[\s-]/g, "")), { message: "Enter a valid phone number" });
const gstin = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => v === "" || SERVICE_GSTIN_RE.test(v), { message: "GSTIN should look like 29ABCDE1234F1Z5 (15 characters)" });
const month = z.string().regex(/^\d{4}-\d{2}$/, "Pick a month");
export const CLIENTS_GATES = ["G1", "G2", "G3", "G4", "G5"] as const;
export type ClientsGate = (typeof CLIENTS_GATES)[number];
export const clientsGateLabels: Record<ClientsGate, string> = {
  G1: "G1 · Requirements (onboarding)",
  G2: "G2 · Plan approval",
  G3: "G3 · Production (tasks assigned)",
  G4: "G4 · Deliverables in review",
  G5: "G5 · Sign-off and final payment",
};

export const clientsInviteSchema = z
  .object({
    name: z.string().trim().min(2, "Enter their name").max(120),
    email: z.string().trim().toLowerCase().max(200).optional().or(z.literal("")),
    phone: z.string().trim().max(20).optional().or(z.literal("")),
    role: z.enum(CLIENT_TEAM_ROLES),
    brandScope: z.array(z.string()).max(50).default([]),
  })
  .refine((v) => !!(v.email || v.phone), { message: "Enter an email or a phone number", path: ["email"] })
  .refine((v) => !v.email || z.email().safeParse(v.email).success, { message: "Enter a valid email", path: ["email"] });
export type ClientsInvite = z.input<typeof clientsInviteSchema>;

export const clientsBrandSchema = z.object({ name: z.string().trim().min(2, "Name the brand or location").max(120), address: z.string().trim().min(3, "Enter the address").max(500) });
export type ClientsBrandInput = z.infer<typeof clientsBrandSchema>;

export const clientsEngagementLineSchema = z.object({
  serviceId: z.string().min(1, "Pick a service"),
  tier: z.enum(TIERS),
  startMonth: month.optional(),
  /** Migration only: the gate this engagement is at today, and why. */
  currentGate: z.enum(CLIENTS_GATES).optional(),
  gateReason: z.string().trim().max(500).optional(),
});
export type ClientsEngagementLine = z.input<typeof clientsEngagementLineSchema>;

export const clientsPastInvoiceSchema = z.object({
  number: z.string().trim().min(1, "Invoice number").max(60),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date like 2026-04-30"),
  amountPaise: z.number().int().positive("Amount must be more than zero"),
  status: z.enum(["paid", "issued"]).default("paid"),
  description: z.string().trim().max(200).optional(),
});
export type ClientsPastInvoice = z.input<typeof clientsPastInvoiceSchema>;

/** online = the first invoice is paid in the client app; offline = paid by bank/cash/cheque, Finance confirms; none = migrated client (already billed). */
export const CLIENTS_PAYMENT_MODES = ["online", "offline", "none"] as const;
export type ClientsPaymentMode = (typeof CLIENTS_PAYMENT_MODES)[number];

export const clientsCreateSchema = z
  .object({
    businessName: z.string().trim().min(2, "Enter the business name").max(160),
    contactName: z.string().trim().min(2, "Enter the contact's name").max(120),
    contactPhone: phone,
    contactEmail: z.email("Enter a valid email").transform((v) => v.trim().toLowerCase()),
    industry: z.string().trim().min(2, "Pick the industry").max(80),
    billingName: z.string().trim().min(2, "Enter the billing name").max(160),
    gstin: gstin.optional().default(""),
    billingAddress: z.string().trim().min(5, "Enter the billing address").max(500),
    branchId: z.string().min(1, "Pick the branch"),
    billingEmail: z.email().optional().or(z.literal("")),
    brands: z.array(clientsBrandSchema).max(30).default([]),
    engagements: z.array(clientsEngagementLineSchema).max(20).default([]),
    amUserId: z.string().optional().nullable(),
    handoverNote: z.string().trim().max(2000).optional(),
    inviteNow: z.boolean().default(false),
    invites: z.array(clientsInviteSchema).max(20).default([]),
    startMode: z.enum(["onboarding", "migration"]).default("onboarding"),
    migrationReason: z.string().trim().max(500).optional(),
    pastInvoices: z.array(clientsPastInvoiceSchema).max(100).default([]),
    payment: z.enum(CLIENTS_PAYMENT_MODES).default("online"),
    paymentReference: z.string().trim().max(200).optional(),
    paymentAmountPaise: z.number().int().positive().optional(),
    /** Merge: add these details to an existing client instead of creating a new one. */
    mergeIntoId: z.string().optional().nullable(),
    /** Continue even though possible duplicates were found. */
    confirmDuplicate: z.boolean().default(false),
  })
  .refine((v) => v.startMode === "onboarding" || (v.migrationReason ?? "").length >= 3, { message: "Say why this client is being migrated (e.g. existing client from the old system)", path: ["migrationReason"] })
  .refine((v) => v.startMode === "onboarding" || v.engagements.every((e) => !!e.currentGate && (e.gateReason ?? "").trim().length >= 3), { message: "For a migrated client, set each service's current gate with a reason", path: ["engagements"] })
  .refine((v) => v.payment !== "none" || v.startMode === "migration" || v.engagements.length === 0, { message: "A new client with services needs a payment: online in the app, or offline (Finance confirms)", path: ["payment"] })
  .refine((v) => v.payment !== "offline" || (v.paymentReference ?? "").length >= 3, { message: "Add the payment reference (UTR, cheque number…) so Finance can check it", path: ["paymentReference"] })
  .refine((v) => !v.inviteNow || v.invites.length > 0, { message: "Add at least one person to invite, or choose Invite later", path: ["invites"] });
export type ClientsCreate = z.input<typeof clientsCreateSchema>;

export const clientsDuplicateQuerySchema = z.object({ businessName: z.string().trim().max(160).optional(), phone: z.string().trim().max(20).optional(), email: z.string().trim().max(200).optional(), gstin: z.string().trim().max(20).optional() });
export type ClientsDuplicateQuery = z.infer<typeof clientsDuplicateQuerySchema>;
export type ClientsDuplicate = { id: string; name: string; why: string[]; am: string | null; archived: boolean };

/** edit_client: every field optional; the server keeps only the ones the person may change. */
export const clientsEditSchema = z.object({
  businessName: z.string().trim().min(2).max(160).optional(),
  industry: z.string().trim().min(2).max(80).optional(),
  branchId: z.string().optional().nullable(),
  contactName: z.string().trim().min(2).max(120).optional(),
  contactPhone: phone.optional(),
  contactEmail: z.email("Enter a valid email").optional(),
  billingName: z.string().trim().min(2).max(160).optional(),
  gstin: gstin.optional(),
  billingAddress: z.string().trim().min(5).max(500).optional(),
  billingEmail: z.email().optional().or(z.literal("")),
  placeOfSupply: z.string().regex(/^\d{2}$/, "Two-digit state code").optional().or(z.literal("")),
});
export type ClientsEdit = z.infer<typeof clientsEditSchema>;
export const CLIENTS_CONTACT_FIELDS = ["contactName", "contactPhone", "contactEmail"] as const;
export const CLIENTS_BILLING_FIELDS = ["billingName", "gstin", "billingAddress", "billingEmail", "placeOfSupply"] as const;
export const CLIENTS_PROFILE_FIELDS = ["businessName", "industry", "branchId"] as const;
export const clientsFieldLabels: Record<keyof ClientsEdit, string> = {
  businessName: "Business name",
  industry: "Industry",
  branchId: "Branch",
  contactName: "Contact name",
  contactPhone: "Contact phone",
  contactEmail: "Contact email",
  billingName: "Billing name",
  gstin: "GSTIN",
  billingAddress: "Billing address",
  billingEmail: "Billing email",
  placeOfSupply: "Place of supply",
};

export const CLIENTS_HEALTH = ["green", "amber", "red"] as const;
export const clientsHealthSchema = z.object({ status: z.enum(CLIENTS_HEALTH), reason: z.string().trim().min(3, "Say why you are changing the health").max(500) });

export const clientsQuoteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add_service"), serviceId: z.string().min(1, "Pick a service"), tier: z.enum(TIERS), startMonth: month, note: z.string().trim().max(1000).optional() }),
  z.object({ kind: z.literal("change_tier"), engagementId: z.string().min(1, "Pick the service"), tier: z.enum(TIERS), effective: z.enum(["next_cycle", "now_prorata"]).default("next_cycle"), note: z.string().trim().max(1000).optional() }),
]);
export type ClientsQuoteInput = z.input<typeof clientsQuoteSchema>;
export const CLIENTS_QUOTE_STATUSES = ["requested", "sent", "approved", "applied", "declined", "cancelled"] as const;
export type ClientsQuoteStatus = (typeof CLIENTS_QUOTE_STATUSES)[number];
export const clientsQuoteStatusLabels: Record<ClientsQuoteStatus, { team: string; client: string }> = {
  requested: { team: "Client asked, send the quote", client: "Asked, waiting for BMU's quote" },
  sent: { team: "Waiting for the client", client: "Quote ready for you" },
  approved: { team: "Approved, waiting for payment", client: "Approved, payment due" },
  applied: { team: "Done", client: "Done" },
  declined: { team: "Declined", client: "Declined" },
  cancelled: { team: "Cancelled", client: "Cancelled" },
};
export type ClientsQuote = {
  id: string;
  kind: "add_service" | "change_tier";
  serviceName: string;
  tier: Tier;
  fromTier: Tier | null;
  startMonth: string | null;
  effective: "next_cycle" | "now_prorata";
  amountPaise: number;
  gstPaise: number;
  monthlyDiffPaise: number | null;
  status: ClientsQuoteStatus;
  note: string | null;
  requestedBy: string;
  requestedByClient: boolean;
  invoice: { id: string; number: string; status: string; totalPaise: number } | null;
  engagementId: string | null;
  createdAt: string;
};

export const clientsPauseSchema = z.object({ reason: z.string().trim().min(3, "Say why the service is paused").max(500), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the date the pause ends") });
export const clientsSetGateSchema = z.object({ gate: z.enum(CLIENTS_GATES), reason: z.string().trim().min(3, "Say why the service is at this gate").max(500) });

export const CLIENTS_OFFBOARD_CHECKS = [
  { key: "dues_cleared", label: "Dues cleared (no unpaid invoices)" },
  { key: "final_files", label: "Final files handed over" },
  { key: "access_removed", label: "Our access to their accounts removed" },
  { key: "permissions", label: "Client logins and permissions reviewed" },
  { key: "final_report", label: "Final report shared" },
  { key: "pending_work", label: "Pending work closed or handed over" },
  { key: "contract_closed", label: "Contract closed" },
] as const;
export type ClientsOffboardCheck = (typeof CLIENTS_OFFBOARD_CHECKS)[number]["key"];
export const clientsOffboardSchema = z.object({ reason: z.string().trim().min(3, "Say why the client is leaving").max(500), lastCycle: month });
export const clientsOffboardTickSchema = z.object({ key: z.enum(CLIENTS_OFFBOARD_CHECKS.map((c) => c.key) as [ClientsOffboardCheck, ...ClientsOffboardCheck[]]), done: z.boolean() });
/** requested (waiting for Admin) → in_progress (checklist) → awaiting_client (client confirms receipt) → closed. */
export type ClientsOffboardStatus = "requested" | "in_progress" | "awaiting_client" | "closed";
export const clientsOffboardStatusLabels: Record<ClientsOffboardStatus, string> = {
  requested: "Waiting for Branch Manager approval",
  in_progress: "Offboarding: checklist in progress",
  awaiting_client: "Waiting for the client to confirm receipt",
  closed: "Offboarded",
};
export type ClientsOffboarding = {
  status: ClientsOffboardStatus;
  reason: string;
  lastCycle: string;
  checklist: Record<ClientsOffboardCheck, { done: boolean; by: string | null; at: string | null }>;
  requestedBy: string | null;
  requestedAt: string;
  approvedAt: string | null;
  completedAt: string | null;
  clientConfirmedAt: string | null;
  readOnlyUntil: string | null;
};
/** Client users stay read-only this long after offboarding, then the account is archived. */
export const CLIENTS_READ_ONLY_DAYS = 90;

export const CLIENTS_BULK_ACTIONS = ["tag", "archive", "restore"] as const;
export const clientsBulkSchema = z.object({ ids: z.array(z.string()).min(1, "Pick at least one client").max(500), action: z.enum(CLIENTS_BULK_ACTIONS), tag: z.string().trim().max(40).optional(), reason: z.string().trim().max(500).optional() });
export type ClientsBulk = z.input<typeof clientsBulkSchema>;

// ------------------------------------------------------------------ Requests

/** Above this, a CM's custom-priced add-on quote goes to a Branch Manager first (quote_addon). */
export const CLIENTS_ADDON_CUSTOM_LIMIT_PAISE = 2_500_000;

export const clientsRaiseRequestSchema = z.object({
  engagementId: z.string().min(1, "Pick the client's service"),
  type: z.enum(REQUEST_TYPES),
  description: z.string().trim().min(5, "Describe the request").max(4000),
  neededBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick when it is needed").optional().or(z.literal("")),
  attachmentIds: z.array(z.string()).max(10).default([]),
  links: z.array(z.string().trim().max(500)).max(10).default([]),
});
export type ClientsRaiseRequest = z.input<typeof clientsRaiseRequestSchema>;

export const clientsCustomQuoteSchema = z.object({ amountPaise: z.number().int().positive("Enter the price"), timeline: z.string().trim().min(2, "Give a timeline").max(200), message: z.string().trim().max(4000).optional(), item: z.string().trim().min(2, "Describe the item").max(200) });
export type ClientsCustomQuote = z.infer<typeof clientsCustomQuoteSchema>;

export const clientsConvertSchema = z.object({
  lines: z
    .array(z.object({ title: z.string().trim().min(3, "Each task needs a title").max(200), departmentId: z.string().min(1, "Pick a department"), ownerId: z.string().min(1, "Pick who does it"), deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a deadline") }))
    .min(1, "Add at least one task")
    .max(30),
});
export type ClientsConvert = z.infer<typeof clientsConvertSchema>;
export type ClientsConvertPreview = {
  request: { id: string; description: string; status: string; client: string; engagementId: string };
  template: { id: string; name: string } | null;
  lines: { title: string; departmentId: string | null; ownerId: string | null; deadline: string }[];
  departments: { id: string; name: string }[];
  people: { id: string; name: string; departmentId: string | null; role: string }[];
  blocked: string | null;
};

export const clientsInternalApprovalSchema = z.object({
  what: z.string().trim().min(5, "Say what needs approving").max(1000),
  approverId: z.string().min(1, "Pick who should approve"),
  byWhen: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
  targetType: z.enum(["client", "request", "engagement", "none"]).default("none"),
  targetId: z.string().optional().nullable(),
});
export type ClientsInternalApproval = z.input<typeof clientsInternalApprovalSchema>;

// ------------------------------------------------------------------ Lead conversion

export const clientsFromLeadSchema = z.object({
  engagements: z.array(clientsEngagementLineSchema.pick({ serviceId: true, tier: true, startMonth: true })).max(20).default([]),
  paymentReference: z.string().trim().min(3, "Add the payment proof reference (UTR, cheque number…)").max(200),
  paymentAmountPaise: z.number().int().positive().optional(),
  branchId: z.string().optional(),
  industry: z.string().trim().max(80).optional(),
  billingName: z.string().trim().max(160).optional(),
  billingAddress: z.string().trim().max(500).optional(),
  gstin: gstin.optional(),
  amUserId: z.string().optional().nullable(),
});
export type ClientsFromLead = z.input<typeof clientsFromLeadSchema>;

// ------------------------------------------------------------------ Views

export type ClientsFormOptions = {
  branches: { id: string; name: string; city: string }[];
  industries: string[];
  services: { id: string; key: string; name: string; billingType: string; tiers: { tier: Tier; pricePaise: number; isFromPrice: boolean }[] }[];
  ams: ClientsAmSuggestion[];
  roles: { key: ClientTeamRole; label: string }[];
  canMigrate: boolean;
  /** v33: a Client Manager adding a client: it is always their own. */
  ownOnly?: boolean;
};
export type ClientsAmSuggestion = { id: string; name: string; role: string; clients: number; activeEngagements: number; industryMatch: number; loadPct: number; suggested: boolean; onLeaveToday: boolean };

export type ClientsListRow = {
  id: string;
  name: string;
  industry: string | null;
  health: string;
  am: { id: string; name: string } | null;
  branch: string | null;
  contact: { name: string | null; phone: string | null; email: string | null };
  source: string;
  startMode: string;
  paymentStatus: string;
  activeServices: number;
  services: { id: string; serviceName: string; status: string; currentGate: string }[];
  tags: { id: string; name: string; color: string }[];
  offboarding: ClientsOffboardStatus | null;
  archivedAt: string | null;
  createdAt: string;
};
export type ClientsListQuery = { q?: string; am?: string; health?: string; industry?: string; branch?: string; status?: string; tag?: string; archived?: string };

export type ClientsCreateResult = {
  client: { id: string; name: string };
  merged: boolean;
  engagementIds: string[];
  invoice: { id: string; number: string; totalPaise: number } | null;
  approval: { id: string; summary: string } | null;
  invited: number;
  pendingOwnerInvites: number;
  message: string;
};

export type ClientsUserRow = { id: string; name: string; email: string | null; phone: string | null; role: ClientTeamRole; status: string; brandScope: string[] };
export type ClientsPendingInvite = { approvalId: string; name: string; email: string | null; phone: string | null; role: ClientTeamRole; requestedBy: string; at: string };

export type ClientsDetail = {
  id: string;
  name: string;
  industry: string | null;
  health: string;
  healthReason: string | null;
  branch: { id: string; name: string } | null;
  am: { id: string; name: string; email: string | null } | null;
  source: string;
  startMode: string;
  paymentStatus: string;
  contact: { name: string | null; phone: string | null; email: string | null };
  billing: { billingName: string | null; gstin: string | null; billingAddress: string | null; billingEmail: string | null; placeOfSupply: string | null };
  brands: { id: string; name: string; address: string | null }[];
  users: ClientsUserRow[];
  pendingInvites: ClientsPendingInvite[];
  services: { id: string; serviceName: string; serviceId: string; tier: Tier; billingType: string; status: string; currentGate: string; migrated: boolean; paymentPending: boolean; pausedUntil: string | null; pauseReason: string | null; startMonth: string | null }[];
  quotes: ClientsQuote[];
  pendingApprovals: { id: string; action: string; summary: string; status: string; createdAt: string }[];
  offboarding: ClientsOffboarding | null;
  tags: { id: string; name: string; color: string }[];
  archivedAt: string | null;
  readOnlyAccess: boolean;
  /** Client Manager changes, newest first. */
  amHistory: { id: string; at: string; from: string | null; to: string | null; by: string; reason: string; note: string | null; handoverNote: string | null }[];
  can: {
    edit: boolean;
    editFields: (keyof ClientsEdit)[];
    reassignAm: boolean;
    inviteUser: boolean;
    addBrand: boolean;
    addService: boolean;
    changeTier: boolean;
    pause: boolean;
    setGate: boolean;
    offboard: boolean;
    health: boolean;
    archive: boolean;
    raiseRequest: boolean;
  };
};

/** The client app's own account page (Settings). */
export type ClientsAccount = {
  id: string;
  name: string;
  isOwner: boolean;
  readOnly: boolean;
  readOnlyUntil: string | null;
  am: { name: string; email: string | null; phone: string | null } | null;
  contact: { name: string | null; phone: string | null; email: string | null };
  brands: { id: string; name: string; address: string | null }[];
  services: { id: string; serviceName: string; serviceId: string; tier: Tier; billingType: string; status: string }[];
  quotes: ClientsQuote[];
  pendingInvites: ClientsPendingInvite[];
  offboarding: ClientsOffboarding | null;
  /** Services the Owner can ask for (live price book). Empty for non-Owners. */
  catalogue: ClientsFormOptions["services"];
};
export const clientsContactSchema = z.object({ contactName: z.string().trim().min(2).max(120), contactPhone: phone, contactEmail: z.email("Enter a valid email") });
export const clientsClientQuoteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add_service"), serviceId: z.string().min(1, "Pick a service"), tier: z.enum(TIERS), startMonth: month, note: z.string().trim().max(1000).optional() }),
  z.object({ kind: z.literal("change_tier"), engagementId: z.string().min(1), tier: z.enum(TIERS), effective: z.enum(["next_cycle", "now_prorata"]).default("next_cycle"), note: z.string().trim().max(1000).optional() }),
]);

// ------------------------------------------------------------------ Helpers

/** What is paid now for a new service: retainers one month in advance, projects 50%. */
export function clientsDueNowPaise(billingType: string, pricePaise: number) {
  return billingType === "monthly" ? pricePaise : Math.round(pricePaise / 2);
}

/** Pro-rata share of a monthly difference for the rest of the month (IST), at least one day. */
export function clientsProRataPaise(monthlyDiffPaise: number, now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const days = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 0)).getUTCDate();
  const left = days - ist.getUTCDate() + 1;
  return Math.round((monthlyDiffPaise * left) / days);
}

/** Normalised business name for duplicate checks ("The Aroma Cafe Pvt. Ltd." → "aroma cafe"). */
export function clientsNormName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(the|pvt|private|ltd|limited|llp|inc|co|company)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const clientsTierRank: Record<Tier, number> = { starter: 0, growth: 1, premium: 2 };
