"use client";

/**
 * TaskRowMenu: the "⋯" on every task row, board card and the task page. Shows only what the person may do
 * (from task.can, worked out by the API) and greys out what a rule blocks, with the reason.
 *
 *   <TaskRowMenu task={row} onChanged={reload} />
 *
 * Also exports useTaskActionDialogs() for pages that trigger the same dialogs from their own buttons or shortcuts.
 */
import { useState } from "react";
import type { CoreTaskRow } from "@bmu/shared";
import { api } from "@/lib/api";
import { useActions } from "../actions-provider";
import { RowMenu, type RowMenuItem } from "../row-menu";
import { BlockedDialog, DeadlineDialog, DuplicateDialog, ReasonDialog } from "./task-dialogs";
import { TaskDrawer } from "./task-drawer";

type Dialog = "edit" | "deadline" | "blocked" | "archive" | "handback" | "duplicate" | null;

export function useTaskActionDialogs(task: CoreTaskRow | null | undefined, onChanged?: () => void) {
  const { openReassign, openNew, notify, changed } = useActions();
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);
  const done = (message: string, undo?: Parameters<typeof notify>[1]) => {
    close();
    notify(message, undo);
    changed();
    onChanged?.();
  };
  const t = task;
  const actions = t
    ? {
        edit: () => t.can.edit && !t.can.blocked.edit && setDialog("edit"),
        reassign: () => t.can.reassign && !t.can.blocked.reassign && openReassign({ type: "task", ids: [t.id], title: `Reassign “${t.title}”`, onDone: () => onChanged?.() }),
        deadline: () => t.can.deadline && !t.can.blocked.deadline && setDialog("deadline"),
        blocked: () => t.can.status && setDialog("blocked"),
        archive: () => t.can.archive && setDialog("archive"),
        handback: () => t.can.handback && setDialog("handback"),
        duplicate: () => t.can.duplicate && setDialog("duplicate"),
        subtask: () => t.can.addSubtask && openNew("task", { parentId: t.id, engagementId: t.engagementId ?? undefined, internal: t.isInternal ? "1" : undefined }, () => onChanged?.()),
        restore: async () => {
          try {
            const m = await api.coreTasks.restore(t.id);
            done(m.message ?? "Restored");
          } catch (e) {
            notify((e as Error).message, null, "error");
          }
        },
      }
    : null;

  const dialogs = t ? (
    <>
      {dialog === "edit" && <TaskDrawer open taskId={t.id} onClose={close} onSaved={(_id, message, undo) => done(message ?? "Saved", undo)} />}
      {dialog === "deadline" && t.can.deadline && <DeadlineDialog task={t} mode={t.can.deadline} onClose={close} onDone={(m, u) => done(m, u)} />}
      {dialog === "blocked" && <BlockedDialog task={t} onClose={close} onDone={(m, u) => done(m, u)} />}
      {dialog === "duplicate" && <DuplicateDialog task={t} onClose={close} onDone={(m, u) => done(m, u)} />}
      {dialog === "archive" && (
        <ReasonDialog
          title="Archive task"
          intro={`“${t.title}” leaves every list${t.subtaskCount ? ` with its ${t.subtaskCount} subtasks` : ""}. You can restore it from the Archived view.`}
          submitLabel="Archive"
          danger
          onClose={close}
          onSubmit={async (reason) => {
            const m = await api.coreTasks.archive(t.id, reason);
            done(m.message ?? "Archived", m.undo);
          }}
        />
      )}
      {dialog === "handback" && (
        <ReasonDialog
          title="Can't take this"
          intro="Your Department Head gets a request to give it to someone else. Keep working on it until they decide."
          label="Why can't you take it"
          submitLabel="Send to my manager"
          onClose={close}
          onSubmit={async (reason) => {
            const m = await api.coreTasks.handback(t.id, reason);
            done(m.message ?? "Sent to your manager", m.undo);
          }}
        />
      )}
    </>
  ) : null;

  return { actions, dialogs, dialog };
}

export function taskMenuItems(t: CoreTaskRow, a: NonNullable<ReturnType<typeof useTaskActionDialogs>["actions"]>, opts: { showOpen?: boolean } = {}): RowMenuItem[] {
  const archived = !!t.archivedAt;
  return [
    { key: "open", label: "Open", href: `/team/tasks/${t.id}`, hidden: !opts.showOpen },
    { key: "edit", label: "Edit", onSelect: a.edit, hidden: !t.can.edit || archived, disabledReason: t.can.blocked.edit, shortcut: "E" },
    { key: "reassign", label: t.owner ? "Reassign" : "Assign", onSelect: a.reassign, hidden: !t.can.reassign || archived, disabledReason: t.can.blocked.reassign, shortcut: "R" },
    { key: "deadline", label: t.can.deadline === "request" ? "Ask for a new deadline" : "Change deadline", onSelect: a.deadline, hidden: !t.can.deadline || archived, disabledReason: t.can.blocked.deadline, shortcut: "D" },
    { key: "blocked", label: "Mark blocked", onSelect: a.blocked, hidden: !t.can.status || archived || t.status === "blocked" || !(t.kind === "work" || t.kind === "planning") || ["done", "cancelled"].includes(t.status) },
    { key: "subtask", label: "Add subtask", onSelect: a.subtask, hidden: !t.can.addSubtask || archived },
    { key: "handback", label: "Can't take this", onSelect: a.handback, hidden: !t.can.handback },
    { key: "duplicate", label: "Duplicate", onSelect: a.duplicate, hidden: !t.can.duplicate, disabledReason: t.can.blocked.duplicate },
    { key: "history", label: "View history", href: `/team/tasks/${t.id}?tab=history` },
    { key: "restore", label: "Restore", onSelect: a.restore, hidden: !t.can.restore || !archived },
    { key: "archive", label: "Archive", onSelect: a.archive, hidden: !t.can.archive || archived, disabledReason: t.can.blocked.archive, danger: true },
  ];
}

export function TaskRowMenu({ task, onChanged, showOpen = true, align }: { task: CoreTaskRow; onChanged?: () => void; showOpen?: boolean; align?: "left" | "right" }) {
  const { actions, dialogs } = useTaskActionDialogs(task, onChanged);
  if (!actions) return null;
  return (
    <>
      <RowMenu label={`Actions for ${task.title}`} items={taskMenuItems(task, actions, { showOpen })} align={align} />
      {dialogs}
    </>
  );
}
