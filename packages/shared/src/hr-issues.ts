import { z } from "zod";

/**
 * v50 Raise an issue with HR: any team member can bring a concern to HR. Confidential: only the person who raised it
 * and the HR team see it (not their manager, Department Head or leadership).
 */
export const HR_ISSUE_CATEGORIES = {
  workplace: "Workplace or team",
  conduct: "Behaviour or harassment",
  pay: "Pay, leave or attendance",
  workload: "Workload or stress",
  facilities: "Office, equipment or tools",
  other: "Something else",
} as const;
export type HrIssueCategory = keyof typeof HR_ISSUE_CATEGORIES;

export const HR_ISSUE_STATUSES = { open: "Open", in_progress: "HR is looking into it", resolved: "Resolved" } as const;
export type HrIssueStatus = keyof typeof HR_ISSUE_STATUSES;

export const hrIssueSchema = z.object({
  category: z.enum(Object.keys(HR_ISSUE_CATEGORIES) as [HrIssueCategory, ...HrIssueCategory[]]),
  subject: z.string().trim().min(3, "Give it a short title").max(120),
  details: z.string().trim().min(10, "Tell HR a little more (at least 10 characters)").max(4000),
});
export type HrIssueInput = z.infer<typeof hrIssueSchema>;

export const hrIssueUpdateSchema = z
  .object({
    status: z.enum(Object.keys(HR_ISSUE_STATUSES) as [HrIssueStatus, ...HrIssueStatus[]]).optional(),
    response: z.string().trim().max(4000).optional(),
  })
  .refine((v) => v.status !== undefined || v.response !== undefined, { message: "Change the status or write a reply" });
export type HrIssueUpdate = z.infer<typeof hrIssueUpdateSchema>;

export type HrIssueView = {
  id: string;
  category: HrIssueCategory;
  subject: string;
  details: string;
  status: HrIssueStatus;
  /** HR's reply to the person. */
  response: string | null;
  handledBy: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Who raised it: only in HR's list. */
  from?: { id: string; name: string; department: string | null };
};
