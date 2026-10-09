import Link from "next/link";
import { formatINR } from "@bmu/shared";
import { getServices } from "@/lib/api";

export const metadata = { title: "Services | BMU Marketing" };

// Re-read the catalogue from the API at most once a minute.
export const revalidate = 60;

const billingLabel: Record<string, string> = { monthly: "/ month", one_time: "one time", per_unit: "per unit" };

export default async function ServicesPage() {
  const { data, live } = await getServices();
  const tracks = Map.groupBy(data, (s) => s.track);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
      <h1 className="font-display text-3xl">Services</h1>
      <p className="mt-2 text-ink-muted">All prices exclude GST (18%), which is shown separately on every invoice.</p>
      {!live && (
        <p className="mt-4 border border-amber bg-amber/20 px-4 py-2 text-sm">
          Showing the built-in 2026 catalogue because the API isn&apos;t running. Start it with{" "}
          <code>pnpm dev</code>.
        </p>
      )}

      {[...tracks.entries()].map(([track, list]) => (
        <section key={track} id={encodeURIComponent(track)} className="mt-12">
          <h2 className="text-xl font-semibold">{track}</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse bg-surface-raised text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                  <th className="px-4 py-2">Service</th>
                  <th className="px-4 py-2">Starter</th>
                  <th className="px-4 py-2">Growth</th>
                  <th className="px-4 py-2">Premium</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id} className="border-b border-border">
                    <td className="px-4 py-3 font-medium">{s.name}</td>
                    {["starter", "growth", "premium"].map((tier) => {
                      const t = s.tiers.find((x) => x.tier === tier);
                      return (
                        <td key={tier} className="px-4 py-3">
                          {t ? formatINR(t.pricePaise) : "-"}{" "}
                          <span className="text-ink-muted">{billingLabel[s.billingType]}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <Link href="/enquiry" className="mt-12 inline-block bg-green px-6 py-3 font-semibold text-charcoal">
        Get a proposal
      </Link>
    </main>
  );
}
