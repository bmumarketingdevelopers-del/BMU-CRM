import { PageTitle } from "@/components/ui";
import { FilesBrowser } from "@/components/ops/files-browser";

export const metadata = { title: "Files | BMU Hub" };

export default function TeamFilesPage() {
  return (
    <>
      <PageTitle title="Files" subtitle="Client files by folder. Finals reach the client only when released after Gate 5." />
      <FilesBrowser />
    </>
  );
}
