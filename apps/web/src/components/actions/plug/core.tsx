// "+ New" entries built by core: Task, Note and Meeting (client notes from the Manager workspace).
import { canOpenCraftManager, coreCanAddTask, opsCanAddLead } from "@bmu/shared";
import type { NewEntry } from "../new-registry";
import { ClientNoteDrawer } from "../client-note-drawer";
import { TaskDrawer } from "../tasks/task-drawer";

export const coreNewEntries: NewEntry[] = [
  { id: "task", label: "Task", hint: "For a client or internal", allowed: (me) => coreCanAddTask(me), Drawer: TaskDrawer },
  { id: "note", label: "Note", hint: "On a client's record", allowed: (me) => me.type === "staff" && (canOpenCraftManager(me) || opsCanAddLead(me)), Drawer: (p) => <ClientNoteDrawer {...p} kind="note" /> },
  { id: "meeting", label: "Meeting", hint: "With a reminder", allowed: (me) => me.type === "staff" && (canOpenCraftManager(me) || opsCanAddLead(me)), Drawer: (p) => <ClientNoteDrawer {...p} kind="meeting" /> },
];
