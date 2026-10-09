import { DocScreen } from "@/components/comms/doc-editor";

export default async function ClientDocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocScreen id={id} backHref="/client/docs" team={false} />;
}
