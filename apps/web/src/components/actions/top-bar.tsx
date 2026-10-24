"use client";

/** Slim bar above every team/Command Centre page: the "Needs you" approvals count. ("+ New" lives at the top of the sidebar.) */
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useActions } from "./actions-provider";

export function TopBar() {
  const { version } = useActions();
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let live = true;
    api.actions.approvals
      .count()
      .then((r) => live && setPending(r.pending))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [version]);
  if (pending <= 0) return null;
  return (
    <div className="-mt-3 mb-5 flex items-center justify-end gap-3 md:-mt-5">
      <Link href="/team/approvals" className="flex items-center gap-1.5 border border-border px-2.5 py-1 text-xs hover:border-ink" data-testid="needs-you-link">
        Needs you <span className="bg-green px-1.5 font-semibold text-charcoal">{pending}</span>
      </Link>
    </div>
  );
}
