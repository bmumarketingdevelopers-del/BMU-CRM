import { permissionsData } from "./data/permissions.js";
import { isClientRole, type RoleId } from "./roles.js";

export { permissionsData };

export type Capability = keyof typeof permissionsData.matrix;
export const CAPABILITIES = Object.keys(permissionsData.matrix) as Capability[];

/**
 * Raw access rule for a role on a capability, straight from the permission matrix
 * (e.g. "full", "own", "none", "within discount_limit"). Falls back to the
 * matrix's "client_any" entry for client roles, then "others", then "none".
 * The backend enforces these; the UI only uses them to hide controls.
 */
export function accessRule(capability: Capability, role: RoleId): string {
  const row = permissionsData.matrix[capability] as Record<string, string>;
  return (
    row[role] ??
    (isClientRole(role) ? row["client_any"] : undefined) ??
    row["others"] ??
    "none"
  );
}

export const canAccess = (capability: Capability, role: RoleId): boolean =>
  accessRule(capability, role) !== "none";
