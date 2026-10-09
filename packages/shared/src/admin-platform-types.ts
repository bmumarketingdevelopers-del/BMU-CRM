// Command Centre → Operations and Platform: SOP library, error log, integrations, data export/deletion.
import { z } from "zod";

// ---------------------------------------------------------------------------
// SOP library

export type SopView = {
  id: string;
  title: string;
  body: string;
  version: number;
  department: { id: string; name: string };
  /** Whether the signed-in user may edit this SOP. */
  canEdit: boolean;
  /** v10: drafts are only visible to editors until published. */
  status?: "draft" | "published";
  /** v10: team members who acknowledged the current version ("I have read this"). */
  acknowledged?: number;
};

export type SopMeta = {
  departments: { id: string; name: string; count: number }[];
  /** Whether the signed-in user may create SOPs (in at least one department). */
  canCreate: boolean;
  /** Department ids the user may create/edit in (all for Founder/Admin). */
  editableDepartmentIds: string[];
};

export const sopInputSchema = z.object({
  title: z.string().trim().min(3, "Give the SOP a title").max(160),
  body: z.string().trim().min(10, "Write the steps (at least a sentence)").max(40000),
  departmentId: z.string().min(1, "Pick a department"),
  /** v10: save as a draft (only editors see it) or publish to the team library. Defaults to published. */
  status: z.enum(["draft", "published"]).optional(),
});
export type SopInput = z.infer<typeof sopInputSchema>;

// ---------------------------------------------------------------------------
// Error log ("5-why" style)

export const ERROR_CAUSES = ["process", "communication", "skill", "tool", "client_input", "capacity", "other"] as const;
export type ErrorCause = (typeof ERROR_CAUSES)[number];
export const errorCauseLabels: Record<ErrorCause, string> = {
  process: "Missing or unclear process",
  communication: "Communication gap",
  skill: "Skill or training",
  tool: "Tool or software",
  client_input: "Client input",
  capacity: "Workload / capacity",
  other: "Other",
};

const optText = z.string().trim().max(4000).optional().nullable();
export const errorLogInputSchema = z.object({
  what: z.string().trim().min(5, "Describe what went wrong").max(1000),
  why: optText,
  foundBy: z.string().trim().max(120).optional().nullable(),
  impact: optText,
  fix: optText,
  prevention: optText,
  cause: z.enum(ERROR_CAUSES).optional().nullable(),
});
export type ErrorLogInput = z.infer<typeof errorLogInputSchema>;

export type ErrorLogView = {
  id: string;
  what: string;
  why: string | null;
  foundBy: string | null;
  impact: string | null;
  fix: string | null;
  prevention: string | null;
  cause: string | null;
  createdAt: string;
};

export type ErrorLogList = {
  rows: ErrorLogView[];
  /** Counts over all entries (not just the filtered rows). */
  stats: { cause: string; count: number }[];
  total: number;
  open: number; // entries without a prevention step yet
  canEdit: boolean;
};

// ---------------------------------------------------------------------------
// Access, integrations, data export / deletion, tenant

export type AdminPlatformAccess = {
  /** Requirement checklists, gate rules, SLA rules, SOPs. */
  operations: boolean;
  /** Notification templates, integrations, branding, data, tenant. */
  platform: boolean;
};

export type IntegrationKey = "razorpay" | "email" | "whatsapp" | "storage" | "accounting";
/** Booleans only: secret values are never sent to the browser. */
export type IntegrationStatus = { key: IntegrationKey; configured: boolean; usingDefault?: boolean; accountingTool?: string };

export type DataClientRow = {
  id: string;
  name: string;
  createdAt: string;
  users: number;
  activeUsers: number;
  anonymisedUsers: number;
  engagements: number;
  unpaidInvoices: number;
};
export type DataOverview = { clients: DataClientRow[]; retentionDays: number };

export const anonymiseSchema = z.object({ confirmName: z.string().trim().min(1, "Type the client name to confirm") });

export type ClientDataExport = {
  exportedAt: string;
  exportedBy: string;
  client: Record<string, unknown>;
  users: Record<string, unknown>[];
  engagements: Record<string, unknown>[];
  deliverables: Record<string, unknown>[];
  requests: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
};

export type TenantInfo = { plan: string; createdAt: string; clients: number; staff: number };
