import { z } from "zod";
import { workflowData } from "./data/workflow.js";

export const LEAD_STAGES = workflowData.state_machines.lead;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const leadStageLabels: Record<LeadStage, string> = {
  new: "New",
  contacted: "Contacted",
  discovery: "Discovery",
  proposal_sent: "Proposal sent",
  won: "Won",
  lost: "Lost",
};

export const leadUpdateSchema = z
  .object({
    stage: z.enum(LEAD_STAGES).optional(),
    ownerId: z.string().nullable().optional(),
    lostReason: z.string().trim().min(3).optional(),
  })
  .refine((v) => v.stage !== "lost" || !!v.lostReason, {
    message: "Give a reason when marking a lead lost",
    path: ["lostReason"],
  });
export type LeadUpdate = z.infer<typeof leadUpdateSchema>;

export type LeadRow = {
  id: string;
  source: string;
  contact: { name: string; email?: string; phone?: string; company?: string };
  need: string;
  budgetPaise: number | null;
  score: number;
  stage: LeadStage;
  owner: { id: string; name: string } | null;
  lostReason: string | null;
  serviceIds: string[];
  createdAt: string;
  // v10 sell
  nextFollowUpAt?: string | null;
  duplicateOfId?: string | null;
  lastActivityAt?: string | null;
  // v14: custom field values and when the lead entered its current stage
  customFields?: Record<string, string | number | boolean | null>;
  stageSince?: string | null;
};
