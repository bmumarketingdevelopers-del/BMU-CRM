"use client";

import Link from "next/link";
import { PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { WithData } from "../_parts/kit";
import { RuleBuilder } from "../_parts/rule-builder";

export default function NewAutomationPage() {
  const state = useLoad(() => api.automations.options());
  return (
    <>
      <PageTitle
        title="New automation"
        subtitle="Pick what starts it, narrow it down if you like, then choose what BMU Hub should do."
        action={
          <Link href="/admin/automations" className="text-sm text-ink-muted hover:text-ink">
            ← All automations
          </Link>
        }
      />
      <WithData state={state}>
        {(options) =>
          options.canManage ? (
            <RuleBuilder options={options} />
          ) : (
            <p className="border border-border bg-canvas/60 px-4 py-3 text-sm text-ink-muted">Only the Founder and Branch Managers can create automations.</p>
          )
        }
      </WithData>
    </>
  );
}
