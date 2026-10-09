import { TestPost } from "./test-post";

export const metadata = { title: "Test account post | BMU Hub", robots: { index: false } };

export default async function TestAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-10">
      <TestPost id={id} />
    </main>
  );
}
