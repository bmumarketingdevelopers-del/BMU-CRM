import { PageTitle } from "@/components/ui";
import { FilesBrowser } from "@/components/ops/files-browser";

export const metadata = { title: "Files | BMU Hub" };

// v35: ?shared=clients opens the files sent to and received from clients (the Founder's daily summary links here).
export default async function TeamFilesPage({ searchParams }: { searchParams: Promise<{ shared?: string }> }) {
  const { shared } = await searchParams;
  return (
    <>
      <PageTitle title="Files" subtitle="Every client file in one place: uploads, work for review, files shared in client chats, brand kits and assets. Finals reach the client only when released after Gate 5." />
      <FilesBrowser shared={shared === "clients" || shared === "to_client" || shared === "from_client" || shared === "internal" ? shared : ""} />
    </>
  );
}
