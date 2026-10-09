import { ClientsList } from "@/components/clients/clients-list";
import { PageTitle } from "@/components/ui";

export const metadata = { title: "Clients | BMU Hub" };

export default function ClientsPage() {
  return (
    <>
      <PageTitle title="Clients" subtitle="Every client with its services, Account Manager and milestones. Add, migrate, import, tag or archive from here." />
      <ClientsList />
    </>
  );
}
