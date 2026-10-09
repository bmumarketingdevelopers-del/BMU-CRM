import { TasksWorkspace } from "./tasks-workspace";

export const metadata = { title: "Tasks | BMU Hub" };

/** Tasks: everything assigned to me or visible to me, as a board or list, with the shared actions (v11 core). */
export default function TasksPage() {
  return <TasksWorkspace />;
}
