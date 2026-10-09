"use client";

import { Panel } from "@/components/dash";
import { SlaList } from "@/components/deliver/sla-list";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

/** "Delivery deadlines to watch" from My Day, for homes that don't show the full My Day panel (Manager workspace). */
export function DeliveryDeadlinesPanel({ className = "mt-8" }: { className?: string }) {
  const day = useLoad(() => api.myDay.get());
  const items = day.data?.deliverSla ?? [];
  if (!items.length) return null;
  return (
    <Panel
      className={className}
      title="Delivery deadlines to watch"
      subtitle={`${items.filter((i) => i.state === "overdue").length} late, ${items.filter((i) => i.state === "at_risk").length} due within a working day. Steps more than a working day late go to the department head.`}
    >
      <SlaList items={items} limit={8} />
    </Panel>
  );
}
