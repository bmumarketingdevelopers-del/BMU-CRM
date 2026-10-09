import { AgreementDocument } from "./agreement-document";

export const metadata = { title: "Service agreement | BMU Marketing", robots: { index: false } };

export default async function AgreementPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 print:max-w-none print:p-0">
      <AgreementDocument token={token} />
    </main>
  );
}
