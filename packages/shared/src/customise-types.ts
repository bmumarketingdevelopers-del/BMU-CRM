// v14 no-code customisation: custom fields on core records, forms (shared link or website embed) and
// pipeline settings (names, order, hidden stages, required fields and time targets).
import { z } from "zod";
import { LEAD_STAGES, leadStageLabels } from "./crm.js";
import { REQUEST_STATUSES, requestStatusLabels } from "./requests.js";
import { workflowData } from "./data/workflow.js";

// ---------------------------------------------------------------------------
// Custom fields

export const CUSTOM_FIELD_ENTITIES = ["lead", "client", "engagement", "request", "creator"] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];
export const customFieldEntityLabels: Record<CustomFieldEntity, { one: string; many: string }> = {
  lead: { one: "Lead", many: "Leads" },
  client: { one: "Client", many: "Clients" },
  engagement: { one: "Project", many: "Projects" },
  request: { one: "Client request", many: "Client requests" },
  creator: { one: "Creator", many: "Creators" },
};

export const CUSTOM_FIELD_TYPES = ["text", "long_text", "number", "money", "date", "select", "checkbox"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const customFieldTypeLabels: Record<CustomFieldType, string> = {
  text: "Short text",
  long_text: "Long text",
  number: "Number",
  money: "Amount (₹)",
  date: "Date",
  select: "Pick from a list",
  checkbox: "Yes / no",
};

/** "Budget band" → "budget_band". */
export const customFieldKey = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "field";

export const customFieldInputSchema = z
  .object({
    entity: z.enum(CUSTOM_FIELD_ENTITIES),
    label: z.string().trim().min(2, "Give the field a name").max(60),
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lower-case letters, numbers and _ (start with a letter)")
      .optional(),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
    required: z.boolean().default(false),
    helpText: z.string().trim().max(200).optional().nullable(),
  })
  .refine((v) => v.type !== "select" || v.options.length >= 2, { message: "Add at least two choices", path: ["options"] })
  .refine((v) => new Set(v.options.map((o) => o.toLowerCase())).size === v.options.length, { message: "Each choice must be different", path: ["options"] });
export type CustomFieldInput = z.input<typeof customFieldInputSchema>;
export const customFieldUpdateSchema = z.object({
  label: z.string().trim().min(2, "Give the field a name").max(60).optional(),
  options: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
  required: z.boolean().optional(),
  helpText: z.string().trim().max(200).optional().nullable(),
  position: z.number().int().min(0).max(1000).optional(),
  archived: z.boolean().optional(),
});
export type CustomFieldUpdate = z.input<typeof customFieldUpdateSchema>;

export type CustomFieldDefView = {
  id: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[];
  required: boolean;
  helpText: string | null;
  position: number;
  archived: boolean;
  /** Records with a value filled in. */
  used: number;
};

export type CustomFieldValue = string | number | boolean | null;
export type CustomFieldValues = Record<string, CustomFieldValue>;
export type CustomFieldRecordView = { entity: CustomFieldEntity; id: string; canEdit: boolean; fields: CustomFieldDefView[]; values: CustomFieldValues };
export const customFieldValuesSchema = z.object({ values: z.record(z.string(), z.union([z.string().max(4000), z.number(), z.boolean(), z.null()])) });

type DefLike = { key: string; label: string; type: string; options: unknown; required?: boolean };

/** Turns raw input into the stored value for a field, or returns a plain-English problem. Empty → null. */
export function customFieldCoerce(def: DefLike, raw: unknown): { value: CustomFieldValue } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  const options = Array.isArray(def.options) ? (def.options as string[]) : [];
  switch (def.type) {
    case "text":
    case "long_text": {
      const s = String(raw).trim();
      if (s.length > (def.type === "text" ? 200 : 4000)) return { error: `${def.label} is too long` };
      return { value: s || null };
    }
    case "number":
    case "money": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[₹,\s]/g, ""));
      if (!Number.isFinite(n)) return { error: `${def.label} must be a number` };
      return { value: def.type === "money" ? Math.round(n * 100) / 100 : n };
    }
    case "date": {
      const s = String(raw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return { error: `${def.label} must be a date` };
      return { value: s };
    }
    case "select": {
      const s = String(raw);
      const match = options.find((o) => o.toLowerCase() === s.toLowerCase());
      if (!match) return { error: `${def.label} must be one of: ${options.join(", ")}` };
      return { value: match };
    }
    case "checkbox":
      return { value: raw === true || raw === "true" || raw === "yes" || raw === "1" || raw === 1 };
    default:
      return { error: `${def.label} has an unknown type` };
  }
}

/** How a value reads on screen. */
export function customFieldDisplay(def: { type: string }, v: CustomFieldValue | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  if (def.type === "checkbox") return v ? "Yes" : "No";
  if (def.type === "money") return `₹${Number(v).toLocaleString("en-IN")}`;
  if (def.type === "date") return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${v}T00:00:00Z`));
  return String(v);
}

/** List filters for custom fields travel as `cf.<key>=<value>` query parameters. */
export const CUSTOM_FIELD_FILTER_PREFIX = "cf.";

// ---------------------------------------------------------------------------
// Forms

export const FORM_FIELD_TYPES = ["name", "email", "phone", "company", "budget", "services", "message", "text", "long_text", "select", "checkbox", "number", "date"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];
export const formFieldTypeLabels: Record<FormFieldType, { label: string; hint: string; standard?: boolean }> = {
  name: { label: "Name", hint: "Saved as the lead's contact name", standard: true },
  email: { label: "Email", hint: "Saved as the lead's email", standard: true },
  phone: { label: "Phone / WhatsApp", hint: "Saved as the lead's phone", standard: true },
  company: { label: "Business name", hint: "Saved as the lead's company", standard: true },
  budget: { label: "Monthly budget (₹)", hint: "Saved as the lead's budget", standard: true },
  services: { label: "Services wanted", hint: "Saved as the services the lead asked about", standard: true },
  message: { label: "What do you need?", hint: "Saved as the lead's need", standard: true },
  text: { label: "Short answer", hint: "Saved to a lead custom field, or in the lead's notes" },
  long_text: { label: "Long answer", hint: "Saved to a lead custom field, or in the lead's notes" },
  select: { label: "Pick one", hint: "Saved to a lead custom field, or in the lead's notes" },
  checkbox: { label: "Tick box", hint: "Saved to a lead custom field, or in the lead's notes" },
  number: { label: "Number", hint: "Saved to a lead custom field, or in the lead's notes" },
  date: { label: "Date", hint: "Saved to a lead custom field, or in the lead's notes" },
};

export const formFieldSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_]{1,40}$/),
  type: z.enum(FORM_FIELD_TYPES),
  label: z.string().trim().min(1, "Label each question").max(120),
  required: z.boolean().default(false),
  placeholder: z.string().trim().max(120).optional().nullable(),
  options: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  /** Lead custom field this answer is saved into (custom answers only). */
  customFieldKey: z.string().trim().max(40).optional().nullable(),
});
export type FormField = z.infer<typeof formFieldSchema>;

export const formInputSchema = z
  .object({
    name: z.string().trim().min(2, "Name the form (only your team sees this)").max(80),
    title: z.string().trim().min(2, "Add a heading").max(120),
    intro: z.string().trim().max(600).optional().nullable(),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{2,59}$/, "Use 3-60 lower-case letters, numbers and dashes")
      .optional(),
    fields: z.array(formFieldSchema).min(1, "Add at least one question").max(30),
    submitLabel: z.string().trim().min(1).max(40).default("Send"),
    successMessage: z.string().trim().min(2, "Write the thank-you message").max(400).default("Thank you! We will get back to you within one working day."),
    serviceIds: z.array(z.string()).max(20).default([]),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    const ids = new Set<string>();
    v.fields.forEach((f, i) => {
      if (ids.has(f.id)) ctx.addIssue({ code: "custom", message: "Each question needs its own id", path: ["fields", i] });
      ids.add(f.id);
      if (f.type === "select" && (f.options?.length ?? 0) < 2) ctx.addIssue({ code: "custom", message: `Add at least two choices for "${f.label}"`, path: ["fields", i] });
    });
    const types = v.fields.map((f) => f.type);
    if (!types.includes("email") && !types.includes("phone")) ctx.addIssue({ code: "custom", message: "Ask for an email or a phone number so the team can reply", path: ["fields"] });
    if (!types.includes("name") && !types.includes("company")) ctx.addIssue({ code: "custom", message: "Ask for a name or a business name", path: ["fields"] });
    for (const t of ["name", "email", "phone", "company", "budget", "services", "message"] as const) {
      if (types.filter((x) => x === t).length > 1) ctx.addIssue({ code: "custom", message: `Only one "${formFieldTypeLabels[t].label}" question per form`, path: ["fields"] });
    }
  });
export type FormInput = z.input<typeof formInputSchema>;

export type FormRow = { id: string; slug: string; name: string; title: string; enabled: boolean; submitCount: number; lastSubmissionAt: string | null; createdAt: string; fieldCount: number };
export type FormDetail = FormRow & { intro: string | null; fields: FormField[]; submitLabel: string; successMessage: string; serviceIds: string[]; publicPath: string };
export type FormSubmissionRow = { id: string; at: string; lead: { id: string; name: string } | null; answers: { label: string; value: string }[] };
/** What the public page needs (no internal data). */
export type FormPublic = { slug: string; title: string; intro: string | null; fields: Omit<FormField, "customFieldKey">[]; submitLabel: string; services: { id: string; name: string }[] };
export type FormSubmitResult = { ok: true; message: string };

/** Answers posted by the public form. `website` is a hidden trap field: people leave it empty, bots fill it. */
export const formSubmitSchema = z.object({
  answers: z.record(z.string(), z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(80)).max(20), z.null()])),
  website: z.string().max(200).optional(),
  pageUrl: z.string().max(500).optional(),
});
export type FormSubmit = z.input<typeof formSubmitSchema>;

/** The snippet to paste into a website. The script resizes the frame to fit the form. */
export function formEmbedSnippet(origin: string, slug: string) {
  const src = `${origin.replace(/\/$/, "")}/f/${slug}?embed=1`;
  return [
    `<iframe src="${src}" title="Enquiry form" style="width:100%;border:0;min-height:520px" loading="lazy" id="bmu-form-${slug}"></iframe>`,
    `<script>addEventListener("message",function(e){if(e.data&&e.data.bmuForm==="${slug}"){var f=document.getElementById("bmu-form-${slug}");if(f)f.style.height=e.data.height+"px";}});</script>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Pipelines

export const PIPELINE_KINDS = ["lead", "engagement", "request"] as const;
export type PipelineKind = (typeof PIPELINE_KINDS)[number];
export const pipelineKindLabels: Record<PipelineKind, { label: string; stage: string; hint: string }> = {
  lead: { label: "Lead stages", stage: "stage", hint: "The columns on the lead board. Won and Lost always exist (they start onboarding and close the lead)." },
  engagement: { label: "Project phases", stage: "phase", hint: "The status names shown on projects. The order sets how they are listed." },
  request: { label: "Request statuses", stage: "status", hint: "The status names your team sees on client requests." },
};

export const ENGAGEMENT_PHASES = workflowData.state_machines.engagement;
export const engagementPhaseLabels: Record<string, string> = {
  pending_payment: "Waiting for payment",
  onboarding: "Onboarding",
  blocked: "Blocked",
  planning: "Planning",
  awaiting_plan_approval: "Plan with client",
  in_production: "In production",
  in_review: "Client review",
  awaiting_final_payment: "Final payment due",
  delivered: "Delivered",
  active_retainer: "Active retainer",
  paused: "Paused",
  offboarding: "Offboarding",
  closed: "Closed",
};

/** Lead fields that can be required before a lead enters a stage. Lead custom fields use "custom.<key>". */
export const PIPELINE_LEAD_REQUIRED = ["owner", "email", "phone", "company", "budget", "services", "follow_up"] as const;
export const pipelineLeadRequiredLabels: Record<(typeof PIPELINE_LEAD_REQUIRED)[number], string> = {
  owner: "An owner",
  email: "Email",
  phone: "Phone",
  company: "Business name",
  budget: "Budget",
  services: "Services asked about",
  follow_up: "Next follow-up date",
};

export type PipelineStage = {
  key: string;
  label: string;
  hidden: boolean;
  /** Field keys that must be filled before a record enters this stage (leads only). */
  requiredFields: string[];
  /** Flag records that sit in this stage longer than this many days. */
  targetDays: number | null;
};
export type PipelineConfigView = { kind: PipelineKind; stages: PipelineStage[]; customised: boolean; updatedAt: string | null; updatedBy: string | null };
export type PipelinesView = { canEdit: boolean; pipelines: PipelineConfigView[]; leadCustomFields: { key: string; label: string }[] };

const LOCKED: Record<PipelineKind, string[]> = { lead: ["won", "lost"], engagement: [], request: [] };
/** Stages that can't be hidden (the app depends on them). */
export const pipelineLockedStages = (kind: PipelineKind) => LOCKED[kind];

export function pipelineKeys(kind: PipelineKind): readonly string[] {
  return kind === "lead" ? LEAD_STAGES : kind === "engagement" ? ENGAGEMENT_PHASES : REQUEST_STATUSES;
}

export function pipelineDefaultLabel(kind: PipelineKind, key: string): string {
  if (kind === "lead") return leadStageLabels[key as keyof typeof leadStageLabels] ?? key;
  if (kind === "engagement") return engagementPhaseLabels[key] ?? key.replace(/_/g, " ");
  return requestStatusLabels[key as keyof typeof requestStatusLabels]?.team ?? key;
}

export const pipelineDefaults = (kind: PipelineKind): PipelineStage[] => pipelineKeys(kind).map((key) => ({ key, label: pipelineDefaultLabel(kind, key), hidden: false, requiredFields: [], targetDays: null }));

/** Saved stages merged over the defaults: unknown keys dropped, missing keys appended, locked stages never hidden. */
export function pipelineMerge(kind: PipelineKind, saved: unknown): PipelineStage[] {
  const keys = pipelineKeys(kind);
  const rows = Array.isArray(saved) ? (saved as Partial<PipelineStage>[]) : [];
  const out: PipelineStage[] = [];
  for (const r of rows) {
    if (!r || typeof r.key !== "string" || !keys.includes(r.key) || out.some((o) => o.key === r.key)) continue;
    out.push({
      key: r.key,
      label: typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, 40) : pipelineDefaultLabel(kind, r.key),
      hidden: LOCKED[kind].includes(r.key) ? false : !!r.hidden,
      requiredFields: kind === "lead" && Array.isArray(r.requiredFields) ? r.requiredFields.filter((x): x is string => typeof x === "string").slice(0, 10) : [],
      targetDays: typeof r.targetDays === "number" && r.targetDays > 0 ? Math.min(365, Math.round(r.targetDays)) : null,
    });
  }
  for (const k of keys) if (!out.some((o) => o.key === k)) out.push({ key: k, label: pipelineDefaultLabel(kind, k), hidden: false, requiredFields: [], targetDays: null });
  return out;
}

export const pipelineUpdateSchema = z.object({
  stages: z
    .array(
      z.object({
        key: z.string().min(1).max(40),
        label: z.string().trim().min(1, "Every stage needs a name").max(40),
        hidden: z.boolean().default(false),
        requiredFields: z.array(z.string().max(60)).max(10).default([]),
        targetDays: z.number().int().min(1).max(365).nullable().default(null),
      }),
    )
    .min(1)
    .max(30),
});
export type PipelineUpdate = z.input<typeof pipelineUpdateSchema>;

/** Labels for a pipeline, for screens: key → name. */
export const pipelineLabelMap = (stages: PipelineStage[]) => Object.fromEntries(stages.map((s) => [s.key, s.label])) as Record<string, string>;
