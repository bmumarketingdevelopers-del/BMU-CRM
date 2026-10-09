import { InboxScreen } from "@/components/comms/inbox";

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  return <InboxScreen initialId={c ?? null} />;
}
