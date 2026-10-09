import { ClientsList } from "@/components/clients/clients-list";
import { PageTitle } from "@/components/ui";

export const metadata = { title: "Clients | BMU Hub" };

export default function ClientsPage() {
  return (
    <>
      <PageTitle title="Client 360" subtitle="Every client account: add one by hand, migrate an existing client, or open one to see its services, work, requests, money and history together." />
      <ClientsList />
    </>
  );
}
