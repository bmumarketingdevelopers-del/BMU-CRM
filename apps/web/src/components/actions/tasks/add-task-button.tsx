"use client";

/**
 * AddTaskButton: contextual "+ Add task" for any page (Client 360, project, deliverable, calendar day, message).
 * Renders nothing for people who can't add tasks. Pre-fills the drawer from where it is used.
 *
 *   <AddTaskButton prefill={{ engagementId, deliverableId }} onSaved={reload} />
 */
import { useActionsMaybe } from "../actions-provider";
import type { NewPrefill } from "../new-registry";

export function AddTaskButton({ prefill, onSaved, label = "+ Add task", className }: { prefill?: NewPrefill; onSaved?: (id?: string) => void; label?: string; className?: string }) {
  const actions = useActionsMaybe();
  if (!actions?.canNew("task")) return null;
  return (
    <button type="button" onClick={() => actions.openNew("task", prefill, onSaved)} className={className ?? "border border-border bg-surface-raised px-3 py-1.5 text-sm hover:border-ink"} data-testid="add-task-here">
      {label}
    </button>
  );
}
