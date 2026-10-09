import { ProofReview } from "./proof-review";

export const metadata = { title: "Review and approve | BMU Marketing", robots: { index: false } };

export default async function ProofPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <ProofReview token={token} />
    </main>
  );
}
