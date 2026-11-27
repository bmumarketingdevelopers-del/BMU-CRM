"use client";

import { useActionsMaybe } from "@/components/actions/actions-provider";

/**
 * Flow templates and QC checklists: Founders and Branch Managers publish straight away; department heads' saves go to
 * a Branch Manager to approve (v11).
 */
export function useCanPublish() {
  const me = useActionsMaybe()?.me;
  return !me || me.roles.some((r) => r === "founder" || r === "admin");
}
