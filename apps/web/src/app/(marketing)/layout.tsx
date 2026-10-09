import Link from "next/link";
import { APP_VERSION } from "@bmu/shared";
import { Logo } from "@/components/logo";
import { SiteHeader } from "@/components/site-header";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
      <footer className="mt-auto border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-sm text-ink-muted">
          <div className="flex items-center gap-3">
            <Logo className="text-ink" />
            <span>Build My Universee · Bengaluru</span>
          </div>
          <nav className="flex gap-5">
            <Link href="/services" className="hover:text-ink">Services</Link>
            <Link href="/package-builder" className="hover:text-ink">Pricing</Link>
            <Link href="/enquiry" className="hover:text-ink">Contact</Link>
            <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          </nav>
          <span className="text-xs">BMU Hub {APP_VERSION}</span>
        </div>
      </footer>
    </>
  );
}
