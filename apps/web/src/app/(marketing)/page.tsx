import Link from "next/link";
import { formatINR, groupServicesByTrack, rupeesToPaise } from "@bmu/shared";

// Copy and structure follow bmumarketing.in, set in a quiet, minimal layout.
const stats = [
  { value: "140+", label: "Brands launched" },
  { value: "₹38Cr", label: "Ad spend managed" },
  { value: "909", label: "Cities served" },
  { value: "4.9", label: "Average client rating" },
];

const products = [
  { name: "Smart Review", text: "Collect and answer reviews from one place, with QR at the counter." },
  { name: "BMU Creators", text: "Brief, book and pay creators, with every post tracked." },
  { name: "BMU AI Studio", text: "On-brand creative and copy, drafted fast and checked by people." },
  { name: "Real Estate Suite", text: "Launch pages, lead capture and site-visit follow-up for projects." },
  { name: "BMU QR", text: "Order the hardware, unlock the software: menus, reviews, offers." },
];

const industries = ["Real Estate", "Restaurants & Cafes", "Hotels & Resorts", "Hospitals & Clinics", "Schools & Colleges", "Ecommerce & D2C", "Automobile", "Fitness & Beauty"];

const faqs = [
  { q: "How does a project run?", a: "Five clear milestones: requirements, plan approval, production, your review, and final delivery. You see where things are at any time in the client app." },
  { q: "How do approvals work?", a: "You approve the plan and every draft in writing inside the app. Comments can be pinned to the exact spot on a design or the exact second of a video." },
  { q: "What if I need something extra?", a: "Raise an extra request. We send a clear quote, and nothing starts until you approve it." },
  { q: "How is billing handled?", a: "Monthly services are billed in advance; projects are 50% to start and 50% before handover. GST at 18% is always shown separately." },
];

export default function Home() {
  const tracks = [...groupServicesByTrack().entries()].map(([track, list]) => {
    const from = Math.min(...list.flatMap((s) => Object.values(s.tiers as Record<string, number>)));
    return { track, list, from };
  });

  return (
    <main className="flex-1">
      <section className="mx-auto max-w-6xl px-5 pt-20 pb-16 sm:pt-28">
        <p className="text-sm text-ink-muted">Performance marketing · Bengaluru</p>
        <h1 className="font-display mt-4 max-w-4xl text-4xl leading-[1.05] sm:text-6xl">
          Building smarter growth systems for performance marketing<span className="text-green">.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-ink-muted">
          Strategy, creative, AI, technology and performance together to turn attention into meaningful business growth.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Link href="/enquiry" className="bg-charcoal px-6 py-3 text-sm font-medium text-ivory hover:opacity-90">
            Book a free consultation
          </Link>
          <Link href="/services" className="border border-border px-6 py-3 text-sm font-medium hover:border-ink">
            See the work
          </Link>
        </div>
      </section>

      <section className="border-y border-border">
        <dl className="mx-auto grid max-w-6xl grid-cols-2 px-5 sm:grid-cols-4">
          {stats.map((s, i) => (
            <div key={s.label} className={`py-8 ${i % 2 ? "border-l border-border pl-6" : ""} ${i > 0 ? "sm:border-l sm:border-border sm:pl-8" : ""}`}>
              <dt className="text-sm text-ink-muted">{s.label}</dt>
              <dd className="font-display mt-1 text-3xl">{s.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-24">
        <SectionHead eyebrow="Services" title="Everything growth needs, under one roof" />
        <div className="mt-12 grid border-t border-border sm:grid-cols-2 lg:grid-cols-3 sm:gap-x-10">
          {tracks.map(({ track, list, from }) => (
            <Link key={track} href={`/services#${encodeURIComponent(track)}`} className="group border-b border-border py-6">
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="font-medium">{track}</h3>
                <span className="text-ink-muted transition-transform group-hover:translate-x-1">→</span>
              </div>
              <p className="mt-2 text-sm text-ink-muted">{list.map((s) => s.name).join(" · ")}</p>
              {Number.isFinite(from) && <p className="mt-3 text-xs text-ink-muted">From {formatINR(rupeesToPaise(from))}</p>}
            </Link>
          ))}
        </div>
      </section>

      <section id="products" className="bg-charcoal text-ivory">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <SectionHead eyebrow="Products" title="Tools built to keep growth moving, even after the campaign ends" dark />
          <div className="mt-12 grid gap-px bg-white/10 sm:grid-cols-2 lg:grid-cols-5">
            {products.map((p) => (
              <div key={p.name} className="bg-charcoal p-6">
                <h3 className="font-medium">{p.name}</h3>
                <p className="mt-2 text-sm text-grey">{p.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="industries" className="mx-auto max-w-6xl px-5 py-24">
        <SectionHead eyebrow="Industries" title="We already know your funnel" />
        <ul className="mt-10 flex flex-wrap gap-2">
          {industries.map((i) => (
            <li key={i} className="border border-border px-4 py-2 text-sm">
              {i}
            </li>
          ))}
        </ul>
      </section>

      <section className="border-t border-border">
        <div className="mx-auto grid max-w-6xl gap-12 px-5 py-24 lg:grid-cols-[1fr_2fr]">
          <SectionHead eyebrow="Pricing" title="Clear monthly pricing" />
          <div>
            <p className="max-w-xl text-ink-muted">Pick the services you need and see the exact monthly price, bundle savings and GST before you talk to anyone.</p>
            <Link href="/package-builder" className="mt-6 inline-block border-b border-ink pb-0.5 text-sm font-medium">
              Build your package →
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t border-border">
        <div className="mx-auto grid max-w-6xl gap-12 px-5 py-24 lg:grid-cols-[1fr_2fr]">
          <SectionHead eyebrow="FAQ" title="Clear answers for complex operations" />
          <div className="divide-y divide-border border-y border-border">
            {faqs.map((f) => (
              <details key={f.q} className="group py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                  {f.q}
                  <span className="text-ink-muted transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 max-w-2xl text-sm text-ink-muted">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-5 py-24 text-center">
          <h2 className="font-display mx-auto max-w-2xl text-3xl sm:text-4xl">Tell us what you&apos;re trying to grow</h2>
          <Link href="/enquiry" className="mt-8 inline-block bg-green px-6 py-3 text-sm font-semibold text-charcoal hover:brightness-95">
            Book a call
          </Link>
        </div>
      </section>
    </main>
  );
}

function SectionHead({ eyebrow, title, dark = false }: { eyebrow: string; title: string; dark?: boolean }) {
  return (
    <div>
      <p className={`text-xs uppercase tracking-[0.18em] ${dark ? "text-grey" : "text-ink-muted"}`}>{eyebrow}</p>
      <h2 className="font-display mt-3 max-w-xl text-2xl sm:text-3xl">{title}</h2>
    </div>
  );
}
