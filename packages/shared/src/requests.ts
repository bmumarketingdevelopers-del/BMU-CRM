// Request desk (communication.sla), extra requests (add-ons) and final delivery.
import { z } from "zod";

export const REQUEST_TYPES = ["change", "new_scope", "urgent", "question", "billing"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const requestTypeLabels: Record<RequestType, { client: string; team: string; hint: string }> = {
  change: { client: "Change to current work", team: "Change within scope", hint: "Small edits to something we're already making" },
  new_scope: { client: "Extra request", team: "Add-on (new scope)", hint: "Something new, outside your package. We'll send a quote." },
  urgent: { client: "Urgent", team: "Urgent request", hint: "Needs attention today" },
  question: { client: "Question", team: "Question", hint: "Ask us anything" },
  billing: { client: "Billing question", team: "Billing query", hint: "Invoices and payments" },
};

/** First-reply targets in working minutes (9:30–18:30 Mon–Sat). */
export const SLA_FIRST_REPLY_MIN: Record<RequestType, number> = {
  change: 4 * 60,
  new_scope: 9 * 60,
  urgent: 2 * 60,
  question: 9 * 60,
  billing: 9 * 60,
};

export const REQUEST_STATUSES = ["received", "scope_check", "in_scope", "quoted", "approved", "paid", "in_progress", "done", "declined", "rescheduled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const requestStatusLabels: Record<RequestStatus, { client: string; team: string }> = {
  received: { client: "Received", team: "New" },
  scope_check: { client: "Being reviewed", team: "Checking scope" },
  in_scope: { client: "Included, we're on it", team: "In scope" },
  quoted: { client: "Quote ready for you", team: "Quoted, waiting for client" },
  approved: { client: "Approved, payment due", team: "Approved, awaiting payment" },
  paid: { client: "Paid, scheduled", team: "Paid" },
  in_progress: { client: "In progress", team: "In progress" },
  done: { client: "Done", team: "Done" },
  declined: { client: "Declined", team: "Declined" },
  rescheduled: { client: "Rescheduled", team: "Rescheduled" },
};

export const createRequestSchema = z.object({
  engagementId: z.string().min(1),
  type: z.enum(REQUEST_TYPES),
  description: z.string().trim().min(5, "Tell us a little more").max(4000),
});
export type CreateRequest = z.infer<typeof createRequestSchema>;

/** CM decision on a request. "quote" = new direction → add-on that needs written client approval. */
export const decideRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reply"), message: z.string().trim().min(1).max(4000), internal: z.boolean().default(false) }),
  z.object({ action: z.literal("in_scope"), message: z.string().trim().max(4000).optional() }),
  z.object({
    action: z.literal("quote"),
    addOnId: z.string().optional(),
    customAmountPaise: z.number().int().positive().optional(),
    quantity: z.number().int().min(1).max(100).default(1),
    timeline: z.string().trim().min(2).max(200),
    message: z.string().trim().max(4000).optional(),
  }),
  z.object({ action: z.literal("accept_urgent"), message: z.string().trim().max(4000).optional() }),
  z.object({ action: z.literal("reschedule"), timeline: z.string().trim().min(2).max(200), message: z.string().trim().min(2).max(4000) }),
  z.object({ action: z.literal("done"), message: z.string().trim().max(4000).optional() }),
  z.object({ action: z.literal("decline"), message: z.string().trim().min(2).max(4000) }),
]);
export type DecideRequest = z.infer<typeof decideRequestSchema>;

export type RequestComment = { id: string; body: string; internal: boolean; author: string; isClient: boolean; at: string };

export type SlaState = {
  firstReplyDue: string | null;
  firstReplyAt: string | null;
  /** "met" | "breached" (replied late) | "due" (waiting, on time) | "overdue" (waiting, late) */
  state: "met" | "breached" | "due" | "overdue";
  /** Working minutes left (negative when overdue). */
  workingMinutesLeft: number | null;
};

export type RequestView = {
  id: string;
  type: RequestType;
  status: RequestStatus;
  description: string;
  client: { id: string; name: string };
  engagement: { id: string; serviceName: string };
  createdBy: string;
  createdAt: string;
  sla: SlaState;
  quote: { amountPaise: number; gstPaise: number; totalPaise: number; timeline: string | null; addOnName: string | null } | null;
  approval: { by: string; at: string } | null;
  invoice: { id: string; number: string; status: string; totalPaise: number } | null;
  comments: RequestComment[];
  can: { decide: boolean; quoteCustom: boolean; approveQuote: boolean; rate?: boolean; reopen?: boolean };
  /** v10: when it was closed, the client's satisfaction rating and reopen count. */
  resolvedAt?: string | null;
  rating?: { value: "up" | "down"; comment: string | null; at: string; by: string } | null;
  reopenCount?: number;
  /** Last day the client can reopen a done request (7 days after it was closed). */
  reopenUntil?: string | null;
  /** v11 clients: who handles it, when the client needs it, raised by the CM for the client. */
  assignee?: { id: string; name: string } | null;
  neededBy?: string | null;
  raisedOnBehalf?: boolean;
};

// ---------------------------------------------------------------------------
// Messaging

export type ThreadAttachment = { id: string; name: string; url: string; mimeType: string | null; sizeBytes: number | null };
export type ThreadMessage = { id: string; body: string; internal: boolean; author: string; isClient: boolean; mine: boolean; at: string; attachments?: ThreadAttachment[] };

export type ThreadView = {
  id: string;
  client: { id: string; name: string };
  am: string | null;
  messages: ThreadMessage[];
  /** Client message waiting for a reply, with the same-working-day target. */
  awaitingReply: { since: string; due: string; overdue: boolean } | null;
  /** v10: messages from the other side this person has not read yet (before this view marked them read). */
  unread?: number;
};

export type ThreadSummary = {
  id: string;
  client: { id: string; name: string };
  lastMessage: { body: string; author: string; at: string; isClient: boolean } | null;
  awaitingReply: { since: string; due: string; overdue: boolean } | null;
  unread?: number;
};

export const sendMessageSchema = z
  .object({ body: z.string().trim().max(4000).default(""), internal: z.boolean().default(false), attachmentIds: z.array(z.string()).max(5).default([]) })
  .refine((m) => m.body.length > 0 || m.attachmentIds.length > 0, { message: "Write a message or attach a file", path: ["body"] });

// ---------------------------------------------------------------------------
// Notifications

export type NotificationView = { id: string; kind: string; title: string; body: string | null; link: string | null; critical: boolean; read: boolean; at: string };

// ---------------------------------------------------------------------------
// Files and final delivery (Gate 5)

export type ClientFile = {
  id: string;
  name: string;
  kind: string;
  deliverable: string;
  serviceName: string;
  version: number;
  released: boolean;
  url: string;
  downloadUrl: string | null;
};

export type FinalDeliveryView = {
  engagementId: string;
  serviceName: string;
  status: string;
  allApproved: boolean;
  signedOffAt: string | null;
  balanceInvoice: { id: string; number: string; status: string; totalPaise: number; paidPaise: number } | null;
  filesReleased: boolean;
  can: { signOff: boolean };
};
