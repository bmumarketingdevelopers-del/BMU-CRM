import { EnquiryForm } from "./enquiry-form";

export const metadata = { title: "Book a discovery call | BMU Marketing" };

export default function EnquiryPage() {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-12">
      <h1 className="font-display text-3xl">Book a discovery call</h1>
      <p className="mt-2 mb-8 text-ink-muted">Tell us about your business. We&apos;ll call you within one working day.</p>
      <EnquiryForm />
    </main>
  );
}
