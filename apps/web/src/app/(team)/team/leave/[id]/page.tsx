import { redirect } from "next/navigation";

/** Leave links (cover reminders) open the cover page for that leave. */
export default async function LeavePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/team/leave/${id}/cover`);
}
