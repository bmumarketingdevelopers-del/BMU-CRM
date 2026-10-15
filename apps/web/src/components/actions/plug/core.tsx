// "+ New" entries built by core: Task, Note (client notes from the Manager workspace) and Meeting (v23: a real meeting).
import { canOpenCraftManager, coreCanAddTask, opsCanAddLead } from "@bmu/shared";
import type { NewEntry } from "../new-registry";
import { ClientNoteDrawer } from "../client-note-drawer";
import { MeetingDrawer } from "../meeting-drawer";
import { TaskDrawer } from "../tasks/task-drawer";

export const coreNewEntries: NewEntry[] = [
  { id: "task", label: "Task", hint: "For a client or internal", allowed: (me) => coreCanAddTask(me), Drawer: TaskDrawer },
  { id: "note", label: "Note", hint: "On a client's record", allowed: (me) => me.type === "staff" && (canOpenCraftManager(me) || opsCanAddLead(me)), Drawer: (p) => <ClientNoteDrawer {...p} kind="note" /> },
  // v23: a real meeting (on Meetings, with a Google Meet link), not a client note with a reminder.
  { id: "meeting", label: "Meeting", hint: "With a Google Meet link", allowed: (me) => me.type === "staff" && (canOpenCraftManager(me) || opsCanAddLead(me)), Drawer: MeetingDrawer },
];
