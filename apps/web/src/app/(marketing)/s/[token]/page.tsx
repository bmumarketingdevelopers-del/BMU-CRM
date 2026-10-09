import { SharedFile } from "./shared-file";

export const metadata = { title: "Shared file | BMU Marketing", robots: { index: false } };

export default async function SharedFilePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-12">
      <SharedFile token={token} />
    </main>
  );
}
