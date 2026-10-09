import { hierarchyData } from "./data/hierarchy.js";

export { hierarchyData };

export type TeamRoleId = (typeof hierarchyData.team_roles)[number]["id"];
export type ClientRoleId = (typeof hierarchyData.client_roles)[number]["id"];
export type RoleId = TeamRoleId | ClientRoleId;

export const TEAM_ROLES = hierarchyData.team_roles.map((r) => r.id) as TeamRoleId[];
export const CLIENT_ROLES = hierarchyData.client_roles.map((r) => r.id) as ClientRoleId[];
export const DEPARTMENTS = hierarchyData.departments;

export const isClientRole = (role: string): role is ClientRoleId =>
  (CLIENT_ROLES as string[]).includes(role);
