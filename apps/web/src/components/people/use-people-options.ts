"use client";

import { useEffect, useState } from "react";
import type { PeopleOptions } from "@bmu/shared";
import { api } from "@/lib/api";

/** Form options for people actions (roles with what I may give, departments, teams, branches, staff…). */
export function usePeopleOptions(enabled = true) {
  const [opts, setOpts] = useState<PeopleOptions>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.peopleActions
      .options()
      .then((o) => live && setOpts(o))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [enabled]);
  return { opts, error };
}

export const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export const fmtDay = (ymd: string | null | undefined) => (ymd ? new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
