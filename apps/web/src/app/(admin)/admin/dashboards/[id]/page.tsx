import { DashboardEditor } from "@/components/dashboards/editor";

export const metadata = { title: "Edit dashboard | BMU Hub" };

export default async function EditDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DashboardEditor id={id} />;
}
