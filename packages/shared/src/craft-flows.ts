// v10 craft: specialist workspaces (video editor, script writer, social media manager, developer, UX/UI designer,
// graphic designer). A specialty is a job function on top of the base role (producer / strategist).
import { z } from "zod";

// ---------------------------------------------------------------------------
// Specialties

export type CraftSpecialtyDef = {
  id: string;
  label: string;
  /** Usual department and base role for this job (a hint for the invite form, not enforced). */
  department: string;
  baseRole: string;
  description: string;
  /** Flow step keys this person is a good fit for. Steps not listed anywhere fit everyone. */
  steps: string[];
};

export const CRAFT_SPECIALTIES = [
  { id: "video_editor", label: "Video editor", department: "Video / Production", baseRole: "producer", description: "Edits reels and videos from rough cut to export.", steps: ["shoot", "edit", "rough_cut", "fine_cut", "colour", "sound", "export"] },
  { id: "script_writer", label: "Script writer", department: "Strategy", baseRole: "producer", description: "Writes scripts, hooks and copy from client briefs.", steps: ["script", "write", "outline", "copy", "brief"] },
  { id: "social_media_manager", label: "Social media manager", department: "Strategy", baseRole: "strategist", description: "Runs each client's content pipeline, schedule and approvals.", steps: ["brief", "copy", "schedule", "publish", "plan"] },
  { id: "developer", label: "Developer", department: "Web / AI", baseRole: "producer", description: "Builds websites and web projects, fixes client change requests.", steps: ["build", "develop", "launch"] },
  { id: "ux_ui_designer", label: "UX/UI designer", department: "Creative / Design", baseRole: "producer", description: "Research, wireframes, UI, prototypes and developer handoff.", steps: ["research", "wireframe", "ui", "prototype", "handoff", "design"] },
  { id: "graphic_designer", label: "Graphic designer", department: "Creative / Design", baseRole: "producer", description: "Posts, carousels, ads and brand assets.", steps: ["design", "make"] },
] as const satisfies readonly CraftSpecialtyDef[];

/**
 * Project manager: a manager specialty (not a maker), so it is kept out of CRAFT_SPECIALTIES and never picks a
 * specialist dashboard. People with it (and CMs, CM leads and department heads) get the Manager workspace.
 */
export const CRAFT_PROJECT_MANAGER: CraftSpecialtyDef = {
  id: "project_manager",
  label: "Project manager",
  department: "Client Management",
  baseRole: "account_manager",
  description: "Assigns work across a mixed team and looks after a set of clients.",
  steps: [],
};

/** Every specialty a person can be given (the invite and users forms). */
export const CRAFT_SPECIALTY_OPTIONS: readonly CraftSpecialtyDef[] = [...CRAFT_SPECIALTIES, CRAFT_PROJECT_MANAGER];

export type CraftSpecialty = (typeof CRAFT_SPECIALTIES)[number]["id"];
export const CRAFT_SPECIALTY_IDS = CRAFT_SPECIALTIES.map((s) => s.id) as CraftSpecialty[];

export const isCraftSpecialty = (v: string | null | undefined): v is CraftSpecialty => !!v && (CRAFT_SPECIALTY_IDS as string[]).includes(v);

/** Human label for any specialty value, including custom ones added later ("motion_designer" → "Motion designer"). */
export function craftSpecialtyLabel(v: string | null | undefined): string {
  if (!v) return "";
  const known = CRAFT_SPECIALTIES.find((s) => s.id === v);
  if (known) return known.label;
  const words = v.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Specialty input: one of the known ids or any lowercase key (extensible), or null to clear. */
export const craftSpecialtySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z_]{1,39}$/, "Pick a specialty from the list")
  .nullable();

const ALL_STEP_KEYS = new Set<string>(CRAFT_SPECIALTIES.flatMap((s) => s.steps));

/**
 * Whether someone with this specialty fits a flow step. People without a specialty fit everything, and steps no
 * specialty claims (custom flows) fit everyone. Used by auto-assignment to keep e.g. developers off design steps.
 */
export function craftFitsStep(specialty: string | null | undefined, stepKey: string | null | undefined): boolean {
  if (!specialty || !stepKey) return true;
  const def = CRAFT_SPECIALTIES.find((s) => s.id === specialty);
  if (!def) return true;
  if (!ALL_STEP_KEYS.has(stepKey)) return true;
  return (def.steps as readonly string[]).includes(stepKey);
}

// ---------------------------------------------------------------------------
// Helpers shared by web, mobile and the API

/** Spoken words per minute used for the script runtime estimate. */
export const CRAFT_WORDS_PER_MINUTE = 150;

/** Word count and estimated spoken runtime of a script (markdown symbols ignored). */
export function craftScriptStats(text: string): { words: number; seconds: number; label: string } {
  const plain = text.replace(/[#*_>`~\-[\]()!]/g, " ");
  const words = plain.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const seconds = Math.round((words / CRAFT_WORDS_PER_MINUTE) * 60);
  const label = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return { words, seconds, label };
}

/** Monthly social quota per tier when the price book has no per-tier deliverables written down. */
export const CRAFT_SOCIAL_QUOTAS: Record<string, { posts: number; reels: number; stories: number }> = {
  starter: { posts: 12, reels: 4, stories: 8 },
  growth: { posts: 16, reels: 8, stories: 12 },
  premium: { posts: 24, reels: 12, stories: 20 },
};

/** Reads "12 posts / month", "4 reels", "8 stories" style lines from a service tier's deliverables. */
export function craftParseQuota(lines: string[]): { posts: number; reels: number; stories: number } | null {
  const out = { posts: 0, reels: 0, stories: 0 };
  let found = false;
  for (const line of lines) {
    const m = line.toLowerCase().match(/(\d+)\s*(?:x\s*)?(posts?|carousels?|creatives?|reels?|videos?|stories|story)/);
    if (!m) continue;
    const n = Number(m[1]);
    found = true;
    if (/reel|video/.test(m[2])) out.reels += n;
    else if (/stor/.test(m[2])) out.stories += n;
    else out.posts += n;
  }
  return found ? out : null;
}

/** Which quota bucket a deliverable type counts towards. */
export function craftQuotaBucket(type: string): "posts" | "reels" | "stories" | null {
  if (["post", "carousel", "ad"].includes(type)) return "posts";
  if (["reel", "video"].includes(type)) return "reels";
  if (type === "story") return "stories";
  return null;
}

/** Default working checklists per kind. */
export const CRAFT_CHECKLISTS: Record<CraftChecklistKind, string[]> = {
  export: ["Final audio mix and levels checked", "Colour grade applied", "Captions burned in and proofread", "Brand intro / outro and logo", "Exported in 9:16 and 1:1 at the right bitrate", "Music licence noted", "File named client_title_v#"],
  web_qc: ["Responsive on mobile, tablet and desktop", "Page speed (Lighthouse 80+)", "SEO basics: titles, meta, alt text, sitemap", "All forms submit and send email", "Links and buttons work", "No placeholder text or images"],
  handoff: ["Design tokens (colours, type, spacing) documented", "Components named and organised", "All screens and states (empty, error, loading)", "Assets exported (SVG / 2x PNG)", "Prototype link shared", "Developer walkthrough done"],
};
export const CRAFT_CHECKLIST_KINDS = ["export", "web_qc", "handoff"] as const;
export type CraftChecklistKind = (typeof CRAFT_CHECKLIST_KINDS)[number];
export const craftChecklistLabels: Record<CraftChecklistKind, string> = { export: "Render & export checklist", web_qc: "Web QC self-check", handoff: "Handoff checklist" };

// ---------------------------------------------------------------------------
// Inputs

export const craftHookInputSchema = z.object({
  text: z.string().trim().min(4, "Write the hook line (at least 4 characters)").max(400),
  tags: z.array(z.string().trim().min(1).max(30)).max(8).default([]),
  clientOrgId: z.string().optional(),
});
export type CraftHookInput = z.infer<typeof craftHookInputSchema>;

export const craftScriptInputSchema = z.object({
  title: z.string().trim().min(2, "Give the script a title").max(160),
  body: z.string().max(60_000).default(""),
  deliverableId: z.string().nullable().optional(),
});
export type CraftScriptInput = z.infer<typeof craftScriptInputSchema>;

export const craftChecklistInputSchema = z.object({
  items: z.array(z.object({ label: z.string().trim().min(1).max(200), done: z.boolean() })).min(1).max(30),
});
export type CraftChecklistInput = z.infer<typeof craftChecklistInputSchema>;

export const craftBrandKitInputSchema = z.object({
  colours: z.array(z.string().trim().regex(/^#?[0-9a-fA-F]{3,8}$|^[A-Za-z][\w\s-]{1,30}$/, "Colours look like #8BB72C")).max(12).default([]),
  fonts: z.array(z.string().trim().min(1).max(60)).max(6).default([]),
  notes: z.string().trim().max(2000).optional(),
  // v16: tone of voice, do and don't lists, competitors
  tone: z.string().trim().max(1000).optional(),
  dos: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  donts: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  competitors: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
});
export type CraftBrandKitInput = z.infer<typeof craftBrandKitInputSchema>;

export const craftNudgeInputSchema = z.object({ message: z.string().trim().max(1000).optional() });

// ---------------------------------------------------------------------------
// Views

export type CraftPerson = { id: string; name: string; specialty: string | null; specialtyLabel: string; department: string | null; baseRole: string | null };

export type CraftKpi = {
  key: string;
  label: string;
  value: number;
  /** Same measure over the previous period of equal length (null when not comparable). */
  previous: number | null;
  format: "int" | "pct" | "hours" | "days";
  lowerIsBetter?: boolean;
  hint?: string;
  href?: string;
};

export type CraftNextKind = "overdue" | "due_today" | "assigned" | "feedback" | "blocked";
export type CraftNextItem = { id: string; kind: CraftNextKind; title: string; detail: string; href: string; due: string | null; client: string | null };

export type CraftStrip = {
  checkIn: string | null;
  checkOut: string | null;
  /** v30: check-in / check-out open (working day, once a day); offDay names a holiday or weekly off. */
  canCheckIn?: boolean;
  canCheckOut?: boolean;
  offDay?: string | null;
  overdue: number; dueToday: number; blocked: number; open: number; eodSubmitted: boolean };

export type CraftWorkload = {
  /** Week labels, oldest first (e.g. "8 Sep"); the last `future` weeks are planned work. */
  weeks: string[];
  future: number;
  hours: (number | null)[];
  done: (number | null)[];
  due: number[];
  /** Day-of-week × week heat of finished tasks. */
  heat: { rows: string[]; cols: string[]; values: (number | null)[][] };
};

export type CraftJob = {
  deliverableId: string;
  taskId: string | null;
  title: string;
  type: string;
  client: { id: string; name: string };
  engagementId: string;
  status: string;
  statusLabel: string;
  stage: string;
  due: string | null;
  overdue: boolean;
  priority: "high" | "normal" | "low";
  roundsUsed: number;
  roundsIncluded: number;
  versions: number;
  canUpload: boolean;
  href: string;
};

export type CraftComment = {
  id: string;
  deliverableId: string;
  deliverableTitle: string;
  client: string;
  versionNumber: number;
  body: string;
  author: string;
  fromClient: boolean;
  at: string;
  /** "0:42" for a video moment, "Pin 32% · 54%" for an image pin, null for general comments. */
  anchorLabel: string | null;
  anchor: { t: number } | { x: number; y: number } | null;
  resolvedAt: string | null;
  href: string;
};

export type CraftRounds = { deliverableId: string; title: string; client: string; used: number; included: number; left: number; href: string };

export type CraftChecklistView = { deliverableId: string; title: string; client: string; kind: CraftChecklistKind; items: { label: string; done: boolean }[]; done: number; total: number; href: string };

export type CraftBrandKitView = {
  clientId: string;
  client: string;
  colours: string[];
  fonts: string[];
  notes: string | null;
  files: { id: string; name: string; kind: string; url: string; at: string }[];
  updatedAt: string | null;
  tone?: string | null;
  dos?: string[];
  donts?: string[];
  competitors?: string[];
};

export type CraftRate = { rate: number | null; good: number; total: number; previous: number | null };

export type CraftHookView = { id: string; text: string; tags: string[]; client: string | null; uses: number; at: string };
export type CraftScriptView = { id: string; title: string; body: string; deliverableId: string | null; deliverableTitle: string | null; words: number; runtime: string; submittedVersionId: string | null; updatedAt: string };

export type CraftVideoPanels = {
  stages: { key: string; label: string; items: CraftJob[] }[];
  assets: { deliverableId: string; title: string; client: string; href: string; items: { label: string; status: string; note: string | null }[] }[];
  timeComments: CraftComment[];
  rounds: CraftRounds[];
  exportChecklists: CraftChecklistView[];
  hoursPerVideo: { deliverableId: string; title: string; client: string; hours: number; turnaroundDays: number | null; href: string }[];
  avgTurnaroundDays: number | null;
  upcoming: { id: string; title: string; client: string; at: string; kind: "shoot" | "deadline"; href: string }[];
};

export type CraftScriptPanels = {
  briefs: CraftJob[];
  scripts: { draft: CraftJob[]; review: CraftJob[]; approved: CraftJob[] };
  feedback: CraftComment[];
  changesRequested: CraftJob[];
  drafts: CraftScriptView[];
  hooks: CraftHookView[];
  turnaround: { avgDays: number | null; previous: number | null };
  firstTime: CraftRate;
  deliverables: { id: string; title: string; client: string; canUpload: boolean }[];
};

export const CRAFT_SOCIAL_STAGES = [
  { key: "idea", label: "Idea" },
  { key: "design", label: "Design" },
  { key: "copy", label: "Copy & checks" },
  { key: "client", label: "With client" },
  { key: "approved", label: "Approved" },
  { key: "scheduled", label: "Scheduled" },
  { key: "published", label: "Published" },
] as const;
export type CraftSocialStage = (typeof CRAFT_SOCIAL_STAGES)[number]["key"];

/** Social pipeline stage from a deliverable status. */
export function craftSocialStage(status: string): CraftSocialStage {
  switch (status) {
    case "planned":
      return "idea";
    case "in_production":
    case "qc_failed":
    case "changes_requested":
      return "design";
    case "in_qc":
    case "qc_passed":
      return "copy";
    case "ready_for_client":
      return "client";
    case "approved":
      return "approved";
    case "scheduled":
      return "scheduled";
    default:
      return "published";
  }
}

export type CraftSocialPanels = {
  pipeline: { clientId: string; client: string; counts: Record<CraftSocialStage, number>; items: (CraftJob & { socialStage: CraftSocialStage })[] }[];
  schedule: { date: string; items: { id: string; title: string; client: string; status: string; statusLabel: string; type: string; href: string; at: string; dateSource: "scheduled" | "due" }[] }[];
  approvals: { deliverableId: string; title: string; client: string; sentAt: string; daysWaiting: number; lastNudgeAt: string | null; canNudge: boolean; href: string }[];
  requests: { id: string; client: string; type: string; description: string; status: string; createdAt: string; overdue: boolean; href: string }[];
  quotas: { clientId: string; client: string; packageName: string; source: "price_book" | "standard"; buckets: { key: "posts" | "reels" | "stories"; label: string; used: number; quota: number }[] }[];
  /** Real engagement numbers when an integration provides them; never invented. */
  performance: null;
};

export type CraftDevPanels = {
  projects: { engagementId: string; client: string; service: string; done: number; total: number; pct: number; deadline: string | null; deliverables: { id: string; title: string; status: string; statusLabel: string; href: string }[]; href: string }[];
  board: { key: "backlog" | "in_progress" | "review" | "done"; label: string; items: CraftJob[] }[];
  changes: { id: string; client: string; description: string; status: string; createdAt: string; deliverable: string | null; overdue: boolean; href: string }[];
  links: { deliverableId: string; title: string; client: string; staging: { url: string; number: number; at: string } | null; live: { url: string; number: number } | null; canAdd: boolean; href: string }[];
  qc: { deliverableId: string; title: string; client: string; result: "pass" | "fail" | null; at: string | null; items: { label: string; ok: boolean | null; note: string | null }[]; href: string }[];
  hours: { taskId: string; title: string; client: string; loggedHours: number; estimateHours: number; done: boolean; href: string }[];
  totals: { loggedHours: number; estimateHours: number };
};

export const CRAFT_UX_PHASES = [
  { key: "research", label: "Research" },
  { key: "wireframe", label: "Wireframe" },
  { key: "ui", label: "UI design" },
  { key: "prototype", label: "Prototype" },
  { key: "handoff", label: "Handoff" },
] as const;

export type CraftUxPanels = {
  phases: { key: string; label: string; items: CraftJob[] }[];
  pins: CraftComment[];
  compare: { deliverableId: string; title: string; client: string; versions: number; href: string }[];
  brand: CraftBrandKitView[];
  handoff: CraftChecklistView[];
  rounds: CraftRounds[];
  firstTime: CraftRate;
};

export type CraftGraphicPanels = {
  queue: CraftJob[];
  firstPass: CraftRate;
  pins: CraftComment[];
  brand: CraftBrandKitView[];
  uploadable: { id: string; title: string; client: string; status: string }[];
  output: { days: { date: string; count: number }[]; today: number; streak: number; best: number };
  rounds: CraftRounds[];
};

type CraftBase = {
  person: CraftPerson;
  /** True when a lead is looking at someone else's dashboard: actions are hidden. */
  readOnly: boolean;
  period: { from: string; to: string; prevFrom: string; prevTo: string };
  strip: CraftStrip;
  kpis: CraftKpi[];
  next: CraftNextItem[];
  workload: CraftWorkload;
  insights: string[];
};

export type CraftDashboard =
  | (CraftBase & { specialty: "video_editor"; panels: CraftVideoPanels })
  | (CraftBase & { specialty: "script_writer"; panels: CraftScriptPanels })
  | (CraftBase & { specialty: "social_media_manager"; panels: CraftSocialPanels })
  | (CraftBase & { specialty: "developer"; panels: CraftDevPanels })
  | (CraftBase & { specialty: "ux_ui_designer"; panels: CraftUxPanels })
  | (CraftBase & { specialty: "graphic_designer"; panels: CraftGraphicPanels })
  | (CraftBase & { specialty: null; panels: null });

export type CraftSpecialistRow = {
  id: string;
  name: string;
  email: string | null;
  specialty: string;
  specialtyLabel: string;
  department: string | null;
  open: number;
  overdue: number;
  dueThisWeek: number;
  doneLast30: number;
  hoursLast30: number;
  href: string;
};

// ---------------------------------------------------------------------------
// Manager workspace (client managers, CM leads, department heads, project managers)

/** Base roles whose /team home is the Manager workspace (unless they also have a maker specialty). */
export const CRAFT_MANAGER_ROLES = ["account_manager", "am_lead", "department_head"] as const;
/** Roles that may open the Manager workspace at all (founder and admin see everything). */
export const CRAFT_MANAGER_ACCESS_ROLES = [...CRAFT_MANAGER_ROLES, "founder", "admin"] as const;

/** Whether this person's /team home is the Manager workspace. A maker specialty wins over the manager role. */
export function isCraftManager(me: { roles: string[]; specialty?: string | null }): boolean {
  if (isCraftSpecialty(me.specialty)) return false;
  if (me.specialty === CRAFT_PROJECT_MANAGER.id) return true;
  return me.roles.some((r) => (CRAFT_MANAGER_ROLES as readonly string[]).includes(r));
}

export const canOpenCraftManager = (me: { roles: string[]; specialty?: string | null }) =>
  me.specialty === CRAFT_PROJECT_MANAGER.id || me.roles.some((r) => (CRAFT_MANAGER_ACCESS_ROLES as readonly string[]).includes(r));

/** Load estimate, same as the Capacity page: an open task ≈ 4 hours, 48 productive hours a week (8h × 6 days). */
export const CRAFT_HOURS_PER_TASK = 4;
export const CRAFT_WEEK_HOURS = 48;

export const CRAFT_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type CraftPriority = (typeof CRAFT_PRIORITIES)[number];
export const craftPriorityLabels: Record<CraftPriority, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };

/** The specialty that usually does a flow step (first match), or null when any specialty fits. */
export function craftSpecialtyForStep(stepKey: string | null | undefined): CraftSpecialty | null {
  if (!stepKey) return null;
  return CRAFT_SPECIALTIES.find((s) => (s.steps as readonly string[]).includes(stepKey))?.id ?? null;
}

const dateish = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Pick a valid date");

export const craftAssignInputSchema = z.object({
  ownerId: z.string().min(1, "Pick a team member"),
  deadline: dateish.nullable().optional(),
  priority: z.enum(CRAFT_PRIORITIES).optional(),
  note: z.string().trim().max(500).optional(),
});
export type CraftAssignInput = z.infer<typeof craftAssignInputSchema>;

export const craftBulkAssignInputSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1, "Pick at least one task").max(100),
  ownerId: z.string().min(1, "Pick a team member"),
});
export type CraftBulkAssignInput = z.infer<typeof craftBulkAssignInputSchema>;

export const craftTaskUpdateInputSchema = z
  .object({ deadline: dateish.nullable().optional(), priority: z.enum(CRAFT_PRIORITIES).optional() })
  .refine((v) => v.deadline !== undefined || v.priority !== undefined, "Change the deadline or the priority");
export type CraftTaskUpdateInput = z.infer<typeof craftTaskUpdateInputSchema>;

export const craftAdhocTaskInputSchema = z.object({
  title: z.string().trim().min(3, "Give the task a title").max(200),
  engagementId: z.string().min(1).optional(),
  deliverableId: z.string().min(1).optional(),
  specialty: craftSpecialtySchema.optional(),
  ownerId: z.string().min(1).nullable().optional(),
  deadline: dateish.nullable().optional(),
  priority: z.enum(CRAFT_PRIORITIES).default("normal"),
});
export type CraftAdhocTaskInput = z.input<typeof craftAdhocTaskInputSchema>;

export const CRAFT_NOTE_KINDS = ["call", "note", "meeting"] as const;
export type CraftNoteKind = (typeof CRAFT_NOTE_KINDS)[number];
export const craftClientNoteInputSchema = z
  .object({
    kind: z.enum(CRAFT_NOTE_KINDS),
    body: z.string().trim().min(2, "Write a short note").max(2000),
    remindAt: dateish.nullable().optional(),
  })
  .refine((v) => v.kind !== "meeting" || !!v.remindAt, { message: "Pick when the meeting is", path: ["remindAt"] });
export type CraftClientNoteInput = z.infer<typeof craftClientNoteInputSchema>;

export type CraftBoardTask = {
  id: string;
  title: string;
  kind: string;
  flowStep: string | null;
  status: string;
  priority: CraftPriority;
  deadline: string | null;
  overdue: boolean;
  owner: { id: string; name: string; specialtyLabel: string } | null;
  /** The specialty that fits this task (from its flow step), if any. */
  specialty: string | null;
  client: { id: string; name: string } | null;
  service: { id: string; name: string } | null;
  engagementId: string | null;
  deliverable: { id: string; title: string; status: string } | null;
  blockedReason: string | null;
  /** Earlier steps that are not done yet. */
  waitingOn: string[];
  /** QC tasks: the person who uploaded the latest version (they cannot QC it). */
  cannotAssignTo: string[];
  suggestion: { userId: string; name: string; reason: string } | null;
  href: string;
};

export type CraftMember = {
  id: string;
  name: string;
  specialty: string | null;
  specialtyLabel: string;
  department: string | null;
  baseRole: string | null;
  open: number;
  overdue: number;
  dueThisWeek: number;
  hoursThisWeek: number;
  capacityHours: number;
  loadPct: number;
  onLeaveToday: boolean;
  leaveDaysThisWeek: number;
  href: string;
};

export type CraftClientCard = {
  id: string;
  name: string;
  health: string;
  am: string | null;
  threadId: string | null;
  services: { engagementId: string; service: string; gate: string; status: string; milestone: string | null; progress: { done: number; total: number }; href: string }[];
  approvals: { deliverableId: string; title: string; sentAt: string; daysWaiting: number; canNudge: boolean; lastNudgeAt: string | null; href: string }[];
  requests: { id: string; type: string; description: string; status: string; slaDue: string | null; replied: boolean; overdue: boolean; hoursLeft: number | null; href: string }[];
  overdueInvoices: { id: string; number: string; totalPaise: number; dueDate: string; daysOverdue: number; href: string }[];
  nextDue: { deliverableId: string; title: string; due: string; status: string; statusLabel: string; href: string }[];
  lastContact: { at: string; by: "client" | "team"; author: string } | null;
  notes: { id: string; kind: CraftNoteKind; body: string; author: string; at: string; remindAt: string | null }[];
  href: string;
};

export type CraftTodayKind = "blocked" | "overdue" | "qc_failed" | "client_reply" | "approval" | "invoice" | "reminder" | "unassigned";
export type CraftTodayItem = {
  id: string;
  kind: CraftTodayKind;
  title: string;
  detail: string;
  href: string;
  at: string | null;
  client: string | null;
  taskId?: string;
  deliverableId?: string;
  canNudge?: boolean;
};

export type CraftTeamRow = {
  userId: string;
  name: string;
  specialtyLabel: string;
  /** Planned hours per day for the next 14 days (open tasks × 4h on their due day; leave days are null). */
  heat: (number | null)[];
  onTimePct: number | null;
  qcFirstPassPct: number | null;
  done30: number;
  href: string;
};

export type CraftManagerView = {
  person: CraftPerson;
  scope: "own_clients" | "department" | "all";
  scopeLabel: string;
  strip: CraftStrip;
  kpis: CraftKpi[];
  insights: string[];
  board: CraftBoardTask[];
  members: CraftMember[];
  /** v32: who new work may go to (Department Heads: their team; others: Department Heads). */
  assignableIds?: string[];
  filters: { clients: { id: string; name: string }[]; services: { id: string; name: string }[]; specialties: { id: string; label: string }[] };
  /** Engagements and open deliverables the manager can attach an ad-hoc task to. */
  engagements: { id: string; label: string; clientId: string }[];
  deliverables: { id: string; title: string; engagementId: string }[];
  clients: CraftClientCard[];
  today: CraftTodayItem[];
  team: { days: string[]; dates: string[]; rows: CraftTeamRow[] };
};
