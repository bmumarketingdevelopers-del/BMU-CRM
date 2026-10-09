import { TaskDetailView } from "./task-detail";

export const metadata = { title: "Task | BMU Hub" };

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TaskDetailView id={id} />;
}
