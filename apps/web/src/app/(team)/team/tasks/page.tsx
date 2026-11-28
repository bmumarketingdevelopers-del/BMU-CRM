import { inRedesignPreview, requireMe } from "@/lib/session";
import { TasksWorkspace } from "./tasks-workspace";

export const metadata = { title: "Tasks | BMU Hub" };

/**
 * Tasks: everything assigned to me or visible to me, as a board or list, with the shared actions (v11 core).
 * v54: people in the redesign preview get the new look; everyone else keeps the original.
 */
export default async function TasksPage() {
  const me = await requireMe(["staff"]);
  return <TasksWorkspace redesign={inRedesignPreview(me)} />;
}
