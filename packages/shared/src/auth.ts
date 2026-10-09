import { z } from "zod";
import type { Capability } from "./permissions.js";

export const ACCESS_SCOPES = ["none", "own", "team", "department", "branch", "all"] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

export const scopeRank = (s: AccessScope): number => ACCESS_SCOPES.indexOf(s);
export const widerScope = (a: AccessScope, b: AccessScope): AccessScope => (scopeRank(a) >= scopeRank(b) ? a : b);

/** Maps a free-text matrix rule ("own (logged)", "full (dept)", "branch"...) to a data scope. */
export function scopeFromRule(rule: string): AccessScope {
  if (rule === "none") return "none";
  if (rule.startsWith("own")) return "own";
  if (rule.includes("dept")) return "department";
  if (rule === "branch") return "branch";
  return "all";
}

export type PermissionMap = Partial<Record<Capability, { scope: AccessScope; rule: string }>>;

export type Me = {
  id: string;
  orgId: string;
  name: string;
  email: string | null;
  phone: string | null;
  type: "staff" | "client" | "creator";
  roles: string[]; // base role ids, e.g. ["founder"]
  permissions: PermissionMap;
  clientOrg: { id: string; name: string; role: string } | null;
  /** v10 craft: job function (video_editor, developer, …) that picks the specialist dashboard. */
  specialty?: string | null;
  /** v20: this sign-in's device session (Security → Where you're signed in). */
  sessionId?: string;
  /** v20: two-factor is required for this person's role and this session has not done it yet. */
  mustEnroll2fa?: boolean;
};

/** Lower-cases emails and turns Indian mobile numbers into +91XXXXXXXXXX. */
export function normaliseIdentifier(raw: string): string {
  const v = raw.trim();
  if (v.includes("@")) return v.toLowerCase();
  const digits = v.replace(/\D/g, "");
  return `+91${digits.slice(-10)}`;
}

export const otpRequestSchema = z.object({
  identifier: z
    .string()
    .trim()
    .refine((v) => z.email().safeParse(v).success || /^(\+?91)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, "")), {
      message: "Enter your email or 10-digit mobile number",
    }),
});

export const otpVerifySchema = otpRequestSchema.extend({
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

/** Where each kind of user lands after signing in. */
export function homePathFor(me: Pick<Me, "type" | "roles">): string {
  if (me.type === "client") return "/client";
  if (me.type === "creator") return "/creator";
  if (me.roles.some((r) => ["founder", "admin", "department_head"].includes(r))) return "/admin";
  return "/team";
}
