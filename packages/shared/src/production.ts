// Production (build phase): flow templates, tasks, versions, QC and the Review Studio.
import { z } from "zod";
import type { ProofRoundView } from "./creative-types.js";
import type { DeliverApprovalStatus, DeliverSlaItem } from "./deliver-flows.js";

// ---------------------------------------------------------------------------
// Flow templates: department flows that turn an approved plan into tasks.

export const flowStepSchema = z.object({
  key: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(80),
  /** Role that owns the step (team role id). "am" means the engagement's Client Manager. */
  role: z.string().trim().min(2),
  days: z.number().int().min(0).max(30),
  kind: z.enum(["work", "qc", "client_review"]).default("work"),
});
export type FlowStep = z.infer<typeof flowStepSchema>;

export const flowTemplateInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  department: z.string().trim().min(2),
  deliverableTypes: z.array(z.string().trim().min(1)).default([]),
  steps: z
    .array(flowStepSchema)
    .min(1)
    .refine((s) => s.some((x) => x.kind === "qc"), { message: "Every flow needs a QC checkpoint before the client sees anything" })
    .refine((s) => new Set(s.map((x) => x.key)).size === s.length, { message: "Step keys must be unique" }),
});
export type FlowTemplateInput = z.infer<typeof flowTemplateInputSchema>;

export type FlowTemplateView = FlowTemplateInput & { id: string; key: string; version: number; departmentId: string };

/** Default flows seeded per department. Durations are working days. */
export const DEFAULT_FLOWS: (FlowTemplateInput & { key: string })[] = [
  {
    key: "design",
    name: "Design asset",
    department: "Creative / Design",
    deliverableTypes: ["post", "carousel", "story", "ad"],
    steps: [
      { key: "brief", name: "Brief and references", role: "strategist", days: 1, kind: "work" },
      { key: "design", name: "Design", role: "producer", days: 2, kind: "work" },
      { key: "qc", name: "Internal QC", role: "qc_reviewer", days: 1, kind: "qc" },
      { key: "client", name: "Client review", role: "am", days: 2, kind: "client_review" },
    ],
  },
  {
    key: "video",
    name: "Video / reel",
    department: "Video / Production",
    deliverableTypes: ["reel", "video"],
    steps: [
      { key: "script", name: "Script and shot list", role: "strategist", days: 1, kind: "work" },
      { key: "shoot", name: "Shoot or source footage", role: "producer", days: 1, kind: "work" },
      { key: "edit", name: "Edit", role: "producer", days: 2, kind: "work" },
      { key: "qc", name: "Internal QC", role: "qc_reviewer", days: 1, kind: "qc" },
      { key: "client", name: "Client review", role: "am", days: 2, kind: "client_review" },
    ],
  },
  {
    key: "writing",
    name: "Written content",
    department: "SEO",
    deliverableTypes: ["blog"],
    steps: [
      { key: "outline", name: "Keyword research and outline", role: "strategist", days: 1, kind: "work" },
      { key: "write", name: "Write", role: "producer", days: 2, kind: "work" },
      { key: "qc", name: "Internal QC", role: "qc_reviewer", days: 1, kind: "qc" },
      { key: "client", name: "Client review", role: "am", days: 2, kind: "client_review" },
    ],
  },
  {
    key: "web",
    name: "Web page",
    department: "Web / AI",
    deliverableTypes: ["page"],
    steps: [
      { key: "wireframe", name: "Wireframe", role: "producer", days: 1, kind: "work" },
      { key: "build", name: "Build", role: "producer", days: 3, kind: "work" },
      { key: "qc", name: "Internal QC", role: "qc_reviewer", days: 1, kind: "qc" },
      { key: "client", name: "Client review on live URL", role: "am", days: 2, kind: "client_review" },
    ],
  },
  {
    key: "general",
    name: "General deliverable",
    department: "Creative / Design",
    deliverableTypes: ["other"],
    steps: [
      { key: "make", name: "Produce", role: "producer", days: 2, kind: "work" },
      { key: "qc", name: "Internal QC", role: "qc_reviewer", days: 1, kind: "qc" },
      { key: "client", name: "Client review", role: "am", days: 2, kind: "client_review" },
    ],
  },
];

/** Picks the flow for a deliverable type, falling back to the general flow. */
export function flowForType<T extends { deliverableTypes: string[]; key: string }>(flows: T[], type: string): T | undefined {
  return flows.find((f) => f.deliverableTypes.includes(type)) ?? flows.find((f) => f.key === "general") ?? flows[0];
}

// ---------------------------------------------------------------------------
// QC checklists (department QC, hidden from clients).

export const DEFAULT_QC_CHECKLISTS: { key: string; name: string; items: string[] }[] = [
  {
    key: "design",
    name: "Design QC",
    items: ["Brand colours, fonts and logo are correct", "Spelling and grammar checked", "Matches the approved plan and brief", "Correct size and format for the platform", "Text is readable on mobile"],
  },
  {
    key: "video",
    name: "Video QC",
    items: ["Audio levels clean, no clipping", "Captions accurate and in sync", "Brand intro/outro and logo correct", "Correct aspect ratio and length", "Music is licensed for use"],
  },
  {
    key: "writing",
    name: "Content QC",
    items: ["Plagiarism check passed", "Target keywords used naturally", "Facts and figures verified", "Headings, meta title and description present", "Tone matches the brand"],
  },
  {
    key: "web",
    name: "Website QC",
    items: ["Works on mobile, tablet and desktop", "All links and forms work", "Page speed acceptable", "SEO basics (titles, alt text, sitemap)", "No placeholder text left"],
  },
  { key: "general", name: "General QC", items: ["Matches the approved plan", "Brand guidelines followed", "Spelling and grammar checked"] },
];

export const qcSubmitSchema = z
  .object({
    items: z.array(z.object({ label: z.string(), ok: z.boolean(), note: z.string().trim().optional() })).min(1),
    note: z.string().trim().optional(),
  })
  .refine((v) => v.items.every((i) => i.ok) || !!v.note || v.items.some((i) => !i.ok && i.note), {
    message: "A QC fail needs a note so the maker knows what to fix",
    path: ["note"],
  });
export type QcSubmit = z.infer<typeof qcSubmitSchema>;

// ---------------------------------------------------------------------------
// Tasks

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "waiting", "in_qc", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const taskStatusLabels: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  waiting: "Waiting",
  in_qc: "In QC",
  done: "Done",
  cancelled: "Cancelled",
};

export const updateTaskSchema = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
    blockedReason: z.string().trim().min(3).optional(),
    logMinutes: z.number().int().min(1).max(24 * 60).optional(),
    ownerId: z.string().optional(),
  })
  .refine((v) => v.status !== "blocked" || !!v.blockedReason, {
    message: "Blocked status requires a documented reason",
    path: ["blockedReason"],
  });
export type UpdateTask = z.infer<typeof updateTaskSchema>;

export type TaskView = {
  id: string;
  title: string;
  kind: "work" | "qc" | "client_review" | "planning";
  status: TaskStatus;
  flowStep: string | null;
  role: string | null;
  owner: { id: string; name: string } | null;
  deadline: string | null;
  overdue: boolean;
  blockedReason: string | null;
  timeLoggedMin: number;
  dependsOn: string[];
  /** True when every task this one depends on is done. */
  ready: boolean;
  deliverable: { id: string; title: string; type: string; status: string } | null;
  client: { id: string; name: string } | null;
  engagementId: string | null;
};

// ---------------------------------------------------------------------------
// Versions, comments and the Review Studio

export type FileKind = "image" | "video" | "pdf" | "link" | "other";

export const fileKindFromMime = (mime: string): FileKind =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime === "application/pdf" ? "pdf" : "other";

const pct = z.number().min(0).max(100);
/** One freehand stroke: points as percent from the top-left of the image or video frame. */
export const reviewStrokeSchema = z.array(z.tuple([pct, pct])).min(2).max(500);

/**
 * Where a comment points: a spot on an image/PDF page (percent from top-left), a moment in a video (seconds), or a
 * spot on a video frame at a moment. v16: optional drawing (freehand strokes) on the image or frame.
 */
export const reviewAnchorSchema = z
  .object({ t: z.number().min(0).optional(), x: pct.optional(), y: pct.optional(), page: z.number().int().min(1).optional(), drawing: z.array(reviewStrokeSchema).min(1).max(20).optional() })
  .refine((a) => (a.x === undefined) === (a.y === undefined), { message: "A pin needs both x and y" })
  .refine((a) => a.t !== undefined || a.x !== undefined || !!a.drawing, { message: "Pick a spot, a moment or draw on the frame" });
export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>;

export const reviewCommentSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  anchor: reviewAnchorSchema.optional(),
  internal: z.boolean().default(false),
});
export type ReviewCommentInput = z.infer<typeof reviewCommentSchema>;

export const addLinkVersionSchema = z.object({ url: z.string().url(), note: z.string().trim().max(2000).optional() });

export type ReviewComment = {
  id: string;
  body: string;
  anchor: ReviewAnchor | null;
  internal: boolean;
  author: { name: string; isClient: boolean };
  at: string;
  versionId: string;
  /** v16: open comments move to the next version; this says which version it started on. */
  carriedFrom?: number | null;
  resolvedAt?: string | null;
};

export type QcResultView = {
  id: string;
  result: "pass" | "fail";
  items: { label: string; ok: boolean; note?: string }[];
  note: string | null;
  reviewer: string;
  at: string;
};

export type VersionView = {
  id: string;
  number: number;
  note: string | null;
  kind: FileKind;
  name: string | null;
  /** Same-origin URL for files (served by the API with access checks) or the external link. */
  url: string;
  uploadedBy: string;
  at: string;
  sentToClientAt: string | null;
  qc: QcResultView[];
  approved: { by: string; at: string } | null;
};

export type DeliverableStatus =
  | "planned"
  | "in_production"
  | "in_qc"
  | "qc_failed"
  | "qc_passed"
  | "ready_for_client"
  | "changes_requested"
  | "approved"
  | "scheduled"
  | "published";

export const deliverableStatusLabels: Record<DeliverableStatus, string> = {
  planned: "Planned",
  in_production: "In production",
  in_qc: "In QC",
  qc_failed: "QC failed",
  qc_passed: "QC passed, ready to send",
  ready_for_client: "With client",
  changes_requested: "Changes requested",
  approved: "Approved",
  scheduled: "Scheduled",
  published: "Published",
};

/** What a client sees (glossary: QC is hidden from clients). */
export const clientDeliverableLabels: Record<DeliverableStatus, string> = {
  planned: "Planned",
  in_production: "In production",
  in_qc: "In production",
  qc_failed: "In production",
  qc_passed: "In production",
  ready_for_client: "Ready for your review",
  changes_requested: "Updating with your feedback",
  approved: "Approved",
  scheduled: "Scheduled",
  published: "Published",
};

export type DeliverableDetail = {
  id: string;
  title: string;
  type: string;
  status: DeliverableStatus;
  dueAt: string | null;
  client: { id: string; name: string };
  engagementId: string;
  serviceName: string;
  revisionRounds: { used: number; included: number };
  versions: VersionView[];
  comments: ReviewComment[];
  tasks: TaskView[];
  qcChecklist: string[];
  can: { upload: boolean; qc: boolean; send: boolean; comment: boolean; internal: boolean; /** v16: this client lets BMU approve posts itself (no client sign-off). */ approveForPublishing?: boolean };
  /** v10: who approved this version and who is still pending (client approval rule). */
  approvalStatus?: DeliverApprovalStatus | null;
  /** v10: content calendar slot. */
  schedule?: { scheduledAt: string | null; channel: string | null; publishedAt: string | null; liveUrl: string | null } | null;
  /** v16: each version's round (internal check, then the client) and the approval certificate once approved. */
  rounds?: ProofRoundView[];
  certificate?: { id: string; code: string } | null;
  caption?: string | null;
};

export type ClientDeliverableDetail = Omit<DeliverableDetail, "tasks" | "qcChecklist" | "can"> & {
  can: { approve: boolean; requestChanges: boolean; comment: boolean };
  /** v37: a one-time project before the final payment: watermarked previews, videos with an on-screen mark, no download. */
  preview?: boolean;
};

export type ReviewListItem = {
  id: string;
  title: string;
  type: string;
  status: DeliverableStatus;
  statusLabel: string;
  serviceName: string;
  latestVersion: number | null;
  waitingOnYou: boolean;
};

export type QcQueueItem = {
  deliverableId: string;
  title: string;
  type: string;
  client: string;
  serviceName: string;
  versionNumber: number;
  uploadedBy: string;
  waitingSince: string;
};

// ---------------------------------------------------------------------------
// My Day: attendance and end-of-day report

export type MyDayView = {
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  /** v30: today is a working day, a weekly off or a holiday (check-in only on working days, once a day). */
  workday?: { kind: "working" | "weekend" | "holiday"; label: string | null };
  canCheckIn?: boolean;
  canCheckOut?: boolean;
  /** v30: the next working day, when check-in opens again. */
  nextCheckIn?: string | null;
  /** v30: today's check-in was after start + grace. */
  late?: boolean;
  workingHours?: { start: string; end: string; graceMinutes: number };
  /** v30: the latest recent working day with a check-in and no check-out (and no correction asked yet). */
  missedCheckOut?: string | null;
  /** v31: approved leave today (check-in is closed, like a holiday); wfh = working from home (check in as usual). */
  onLeave?: { type: string; label: string; until: string } | null;
  wfh?: boolean;
  /** v31: the final decision on the person's latest leave request (shown for 3 days). */
  leaveNotice?: { status: "approved" | "rejected"; type: string; title: string; body: string } | null;
  tasks: { overdue: TaskView[]; today: TaskView[]; upcoming: TaskView[]; blocked: TaskView[] };
  qcWaiting: number;
  sendToClientWaiting: number;
  /** v10: overdue / at-risk delivery items this person should act on. */
  deliverSla?: DeliverSlaItem[];
  eod: { completed: string[]; pending: string[]; blocked: string[]; waiting: string[]; submitted: boolean };
};

export const eodSchema = z.object({
  completed: z.array(z.string().trim().min(1)).default([]),
  pending: z.array(z.string().trim().min(1)).default([]),
  blocked: z.array(z.string().trim().min(1)).default([]),
  waiting: z.array(z.string().trim().min(1)).default([]),
});
export type EodInput = z.infer<typeof eodSchema>;
