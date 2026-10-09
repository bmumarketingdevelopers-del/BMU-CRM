import { z } from "zod";
import type { DeliverApprovalStatus } from "./deliver-flows.js";

export const REQUIREMENT_STATUSES = ["pending", "received", "blocked", "waiting"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export type RequirementItemView = {
  id: string;
  label: string;
  type: string;
  status: RequirementStatus;
  blockedReason: string | null;
  waitingFor: string | null;
  dateRequested: string;
  /** Latest note or link the client sent for this item (team view only). */
  clientNote?: string | null;
};

export const updateRequirementSchema = z
  .object({
    status: z.enum(REQUIREMENT_STATUSES),
    blockedReason: z.string().trim().min(3).optional(),
    waitingFor: z.string().trim().optional(),
  })
  .refine((v) => v.status !== "blocked" || !!v.blockedReason, {
    message: "Every blocked item needs a documented reason",
    path: ["blockedReason"],
  });

export const clientSubmitRequirementSchema = z.object({ note: z.string().trim().min(1, "Add a note or link").max(2000) });

export const planDeliverableSchema = z.object({
  type: z.string().trim().min(2),
  title: z.string().trim().min(2),
  due: z.string().optional(),
});

export const planContentSchema = z.object({
  objectives: z.string().trim().default(""),
  audience: z.string().trim().default(""),
  pillars: z.array(z.string().trim().min(1)).default([]),
  creativeDirection: z.string().trim().default(""),
  deliverables: z.array(planDeliverableSchema).default([]),
});
export type PlanContent = z.infer<typeof planContentSchema>;

export const PLAN_STATUSES = ["draft", "internal_review", "sent_to_client", "changes_requested", "approved"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const planStatusLabels: Record<PlanStatus, string> = {
  draft: "Draft",
  internal_review: "Internal review",
  sent_to_client: "With client",
  changes_requested: "Changes requested",
  approved: "Approved (locked)",
};

export type PlanView = {
  id: string;
  status: PlanStatus;
  content: PlanContent;
  approvedAt: string | null;
  approvedBy: string | null;
  clientComments: { body: string; at: string; author: string }[];
  /** v10: client approval rule progress (who approved, who is pending). */
  approvalStatus?: DeliverApprovalStatus | null;
};

export type EngagementDetail = {
  id: string;
  client: { id: string; name: string };
  serviceName: string;
  tier: string;
  billingType: string;
  status: string;
  currentGate: string;
  am: { id: string; name: string } | null;
  cycle: {
    id: string;
    period: string;
    rcdAt: string | null;
    planningDue: string | null;
    requirements: RequirementItemView[];
  } | null;
  plan: PlanView | null;
  deliverables: { id: string; type: string; title: string; status: string; dueAt?: string | null; scheduledAt?: string | null }[];
  can: { markRcd: boolean; editPlan: boolean; approvePlanInternally: boolean; sendPlan: boolean };
};

export type ClientPlanView = {
  engagementId: string;
  serviceName: string;
  plan: PlanView;
  /** v10: this person already approved the current round (others still pending). */
  youApproved?: boolean;
  /** v10: monthly retainer period this plan is for ("2026-11"), or "project". */
  period?: string;
};

export type ClientOnboarding = {
  engagements: { id: string; serviceName: string; rcdAt: string | null; requirements: RequirementItemView[] }[];
};

export type EngagementRow = {
  id: string;
  client: { id: string; name: string };
  serviceName: string;
  tier: string;
  status: string;
  currentGate: string;
  am: { id: string; name: string } | null;
  requirementsOutstanding: number;
  rcdAt: string | null;
  planningDue: string | null;
  planStatus: PlanStatus | null;
  /** v10 delivery SLA: deliverables past due / due within a working day. */
  slaOverdue?: number;
  slaAtRisk?: number;
  billingType?: string;
  period?: string | null;
};
