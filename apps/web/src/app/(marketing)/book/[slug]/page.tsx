import { PublicBooking } from "./public-booking";

export const metadata = { title: "Book a call | BMU Marketing", robots: { index: false } };

export default async function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10">
      <PublicBooking slug={slug} />
    </main>
  );
}
