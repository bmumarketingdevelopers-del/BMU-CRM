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

/** v23 meeting requests: who else is in a client meeting and what they answered. */
export type MeetingParticipantRole = "founder" | "department_head" | "branch_manager" | "member";
export type MeetingParticipantStatus = "pending" | "accepted" | "reschedule" | "invited" | "joined" | "ignored";
export type MeetingParticipantView = {
  userId: string;
  name: string;
  role: MeetingParticipantRole;
  status: MeetingParticipantStatus;
  /** A new time the same day, when status is "reschedule". */
  proposedStartAt: string | null;
  note: string | null;
  /** v23 Google Meet: their reply to the Google Calendar invitation, when the meeting is in Google Calendar. */
  googleResponse: MeetingAttendeeResponse | null;
  /** v24: the department a Department Head represents (team only). */
  department: { id: string; name: string } | null;
  /** v24: a Branch Manager from another branch, added by the Client Manager or the client's Branch Manager (team only). */
  addedBy: string | null;
};

export const MEETING_PARTICIPANT_ROLE_LABELS: Record<MeetingParticipantRole, string> = {
  founder: "Founder",
  department_head: "Department Head",
  branch_manager: "Branch Manager",
  member: "Team member",
};

export type MeetingView = {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  durationMin: number;
  host: { id: string; name: string };
  client: { id: string; name: string } | null;
  lead: { id: string; name: string } | null;
  guest: { name: string | null; email: string | null; phone: string | null };
  agenda: string | null;
  location: string | null;
  /** requested: the Client Manager is arranging it · awaiting: Department Head / Founder asked to confirm · booked: fixed */
  status: "requested" | "awaiting" | "booked" | "cancelled" | "done";
  bookedVia: "client" | "public" | "team" | "founder";
  /** The client's time zone (IANA). */
  timeZone: string;
  /** The first department brought in (kept for older screens); see departments for all of them. */
  department: { id: string; name: string } | null;
  /** v24: every department brought in, each represented by its Department Head. */
  departments: { id: string; name: string }[];
  /** The meeting link: the Google Meet link Google created, or one the Client Manager pasted. */
  joinUrl: string | null;
  /**
   * v23 Google Meet: for the meeting's host only, the Google account that organised it in Google Calendar (their
   * connected calendar). Joining with that account makes them the Meet host instead of asking to join.
   */
  joinAs: string | null;
  /** Set when the fixed time differs from the time first asked for. */
  rescheduledAt: string | null;
  participants: MeetingParticipantView[];
  /** The viewer's own place in the meeting, when they were brought in. */
  myRole: MeetingParticipantRole | null;
  notes: string | null;
  summary: string | null;
  actionItems: { text: string; taskId: string | null }[];
  /** v23 Google Meet: the client's people and guests invited, with their Google Calendar reply. Clients see no emails. */
  attendees: MeetingAttendeeView[];
  /** v23 (team only): whether the meeting is in the host's Google Calendar, and why not when it should be. */
  google: { synced: boolean; error: string | null } | null;
  can: {
    edit: boolean;
    cancel: boolean;
    /** Client Manager: bring in a department and/or the Founder, or fix the time. */
    arrange: boolean;
    /** Department Head / Founder: accept or ask for a new time the same day. */
    respond: boolean;
    /** Department Head of the meeting's department: add their team members once it is fixed. */
    addMembers: boolean;
    /** Branch Manager: join or ignore the fixed meeting. */
    join: boolean;
    /** Client Manager: send the meeting link to everyone once the meeting is fixed. */
    shareLink: boolean;
    /**
     * v24: add a Branch Manager from another branch to a fixed client meeting. Only the Client Manager (or CM Lead)
     * and the Branch Manager of the client's own branch can.
     */
    addBranchManagers: boolean;
  };
};

export const MEETING_ATTENDEE_RESPONSES = ["needsAction", "accepted", "declined", "tentative"] as const;
export type MeetingAttendeeResponse = (typeof MEETING_ATTENDEE_RESPONSES)[number];
export const meetingResponseLabels: Record<MeetingAttendeeResponse, string> = { needsAction: "Invited", accepted: "Accepted", declined: "Declined", tentative: "Maybe" };
export type MeetingAttendeeView = { name: string; email: string | null; kind: "client" | "guest"; response: MeetingAttendeeResponse };

/** v23: the signed-in person's Google Calendar connection (meetings they host get a Google Meet link when connected). */
export type CalendarConnectionView = {
  /** Google sign-in is set up on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / INTEGRATIONS_KEY). */
  available: boolean;
  connected: boolean;
  email: string | null;
  status: "connected" | "error" | "disconnected" | null;
  error: string | null;
};

/** v23: team members who can be invited to a meeting. */
export type MeetingPerson = { id: string; name: string; department: string | null };

export type MeetingList = {
  /** Requests still being arranged (requested / awaiting). */
  requests: MeetingView[];
  upcoming: MeetingView[];
  past: MeetingView[];
  booking: BookingPageView | null;
};

/** What the Client Manager can bring into a meeting. */
export type MeetingArrangeOptions = {
  departments: { id: string; name: string; head: { id: string; name: string } | null }[];
  founders: { id: string; name: string }[];
};

/** v23: a client asks for a meeting at a time in their own time zone. */
export const meetingRequestSchema = z.object({
  startAt: z.string().datetime({ offset: true }),
  timeZone: z.string().trim().min(1).max(64),
  durationMin: z.number().int().min(15, "At least 15 minutes").max(180, "At most 3 hours"),
  requirements: z.string().trim().min(10, "Tell us what the meeting is about (at least 10 characters)").max(2000),
});
export type MeetingRequestInput = z.infer<typeof meetingRequestSchema>;

/** v23: the Founder asks a client's Client Manager to arrange a meeting with that client. */
export const founderMeetingSchema = z.object({
  clientOrgId: z.string().min(1, "Pick a client"),
  startAt: z.string().datetime({ offset: true }),
  durationMin: z.number().int().min(15).max(180),
  requirements: z.string().trim().min(10, "What is the meeting about? (at least 10 characters)").max(2000),
});
export type FounderMeetingInput = z.infer<typeof founderMeetingSchema>;

/** v23: the Client Manager brings in a department (its head confirms) and/or a Founder. */
export const meetingArrangeSchema = z
  .object({
    /** v24: one or more departments; each Department Head confirms. */
    departmentIds: z.array(z.string().min(1)).max(12).optional(),
    /** Older single-department form, still accepted. */
    departmentId: z.string().nullable().optional(),
    founderId: z.string().nullable().optional(),
  })
  .refine((v) => !!v.departmentIds?.length || !!v.departmentId || !!v.founderId, "Pick a department or the Founder");
export type MeetingArrangeInput = z.infer<typeof meetingArrangeSchema>;

/** v23: a Department Head or Founder accepts, or asks for another time on the same day. */
export const meetingRespondSchema = z
  .object({ decision: z.enum(["accept", "reschedule"]), proposedStartAt: z.string().datetime({ offset: true }).optional(), note: z.string().trim().max(500).optional() })
  .refine((v) => v.decision === "accept" || !!v.proposedStartAt, "Pick the new time");
export type MeetingRespondInput = z.infer<typeof meetingRespondSchema>;

/** v23: the Client Manager fixes the meeting, optionally at a new time (the client gets an apology). */
export const meetingFixSchema = z.object({ startAt: z.string().datetime({ offset: true }).optional() });

/** v23: once everyone accepted and the meeting is fixed, the Client Manager sends the link to everyone in one click. */
export const meetingLinkSchema = z.object({
  joinUrl: z
    .string()
    .trim()
    .url("Paste the full link, e.g. https://meet.google.com/abc-defg-hij")
    .max(500)
    .refine((u) => /^https:\/\//i.test(u), "The link must start with https://"),
});
export type MeetingFixInput = z.infer<typeof meetingFixSchema>;

export const meetingMembersSchema = z.object({ userIds: z.array(z.string().min(1)).min(1, "Pick at least one person").max(20) });
/** v24: Branch Managers from other branches added to a client meeting. */
export const meetingBranchManagersSchema = z.object({ userIds: z.array(z.string().min(1)).min(1, "Pick a Branch Manager").max(10) });

/** v24: someone a Department Head can add: their department, working on the client's projects. */
export type MeetingMemberOption = { id: string; name: string; department: string | null; why: string | null };
/** v24: a Branch Manager of another branch who can be added. */
export type MeetingBranchManagerOption = { id: string; name: string; branch: string | null };
export const meetingJoinSchema = z.object({ decision: z.enum(["join", "ignore"]) });

/** Every IANA time zone the runtime knows, India first. */
export function timeZoneList(): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return ["Asia/Kolkata", ...all.filter((z) => z !== "Asia/Kolkata" && z !== "Asia/Calcutta")];
}

/** Offset of a time zone from UTC at an instant, in minutes (e.g. +330 for India). */
export function zoneOffsetMin(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** A wall-clock date and time ("2026-10-20", "15:30") in a time zone, as a UTC ISO string. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  let utc = guess.getTime() - zoneOffsetMin(timeZone, guess) * 60_000;
  // Second pass settles the hour around daylight-saving changes.
  utc = guess.getTime() - zoneOffsetMin(timeZone, new Date(utc)) * 60_000;
  return new Date(utc).toISOString();
}

/** "Mon, 20 Oct, 3:30 pm" in a time zone. */
export function zonedLabel(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("en-IN", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}

/** The calendar day (YYYY-MM-DD) of an instant in a time zone. */
export function zonedDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

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
  /** v23: team members to invite (the client's people are invited when a client is picked). */
  attendeeIds: z.array(z.string().min(1)).max(30).optional(),
  /** v23: create a Google Meet link in the host's Google Calendar (needs a connected calendar). */
  addMeet: z.boolean().optional(),
  /**
   * v24: Department Heads (by department) and a Founder asked to confirm first. The meeting is then waiting for their
   * answers and is fixed once they all accept, as for a client's request.
   */
  departmentIds: z.array(z.string().min(1)).max(12).optional(),
  founderId: z.string().nullable().optional(),
});
export type MeetingCreate = z.input<typeof meetingCreateSchema>;

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
