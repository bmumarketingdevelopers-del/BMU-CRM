import { PublicProposal } from "./public-proposal";

export const metadata = { title: "Your proposal | BMU Marketing", robots: { index: false } };

export default async function ProposalLinkPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ preview?: string }> }) {
  const { token } = await params;
  const { preview } = await searchParams;
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <PublicProposal token={token} preview={preview === "1"} />
    </main>
  );
}
