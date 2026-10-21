// v11 ops: actions for leads & sales, finance, creators, files, communication and admin configuration.
// Types, constants and input schemas shared by the API, the website and the mobile app.
import { z } from "zod";
import type { LeadRow } from "./crm.js";
import { REQUEST_TYPES } from "./requests.js";
import { indianPhone } from "./schemas.js";

const hasAny = (roles: string[], list: readonly string[]) => roles.some((r) => list.includes(r));
type Who = { type?: string; roles: string[] };
const staff = (me: Who) => me.type === undefined || me.type === "staff";

// ---------------------------------------------------------------------------
// Who may do what (the API checks again)

export const OPS_LEAD_ADD_ROLES = ["founder", "admin", "sales_manager", "sales_executive", "account_manager"] as const;
export const OPS_LEAD_MANAGER_ROLES = ["founder", "admin", "sales_manager"] as const;
export const OPS_FINANCE_ROLES = ["founder", "admin", "finance"] as const;
/** "UGC coordinator": the people who manage creators today (CreatorsService) plus department heads. */
export const OPS_CREATOR_ROLES = ["founder", "admin", "am_lead", "account_manager", "department_head"] as const;
export const OPS_ANNOUNCE_ROLES = ["founder", "admin"] as const;
export const OPS_FILE_MANAGER_ROLES = ["founder", "admin", "am_lead", "account_manager", "department_head"] as const;

export const opsCanAddLead = (me: Who) => staff(me) && hasAny(me.roles, OPS_LEAD_ADD_ROLES);
/** Client managers may only add referrals (they don't own leads). */
export const opsLeadReferralOnly = (me: Who) => !hasAny(me.roles, ["founder", "admin", "sales_manager", "sales_executive"]) && me.roles.includes("account_manager");
export const opsIsSalesManager = (me: Who) => staff(me) && hasAny(me.roles, OPS_LEAD_MANAGER_ROLES);
export const opsCanFinance = (me: Who) => staff(me) && hasAny(me.roles, OPS_FINANCE_ROLES);
/** v29: Client Managers (and the CM Lead) create and sign invoices for their own clients (the CM Lead for all clients). */
export const OPS_CM_INVOICE_ROLES = ["account_manager", "am_lead"];
export const opsCanInvoiceAsCm = (me: Who) => staff(me) && hasAny(me.roles, OPS_CM_INVOICE_ROLES);
export const opsCanCreateInvoice = (me: Who) => opsCanFinance(me) || opsCanInvoiceAsCm(me);
export const opsCanManageCreators = (me: Who) => staff(me) && hasAny(me.roles, OPS_CREATOR_ROLES);
export const opsCanAnnounce = (me: Who) => staff(me) && hasAny(me.roles, OPS_ANNOUNCE_ROLES);
export const opsCanUploadFiles = (me: Who) => staff(me);

// ---------------------------------------------------------------------------
// Leads

export const OPS_LEAD_SOURCES = ["referral", "phone", "walk_in", "whatsapp", "instagram", "facebook_ads", "google_ads", "bmu_qr", "event", "website", "other"] as const;
export type OpsLeadSource = (typeof OPS_LEAD_SOURCES)[number];
export const opsLeadSourceLabels: Record<string, string> = {
  referral: "Referral",
  phone: "Phone call",
  walk_in: "Walk-in",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook_ads: "Facebook / Meta ad form",
  google_ads: "Google ad",
  bmu_qr: "BMU QR code",
  event: "Event",
  website: "Website",
  other: "Other",
  renewal: "Renewal",
};
export const OPS_LOST_REASONS = ["Budget too low", "Went with another agency", "No response after follow-ups", "Not a fit for our services", "Timing: not now", "Chose to do it in-house", "Other"] as const;
/** First reply to a new lead is due within this many working minutes. */
export const OPS_LEAD_FIRST_REPLY_MINUTES = 120;

export const opsLeadCreateSchema = z.object({
  name: z.string().trim().min(2, "Enter the contact's name").max(120),
  phone: indianPhone,
  email: z.union([z.email("Enter a valid email"), z.literal("")]).optional(),
  company: z.string().trim().min(2, "Enter the business name").max(160),
  source: z.enum(OPS_LEAD_SOURCES, { message: "Pick where the lead came from" }),
  serviceIds: z.array(z.string().min(1)).min(1, "Pick at least one service they are interested in").max(20),
  need: z.string().trim().max(2000).optional(),
  budgetRupees: z.number().int().nonnegative().max(1_00_00_000).optional(),
  /** Empty or "auto" = round-robin among the sales team. */
  ownerId: z.string().optional(),
  referredBy: z.string().trim().max(120).optional(),
  /** Set after the person saw the "possible duplicate" warning and chose Continue. */
  confirmDuplicate: z.boolean().default(false),
});
export type OpsLeadCreate = z.input<typeof opsLeadCreateSchema>;

export type OpsDuplicateMatch = { id: string; name: string; stage: string; owner: string | null; matchedOn: ("phone" | "email" | "name")[]; href: string | null };
export type OpsLeadCreated = { lead: LeadRow; message: string; firstReplyDueAt: string | null };

export const opsLeadLostSchema = z.object({ reason: z.string().trim().min(3, "Give the lost reason").max(300) });
export const opsLeadMergeSchema = z.object({ intoId: z.string().min(1, "Pick the lead to keep") });

export const OPS_CONVERT_METHODS = ["bank", "upi", "cash", "cheque"] as const;
export const opsLeadConvertSchema = z.object({
  proposalId: z.string().min(1, "Pick the proposal the client agreed to"),
  amountPaise: z.number().int().positive("Enter the amount received"),
  method: z.enum(OPS_CONVERT_METHODS, { message: "Pick how they paid" }),
  ref: z.string().trim().min(3, "Enter the bank, UPI or cheque reference").max(100),
  paidOn: z.iso.date("Pick the payment date"),
  proofFileId: z.string().min(1, "Upload the payment proof"),
  note: z.string().trim().max(500).optional(),
});
export type OpsLeadConvert = z.input<typeof opsLeadConvertSchema>;

export const opsLeadBulkSchema = z.object({
  ids: z.array(z.string()).min(1).max(200),
  action: z.enum(["stage", "lost", "archive", "tag"]),
  stage: z.enum(["new", "contacted", "discovery", "proposal_sent"]).optional(),
  reason: z.string().trim().max(300).optional(),
  tag: z.string().trim().max(40).optional(),
});
export type OpsLeadBulk = z.input<typeof opsLeadBulkSchema>;

// ---------------------------------------------------------------------------
// Finance

export const OPS_INVOICE_LINE_KINDS = ["service", "ad_spend", "creator_fee", "other_pass_through"] as const;
export type OpsInvoiceLineKind = (typeof OPS_INVOICE_LINE_KINDS)[number];
export const opsInvoiceLineKindLabels: Record<OpsInvoiceLineKind, string> = {
  service: "Service (GST applies)",
  ad_spend: "Ad spend (pass-through)",
  creator_fee: "Creator fee (pass-through)",
  other_pass_through: "Other pass-through",
};
export const opsIsPassThrough = (k: string) => k !== "service";

const paise = z.number().int("Amount must be in whole paise").positive("Enter an amount above zero").max(1_000_000_000_00, "Amount is too large");

export const opsInvoiceLineSchema = z.object({
  /** The Founder's short description, e.g. "website redesign". */
  label: z.string().trim().min(2, "Describe the line").max(200),
  kind: z.enum(OPS_INVOICE_LINE_KINDS),
  amountPaise: paise,
  /** v27: the line as printed on the invoice: a clear service name and one or two sentences (AI-written, editable). */
  title: z.string().trim().max(120).optional(),
  details: z.string().trim().max(600).optional(),
});

/** v27: ask for invoice wording before creating the invoice (the Founder reviews and edits it). */
export const opsInvoiceDescribeSchema = z.object({
  clientOrgId: z.string().optional(),
  engagementId: z.string().optional(),
  lines: z.array(z.object({ label: z.string().trim().min(2, "Describe the line").max(200), kind: z.enum(OPS_INVOICE_LINE_KINDS) })).min(1).max(30),
});
export type OpsInvoiceDescribe = z.infer<typeof opsInvoiceDescribeSchema>;
export type OpsInvoiceLineText = { title: string; details: string };
export type OpsInvoiceDescribeResult = { lines: OpsInvoiceLineText[]; basic: boolean };

/** Plain wording when AI is off: the short description as a title, and a neutral sentence. */
export function opsBasicLineText(label: string, kind: string, client?: string | null): OpsInvoiceLineText {
  const clean = label.trim().replace(/\s+/g, " ");
  const title = clean.charAt(0).toUpperCase() + clean.slice(1);
  if (opsIsPassThrough(kind)) return { title, details: `${opsInvoiceLineKindLabels[kind as OpsInvoiceLineKind]?.replace(/ \(pass-through\)/, "") ?? "Cost"} paid on ${client ? `${client}'s` : "the client's"} behalf, billed at cost without GST.` };
  return { title, details: `Professional ${clean.toLowerCase()} services delivered by BMU Marketing${client ? ` for ${client}` : ""}, as agreed.` };
}
export const opsInvoiceCreateSchema = z.object({
  clientOrgId: z.string().min(1, "Pick the client"),
  engagementId: z.string().optional(),
  dueDate: z.iso.date("Pick the due date"),
  lines: z.array(opsInvoiceLineSchema).min(1, "Add at least one line").max(30),
  notes: z.string().trim().max(1000).optional(),
  /** false = save as a draft (not sent to the client yet). */
  issue: z.boolean().default(true),
});
export type OpsInvoiceCreate = z.input<typeof opsInvoiceCreateSchema>;

/** GST is charged on service lines only; pass-through lines (ad spend, creator fees) are billed at cost. */
export function opsInvoiceTotals(lines: { kind: string; amountPaise: number }[], gstRatePct: number) {
  const servicePaise = lines.filter((l) => !opsIsPassThrough(l.kind)).reduce((s, l) => s + l.amountPaise, 0);
  const passThroughPaise = lines.filter((l) => opsIsPassThrough(l.kind)).reduce((s, l) => s + l.amountPaise, 0);
  const gstPaise = Math.round((servicePaise * gstRatePct) / 100);
  return { servicePaise, passThroughPaise, subtotalPaise: servicePaise + passThroughPaise, gstPaise, totalPaise: servicePaise + passThroughPaise + gstPaise };
}

export const opsOfflinePaymentSchema = z.object({
  amountPaise: paise,
  method: z.enum(OPS_CONVERT_METHODS, { message: "Pick how it was paid" }),
  ref: z.string().trim().min(3, "Enter the bank, UPI or cheque reference").max(100),
  at: z.iso.date("Pick the payment date"),
  proofFileId: z.string().min(1, "Upload the proof (bank slip, cheque photo or receipt)"),
  /** v18: TDS the client deducted (₹ in paise); recorded as its own line that counts towards the invoice. */
  tdsPaise: z.number().int().min(0).max(1_00_00_00_000).optional(),
});
export type OpsOfflinePayment = z.input<typeof opsOfflinePaymentSchema>;

/** Due-date moves longer than this need Branch Manager approval. */
export const OPS_DUE_EXTENSION_FREE_DAYS = 7;
export const opsDueDateSchema = z.object({
  dueDate: z.iso.date("Pick the new due date"),
  reason: z.string().trim().min(3, "Say why the due date moves").max(500),
});
export type OpsDueDate = z.input<typeof opsDueDateSchema>;

export const opsPayoutProposeSchema = z.object({
  creatorId: z.string().min(1, "Pick the creator"),
  briefId: z.string().min(1, "Pick the brief"),
  amountPaise: paise,
  note: z.string().trim().max(500).optional(),
});
export type OpsPayoutPropose = z.input<typeof opsPayoutProposeSchema>;

/** Result of an action that may need approval first. */
export type OpsMaybeApproval = { applied: boolean; approvalId: string | null; message: string; id?: string | null };

// ---------------------------------------------------------------------------
// Creators

export const opsCreatorRateSchema = z.object({ label: z.string().trim().min(2).max(80), pricePaise: paise });
export const opsCreatorCreateSchema = z.object({
  name: z.string().trim().min(2, "Enter the creator's name").max(120),
  phone: indianPhone,
  email: z.union([z.email("Enter a valid email"), z.literal("")]).optional(),
  handle: z
    .string()
    .trim()
    .min(2, "Enter their social handle")
    .max(60)
    .transform((s) => s.replace(/^@+/, "").toLowerCase()),
  niche: z.array(z.string().trim().min(2).max(40)).min(1, "Add at least one niche").max(10),
  rates: z.array(opsCreatorRateSchema).min(1, "Add at least one rate").max(10),
  city: z.string().trim().min(2, "Enter the city").max(80),
  confirmDuplicate: z.boolean().default(false),
});
export type OpsCreatorCreate = z.input<typeof opsCreatorCreateSchema>;
export const opsCreatorEditSchema = opsCreatorCreateSchema.omit({ confirmDuplicate: true }).partial();
export type OpsCreatorEdit = z.input<typeof opsCreatorEditSchema>;
export const opsCreatorRatingSchema = z.object({
  score: z.number().int().min(1, "Pick 1 to 5 stars").max(5, "Pick 1 to 5 stars"),
  note: z.string().trim().min(3, "Write a short note about the delivery").max(1000),
});
export type OpsCreatorRating = z.input<typeof opsCreatorRatingSchema>;

export type OpsCreatorRow = {
  id: string;
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  handle: string | null;
  city: string | null;
  niche: string[];
  rates: { label: string; pricePaise: number }[];
  rating: number | null;
  ratingCount: number;
  activeBriefs: number;
  approvedBriefs: number;
  pendingPayoutPaise: number;
  archivedAt: string | null;
  archivedReason: string | null;
};
export type OpsCreatorDetail = OpsCreatorRow & {
  briefs: { id: string; title: string; status: string; feePaise: number; client: string | null; rated: boolean }[];
  ratings: { id: string; score: number; note: string; brief: string; by: string; at: string }[];
};

// ---------------------------------------------------------------------------
// Files

export const OPS_FILE_FOLDERS = ["from_client", "working", "final", "brand", "general"] as const;
export type OpsFileFolder = (typeof OPS_FILE_FOLDERS)[number];
export const opsFileFolderLabels: Record<OpsFileFolder, string> = { from_client: "From client", working: "Working files", final: "Final files", brand: "Brand assets", general: "General" };

export type OpsFileRow = {
  id: string;
  name: string;
  folder: OpsFileFolder;
  kind: string;
  mimeType: string | null;
  sizeBytes: number | null;
  tags: string[];
  client: { id: string; name: string } | null;
  engagement: { id: string; name: string } | null;
  uploadedBy: string | null;
  createdAt: string;
  released: boolean;
  archivedAt: string | null;
  url: string;
  shares: number;
  can: { edit: boolean; release: boolean; share: boolean; archive: boolean };
  releaseBlockedReason: string | null;
  /** v35: sent to the client, received from the client, or kept inside the team. */
  direction?: OpsFileDirection;
  /** v35: where it was shared (chat, review, upload, brand kit, asset library, payment proof). */
  source?: OpsFileSource;
  /** v35: when it reached (or came from) the client, and who shared it. */
  sharedAt?: string | null;
  sharedBy?: string | null;
};
export type OpsFileList = { rows: OpsFileRow[]; clients: { id: string; name: string; engagements: { id: string; name: string; gate: string }[] }[] };

// v35: every client file in one place, with its direction and where it was shared.
export const OPS_FILE_DIRECTIONS = ["to_client", "from_client", "internal"] as const;
export type OpsFileDirection = (typeof OPS_FILE_DIRECTIONS)[number];
export const opsFileDirectionLabels: Record<OpsFileDirection, string> = { to_client: "Sent to client", from_client: "From client", internal: "Internal" };
export const OPS_FILE_SOURCES = ["chat", "review", "client_upload", "upload", "brand", "asset", "payment_proof"] as const;
export type OpsFileSource = (typeof OPS_FILE_SOURCES)[number];
export const opsFileSourceLabels: Record<OpsFileSource, string> = {
  chat: "Chat",
  review: "Work for review",
  client_upload: "Client upload",
  upload: "Team upload",
  brand: "Brand kit",
  asset: "Asset library",
  payment_proof: "Payment proof",
};
/** v35: files sent to and received from clients (the Founder's dashboard and daily summary). */
export type OpsClientFileFeed = {
  days: number;
  sent: number;
  received: number;
  rows: (OpsFileRow & { direction: OpsFileDirection; source: OpsFileSource; sharedAt: string })[];
};

export const opsFileUpdateSchema = z.object({
  name: z.string().trim().min(1, "Give the file a name").max(200).optional(),
  folder: z.enum(OPS_FILE_FOLDERS).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  engagementId: z.string().nullable().optional(),
});
export type OpsFileUpdate = z.input<typeof opsFileUpdateSchema>;

export const opsShareCreateSchema = z.object({
  expiresInDays: z.number().int().min(1, "Pick 1 to 90 days").max(90, "Pick 1 to 90 days"),
  password: z.union([z.string().min(4, "Use at least 4 characters").max(64), z.literal("")]).optional(),
});
export type OpsShareCreate = z.input<typeof opsShareCreateSchema>;
export type OpsShareLinkView = { id: string; url: string; token: string; expiresAt: string; hasPassword: boolean; revoked: boolean; views: number; createdBy: string; createdAt: string };
export type OpsPublicShare = { name: string; mimeType: string | null; sizeBytes: number | null; expiresAt: string; needsPassword: boolean; downloadUrl: string | null; from: string };

// ---------------------------------------------------------------------------
// Communication

export const OPS_THREAD_KINDS = ["project", "internal"] as const;
export const opsThreadCreateSchema = z.object({
  kind: z.enum(OPS_THREAD_KINDS),
  clientOrgId: z.string().min(1, "Pick the client"),
  engagementId: z.string().optional(),
  title: z.string().trim().min(3, "Give the discussion a title").max(160),
  participantIds: z.array(z.string()).max(30).default([]),
  message: z.string().trim().min(1, "Write the first message").max(4000),
});
export type OpsThreadCreate = z.input<typeof opsThreadCreateSchema>;
export type OpsThreadSummary = { id: string; kind: string; title: string; client: { id: string; name: string }; engagement: string | null; participants: string[]; lastMessage: { body: string; author: string; at: string } | null; createdAt: string };
export type OpsThreadView = OpsThreadSummary & { messages: { id: string; body: string; author: string; mine: boolean; at: string }[]; canPost: boolean };
export const opsThreadPostSchema = z.object({ body: z.string().trim().min(1, "Write a message").max(4000) });

export const OPS_REQUEST_TYPES = REQUEST_TYPES;
export const opsMessageToRequestSchema = z.object({
  messageId: z.string().min(1),
  engagementId: z.string().min(1, "Pick the service the request is for"),
  type: z.enum(OPS_REQUEST_TYPES),
  description: z.string().trim().min(5, "Describe the request").max(4000),
});
export type OpsMessageToRequest = z.input<typeof opsMessageToRequestSchema>;

export const OPS_AUDIENCES = ["all_clients", "segment", "all_team", "department"] as const;
export const opsAudienceLabels: Record<(typeof OPS_AUDIENCES)[number], string> = { all_clients: "All clients", segment: "A client segment", all_team: "All team", department: "One department" };
export const OPS_CHANNELS = ["in_app", "email"] as const;
export const opsAnnouncementSchema = z
  .object({
    title: z.string().trim().min(3, "Give it a title").max(160),
    body: z.string().trim().min(5, "Write the message").max(4000),
    audience: z.enum(OPS_AUDIENCES),
    /** segment: "service:<key>" or "health:<green|amber|red>"; department: the department id */
    segment: z.string().optional(),
    channels: z.array(z.enum(OPS_CHANNELS)).min(1, "Pick at least one channel"),
  })
  .refine((v) => !["segment", "department"].includes(v.audience) || !!v.segment, { message: "Pick the segment or department", path: ["segment"] });
export type OpsAnnouncementInput = z.input<typeof opsAnnouncementSchema>;
export type OpsAnnouncementRow = { id: string; title: string; body: string; audience: string; segment: string | null; channels: string[]; recipientCount: number; sentBy: string; createdAt: string };
export type OpsAnnouncementOptions = { departments: { id: string; name: string }[]; services: { key: string; name: string }[]; counts: Record<string, number> };

// ---------------------------------------------------------------------------
// Notes and meetings on a lead (client notes use the Manager workspace notes)

export const opsLeadNoteSchema = z.object({
  kind: z.enum(["note", "meeting"]),
  body: z.string().trim().min(2, "Write a short note").max(2000),
  at: z.iso.datetime({ offset: true }).optional(),
});

// ---------------------------------------------------------------------------
// Admin configuration

export const OPS_WHATSAPP_STATUSES = ["not_submitted", "pending", "approved", "rejected"] as const;
export type OpsWhatsappStatus = (typeof OPS_WHATSAPP_STATUSES)[number];
export const opsWhatsappStatusLabels: Record<OpsWhatsappStatus, string> = { not_submitted: "Not submitted to Meta", pending: "Waiting for Meta", approved: "Approved by Meta", rejected: "Rejected by Meta" };

export const OPS_INTEGRATION_KEYS = ["razorpay", "email", "whatsapp", "accounting", "meta_ads", "google_ads"] as const;
export const OPS_CLIENT_PLATFORMS = ["meta_ads", "google_ads", "instagram", "facebook", "youtube", "linkedin"] as const;
export const opsPlatformLabels: Record<string, string> = { meta_ads: "Meta Ads", google_ads: "Google Ads", instagram: "Instagram", facebook: "Facebook page", youtube: "YouTube", linkedin: "LinkedIn", razorpay: "Razorpay", email: "Email (SMTP)", whatsapp: "WhatsApp Business", accounting: "Accounting export" };
export type OpsIntegrationRow = { key: string; label: string; connected: boolean; configured: boolean; connectedBy: string | null; connectedAt: string | null };
export type OpsClientAccountRow = { id: string; platform: string; label: string; accountName: string; connected: boolean; consentBy: string | null; consentAt: string | null; connectedBy: string; connectedAt: string };
export const opsClientAccountSchema = z.object({
  platform: z.enum(OPS_CLIENT_PLATFORMS),
  accountName: z.string().trim().min(2, "Enter the account name or ID").max(120),
  consentBy: z.string().trim().min(2, "Who at the client agreed?").max(120),
  consentConfirmed: z.literal(true, { message: "Confirm the client agreed to connect this account" }),
});
export type OpsClientAccountInput = z.input<typeof opsClientAccountSchema>;
