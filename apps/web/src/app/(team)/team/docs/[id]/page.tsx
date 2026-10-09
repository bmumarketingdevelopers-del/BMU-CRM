import { DocScreen } from "@/components/comms/doc-editor";

export default async function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocScreen id={id} backHref="/team/docs" team />;
}
