import { PublicPay } from "@/components/money/public-pay";

export const metadata = { title: "Pay invoice | BMU Marketing", robots: { index: false } };

export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10">
      <PublicPay token={token} />
    </main>
  );
}
