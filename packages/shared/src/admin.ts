import { z } from "zod";
import { ACCESS_SCOPES } from "./auth.js";

export const inviteUserSchema = z.object({
  name: z.string().trim().min(2),
  email: z.email().optional(),
  phone: z.string().trim().optional(),
  roleId: z.string(),
  departmentId: z.string().optional(),
  teamId: z.string().optional(),
  managerId: z.string().optional(),
  branchId: z.string().optional(),
  specialty: z.string().trim().toLowerCase().regex(/^[a-z][a-z_]{1,39}$/, "Pick a job role from the list").nullable().optional(),
}).refine((v) => v.email || v.phone, { message: "Give an email or phone", path: ["email"] });
export type InviteUser = z.infer<typeof inviteUserSchema>;

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).optional(),
  roleId: z.string().optional(),
  departmentId: z.string().nullable().optional(),
  teamId: z.string().nullable().optional(),
  managerId: z.string().nullable().optional(),
  branchId: z.string().nullable().optional(),
  status: z.enum(["invited", "active", "suspended"]).optional(),
  specialty: z.string().trim().toLowerCase().regex(/^[a-z][a-z_]{1,39}$/, "Pick a job role from the list").nullable().optional(),
});
export type UpdateUser = z.infer<typeof updateUserSchema>;

export const setPermissionSchema = z.object({
  capability: z.string(),
  scope: z.enum(ACCESS_SCOPES),
});

export const cloneRoleSchema = z.object({ name: z.string().trim().min(2) });

export const setTierPriceSchema = z.object({
  serviceKey: z.string(),
  tier: z.enum(["starter", "growth", "premium"]),
  priceRupees: z.number().int().positive(),
});

/** v10: bundle saving and add-on prices are also versioned in the price book. */
export const setBundleDiscountSchema = z.object({ discountPct: z.number().int().min(0).max(50) });
export const addOnInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    priceRupees: z.number().int().min(0).max(10_000_000).nullable(),
    unit: z.string().trim().max(40).nullable().optional(),
    isCustomQuote: z.boolean().default(false),
  })
  .refine((v) => v.isCustomQuote || v.priceRupees !== null, { message: "Enter a price or tick custom quote", path: ["priceRupees"] });
export type AddOnInput = z.input<typeof addOnInputSchema>;

export type OrgUser = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  type: string;
  status: string;
  managerId: string | null;
  departmentId: string | null;
  teamId: string | null;
  branchId: string | null;
  specialty?: string | null;
  roles: { id: string; name: string; baseRole: string }[];
};

export type OrgTree = {
  branches: {
    id: string;
    name: string;
    city: string;
    departments: {
      id: string;
      name: string;
      teams: { id: string; name: string }[];
    }[];
  }[];
  users: OrgUser[];
};

export type RoleWithPermissions = {
  id: string;
  name: string;
  baseRole: string;
  isCustom: boolean;
  permissions: { capability: string; scope: string; rule: string }[];
};
