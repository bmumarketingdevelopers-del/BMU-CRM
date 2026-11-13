import { z } from "zod";

/**
 * v51 Custom charts: extra org charts built from existing team members, apart from the real hierarchy (e.g. "Diwali
 * campaign team" or "North region"). People sit under people, any depth, with an optional label. Chart only: a custom
 * chart never changes anyone's manager, department, approvals, daily reports, alerts or access.
 */
export const orgChartInputSchema = z.object({
  name: z.string().trim().min(2, "Give the chart a name").max(80),
  description: z.string().trim().max(300).optional().nullable(),
  /** "reporting": start from a copy of today's reporting lines (everyone in the team), then rearrange. */
  startFrom: z.enum(["empty", "reporting"]).default("empty"),
});
export type OrgChartInput = z.input<typeof orgChartInputSchema>;

export const orgChartUpdateSchema = z
  .object({
    name: z.string().trim().min(2, "Give the chart a name").max(80).optional(),
    description: z.string().trim().max(300).optional().nullable(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, { message: "Change the name or the description" });
export type OrgChartUpdate = z.infer<typeof orgChartUpdateSchema>;

const label = z.string().trim().max(60).optional().nullable();

export const orgChartAddSchema = z.object({
  userId: z.string().min(1, "Pick a person"),
  /** Who they sit under in this chart; null puts them at the top. */
  parentUserId: z.string().min(1).nullable().default(null),
  label,
});
export type OrgChartAdd = z.input<typeof orgChartAddSchema>;

export const orgChartMemberUpdateSchema = z
  .object({
    parentUserId: z.string().min(1).nullable().optional(),
    label,
  })
  .refine((v) => v.parentUserId !== undefined || v.label !== undefined, { message: "Move them or change their label" });
export type OrgChartMemberUpdate = z.infer<typeof orgChartMemberUpdateSchema>;

export type OrgChartSummary = {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  /** The people at the top of the chart. */
  top: string[];
  createdBy: string | null;
  updatedAt: string;
};

export type OrgChartList = { charts: OrgChartSummary[]; canEdit: boolean };

export type OrgChartMember = {
  userId: string;
  name: string;
  photoUrl: string | null;
  /** Their job in the real hierarchy, e.g. "Department Head + Developer". */
  title: string;
  department: string | null;
  parentUserId: string | null;
  label: string | null;
  /** Left the company or was removed: still shown so the chart keeps its shape until someone tidies it. */
  former: boolean;
};

export type OrgChartView = {
  id: string;
  name: string;
  description: string | null;
  createdBy: string | null;
  updatedAt: string;
  members: OrgChartMember[];
  canEdit: boolean;
};

/** Everyone under `userId` in a chart (to stop someone being moved under their own reports). */
export function orgChartDescendants(members: { userId: string; parentUserId: string | null }[], userId: string): Set<string> {
  const out = new Set<string>();
  const stack = [userId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const m of members) {
      if (m.parentUserId === id && !out.has(m.userId)) {
        out.add(m.userId);
        stack.push(m.userId);
      }
    }
  }
  return out;
}
