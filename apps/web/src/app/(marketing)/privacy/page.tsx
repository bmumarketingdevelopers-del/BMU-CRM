import { DATA_REQUEST_DAYS, PRIVACY_NOTICE, PRIVACY_NOTICE_VERSION } from "@bmu/shared";
import { PrivacyRequestForm } from "./request-form";

export const metadata = { title: "Privacy notice | BMU Marketing" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12">
      <h1 className="font-display text-3xl">Privacy notice</h1>
      <p className="mt-2 text-ink-muted">
        How BMU Marketing uses your personal data, under India&apos;s Digital Personal Data Protection Act, 2023. Version {PRIVACY_NOTICE_VERSION}.
      </p>

      <h2 className="mt-10 text-lg font-semibold">What we keep, why, and for how long</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] border border-border bg-surface-raised text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
              <th className="px-3 py-2">Data</th>
              <th className="px-3 py-2">Why</th>
              <th className="px-3 py-2">How long</th>
            </tr>
          </thead>
          <tbody>
            {PRIVACY_NOTICE.map((r) => (
              <tr key={r.data} className="border-b border-border align-top">
                <td className="px-3 py-2">{r.data}</td>
                <td className="px-3 py-2">{r.purpose}</td>
                <td className="px-3 py-2">{r.kept}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-lg font-semibold">Your rights</h2>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
        <li>Ask for a copy of the personal data we hold about you.</li>
        <li>Ask us to correct or complete it.</li>
        <li>Ask us to delete it, unless the law makes us keep it (for example invoices for GST).</li>
        <li>Withdraw consent for marketing or WhatsApp updates at any time. Withdrawing is as easy as giving it.</li>
        <li>Complain to the Data Protection Board of India if you are not happy with our answer.</li>
      </ul>
      <p className="mt-3 text-sm text-ink-muted">We answer every request within {DATA_REQUEST_DAYS} days.</p>

      <h2 className="mt-10 text-lg font-semibold">Make a request</h2>
      <div className="mt-3">
        <PrivacyRequestForm />
      </div>
    </main>
  );
}
