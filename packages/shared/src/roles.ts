import { hierarchyData } from "./data/hierarchy.js";

export { hierarchyData };

export type TeamRoleId = (typeof hierarchyData.team_roles)[number]["id"];
export type ClientRoleId = (typeof hierarchyData.client_roles)[number]["id"];
export type RoleId = TeamRoleId | ClientRoleId;

export const TEAM_ROLES = hierarchyData.team_roles.map((r) => r.id) as TeamRoleId[];
export const CLIENT_ROLES = hierarchyData.client_roles.map((r) => r.id) as ClientRoleId[];
export const DEPARTMENTS = hierarchyData.departments;

/**
 * The name to show for a role id ("admin" -> "Branch Manager", "producer" -> "Producer"). Never show role ids to people.
 * Anything that is not a role id (e.g. a role's own name, or a custom role) is returned as it is.
 */
export function roleLabel(role: string): string {
  const def = [...hierarchyData.team_roles, ...hierarchyData.client_roles].find((r) => r.id === role);
  return def ? def.name.replace(/\s*\(.*\)$/, "") : role;
}

export const isClientRole = (role: string): role is ClientRoleId =>
  (CLIENT_ROLES as string[]).includes(role);
