// The role line shown under a person's name. "Producer" is a permission level, not a job, so it is never shown:
// people see their job (specialty) instead, or their department when no job is set.
import { craftSpecialtyLabel } from "./craft-flows.js";
import { hierarchyData } from "./data/hierarchy.js";
import { roleLabel } from "./roles.js";

/** A role as the API sends it ({ name, baseRole }) or a bare base-role id ("producer"). */
export type RoleLike = string | { name: string; baseRole: string };

const RANK = new Map<string, number>(hierarchyData.team_roles.map((r) => [r.id, r.rank]));

/** What a producer is shown as: their job ("Developer"), else their department ("SEO"), else "Team member". */
export function producerJob(who: { specialty?: string | null; department?: string | null }): string {
  return craftSpecialtyLabel(who.specialty) || who.department?.trim() || "Team member";
}

/**
 * A person's roles for display, most senior first, with the built-in Producer role replaced by their job:
 * "Department Head + Developer". Custom roles (e.g. "SEO Executive") keep their own name.
 */
export function personRoleTitle(roles: readonly RoleLike[], who: { specialty?: string | null; department?: string | null } = {}): string {
  const rows = roles.map((r) => (typeof r === "string" ? { name: roleLabel(r), baseRole: r } : r));
  const sorted = [...rows].sort((a, b) => (RANK.get(a.baseRole) ?? 99) - (RANK.get(b.baseRole) ?? 99));
  const names = sorted.map((r) => (r.baseRole === "producer" && /^Producer\b/.test(r.name) ? producerJob(who) : r.name.replace(/\s*\(.*\)\s*$/, "")));
  return [...new Set(names)].join(" + ");
}
