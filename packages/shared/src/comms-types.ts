// v17 client portal 2.0 and communications: the shared inbox (WhatsApp and email linked to the right client or
// lead), reply templates, collaborative documents, booking pages and meetings with notes and action items.
// The API enforces every rule; the web only shows them.
import { z } from "zod";

// ------------------------------------------------------------------------------------------------ inbox

export const INBOX_CHANNELS = ["whatsapp", "email"] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];
export const inboxChannelLabels: Record<InboxChannel, string> = { whatsapp: "WhatsApp", email: "Email" };

export type InboxMessageView = {
  id: string;
  direction: "in" | "out";
  subject: string | null;
  body: string;
  /** received | queued | sent | simulated | failed */
  status: string;
  error: string | null;
  author: string | null;
  aiDrafted: boolean;
  at: string;
};

export type InboxRow = {
  id: string;
  channel: InboxChannel;
  address: string;
  /** Phone shown as +91 98765 43210, or the email address */
  display: string;
  name: string | null;
  client: { id: string; name: string } | null;
  lead: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  status: "open" | "closed";
  unread: number;
  lastMessageAt: string;
  last: { body: string; direction: "in" | "out" } | null;
};

export type ReplyTemplateView = { id: string; name: string; channel: "any" | InboxChannel; body: string };

export type InboxDetail = InboxRow & {
  messages: InboxMessageView[];
  threadId: string | null;
  /** Values for {{variables}} in templates. */
  variables: Record<string, string>;
  templates: ReplyTemplateView[];
  people: { id: string; name: string }[];
  can: { reply: boolean; link: boolean; assign: boolean };
};

export type InboxList = {
  items: InboxRow[];
  counts: { open: number; mine: number; unassigned: number; closed: number };
  whatsappLive: boolean;
  emailLive: boolean;
  /** Development helper: pretend a message arrived (never in production). */
  canSimulate: boolean;
};

export type InboxQuery = { status?: "open" | "closed"; box?: "mine" | "unassigned"; channel?: InboxChannel; q?: string };

export const inboxReplySchema = z.object({
  body: z.string().trim().min(1, "Write a reply").max(4000),
  subject: z.string().trim().max(200).optional(),
  aiDrafted: z.boolean().optional(),
});
export type InboxReply = z.infer<typeof inboxReplySchema>;

export const inboxUpdateSchema = z.object({
  assigneeId: z.string().nullable().optional(),
  status: z.enum(["open", "closed"]).optional(),
  clientOrgId: z.string().nullable().optional(),
  leadId: z.string().nullable().optional(),
  name: z.string().trim().max(120).optional(),
});
export type InboxUpdate = z.infer<typeof inboxUpdateSchema>;

export const inboxSimulateSchema = z.object({
  channel: z.enum(INBOX_CHANNELS),
  from: z.string().trim().min(3).max(200),
  name: z.string().trim().max(120).optional(),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(4000),
});
export type InboxSimulate = z.infer<typeof inboxSimulateSchema>;

/** Generic inbound email webhook body (any mail service that can POST JSON). */
export const inboundEmailSchema = z.object({
  from: z.string().trim().email(),
  fromName: z.string().trim().max(120).optional(),
  subject: z.string().trim().max(300).optional(),
  text: z.string().max(20000),
  messageId: z.string().trim().max(300).optional(),
});

export const replyTemplateInputSchema = z.object({
  name: z.string().trim().min(2, "Name the template").max(80),
  channel: z.enum(["any", ...INBOX_CHANNELS]).default("any"),
  body: z.string().trim().min(1).max(2000),
});
export type ReplyTemplateInput = z.infer<typeof replyTemplateInputSchema>;

/** Variables a template can use. */
export const TEMPLATE_VARIABLES = ["first_name", "name", "client", "am", "my_name", "portal_link"] as const;

/** Fills {{variable}} placeholders; unknown ones are left as they are. */
export function fillTemplateVars(body: string, vars: Record<string, string>) {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (vars[k] !== undefined && vars[k] !== "" ? vars[k] : m));
}

/** Last 10 digits of a phone number (Indian mobile numbers), or null when too short. */
export function phoneKey(phone: string | null | undefined) {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

export const formatPhone = (key: string) => (key.length === 10 ? `+91 ${key.slice(0, 5)} ${key.slice(5)}` : key);

// ------------------------------------------------------------------------------------------------ collaborative documents

export const DOC_KINDS = ["brief", "proposal", "notes"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const docKindLabels: Record<DocKind, string> = { brief: "Brief", proposal: "Proposal draft", notes: "Notes" };

export type DocRow = {
  id: string;
  title: string;
  kind: DocKind;
  client: { id: string; name: string } | null;
  engagement: { id: string; name: string } | null;
  lead: { id: string; name: string } | null;
  clientVisible: boolean;
  words: number;
  updatedBy: string | null;
  updatedAt: string;
};

export type DocDetail = DocRow & {
  /** Base64 Yjs update holding the whole document. */
  state: string;
  text: string;
  version: number;
  can: { edit: boolean; share: boolean; archive: boolean };
};

export const docCreateSchema = z.object({
  title: z.string().trim().min(2, "Give the document a title").max(160),
  kind: z.enum(DOC_KINDS).default("brief"),
  clientOrgId: z.string().nullable().optional(),
  engagementId: z.string().nullable().optional(),
  leadId: z.string().nullable().optional(),
  /** Start from this text (e.g. the AI creative brief). */
  text: z.string().max(100_000).optional(),
});
export type DocCreate = z.infer<typeof docCreateSchema>;

export const docUpdateSchema = z.object({
  title: z.string().trim().min(2).max(160).optional(),
  clientVisible: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type DocUpdate = z.infer<typeof docUpdateSchema>;

/** One editing step: a base64 Yjs update. */
export const docEditSchema = z.object({ update: z.string().min(1).max(2_000_000) });

// ------------------------------------------------------------------------------------------------ meetings

export type BookingPageView = {
  slug: string;
  title: string;
  durationMin: number;
  days: number[];
  startTime: string;
  endTime: string;
  noticeHours: number;
  active: boolean;
  url: string;
};

export const bookingPageSchema = z.object({
  title: z.string().trim().min(2).max(120),
  durationMin: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
  days: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one day").max(7),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  noticeHours: z.number().int().min(0).max(72),
  active: z.boolean(),
});
export type BookingPageInput = z.infer<typeof bookingPageSchema>;

/** Free slots by IST day. */
export type BookingSlots = { host: { name: string; title: string | null }; title: string; durationMin: number; days: { day: string; slots: string[] }[] };

export type MeetingView = {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  host: { id: string; name: string };
  client: { id: string; name: string } | null;
  lead: { id: string; name: string } | null;
  guest: { name: string | null; email: string | null; phone: string | null };
  agenda: string | null;
  location: string | null;
  status: "booked" | "cancelled" | "done";
  bookedVia: "client" | "public" | "team";
  notes: string | null;
  summary: string | null;
  actionItems: { text: string; taskId: string | null }[];
  can: { edit: boolean; cancel: boolean };
};

export type MeetingList = { upcoming: MeetingView[]; past: MeetingView[]; booking: BookingPageView | null };

export const meetingBookSchema = z.object({
  startAt: z.string().datetime({ offset: true }),
  agenda: z.string().trim().max(1000).optional(),
});
export const publicBookingSchema = meetingBookSchema.extend({
  name: z.string().trim().min(2, "Your name").max(120),
  email: z.string().trim().email("A valid email"),
  phone: z.string().trim().max(20).optional(),
  company: z.string().trim().max(120).optional(),
});
export type PublicBooking = z.infer<typeof publicBookingSchema>;

export const meetingCreateSchema = z.object({
  title: z.string().trim().min(2).max(160),
  startAt: z.string().datetime({ offset: true }),
  durationMin: z.number().int().min(15).max(240),
  clientOrgId: z.string().nullable().optional(),
  leadId: z.string().nullable().optional(),
  agenda: z.string().trim().max(1000).optional(),
  location: z.string().trim().max(300).optional(),
});
export type MeetingCreate = z.infer<typeof meetingCreateSchema>;

export const meetingNotesSchema = z.object({
  notes: z.string().max(50_000).optional(),
  summary: z.string().max(5000).nullable().optional(),
  actionItems: z.array(z.object({ text: z.string().trim().min(1).max(300), taskId: z.string().nullable().optional() })).max(30).optional(),
  status: z.enum(["booked", "done"]).optional(),
});
export type MeetingNotesInput = z.infer<typeof meetingNotesSchema>;

export const meetingTasksSchema = z.object({ items: z.array(z.number().int().min(0)).min(1).max(30), engagementId: z.string().nullable().optional() });

/** Pulls action items from notes without AI: bullet lines, "Action:", "TODO" or "X will …". */
export function basicActionItems(notes: string): string[] {
  const out: string[] = [];
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:[-*•]\s*\[ \]\s*|(?:action(?: item)?|todo|next step)s?\s*[:\-]\s*)(.+)$/i.exec(line);
    if (m) out.push(m[1].trim());
    else if (/^[-*•]\s+/.test(line) && /\b(will|to|send|share|call|book|fix|update|prepare|review)\b/i.test(line)) out.push(line.replace(/^[-*•]\s+/, ""));
    else if (/^[A-Z][a-z]+ will [a-z]/.test(line)) out.push(line);
  }
  return [...new Set(out)].slice(0, 30);
}

/** A short summary without AI: the first sentences that are not action items. */
export function basicSummary(notes: string): string {
  const text = notes
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[-*•]/.test(l) && !/^(action|todo|next step)/i.test(l))
    .join(" ");
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? (text ? [text] : []);
  return sentences.slice(0, 3).join(" ").trim().slice(0, 600);
}
