import Link from "next/link";
import { Logo } from "./logo";

const nav = [
  // Services live on the main BMU Marketing website (opens in a new tab).
  { href: "https://bmumarketing.in/services", label: "Services", external: true },
  { href: "/#industries", label: "Industries" },
  { href: "/sign-in", label: "Sign in" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-5 py-4">
        <Logo size={40} />
        <nav className="flex items-center gap-5 overflow-x-auto whitespace-nowrap text-sm text-ink-muted sm:gap-7">
          {nav.map((n) =>
            n.external ? (
              <a key={n.href} href={n.href} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-ink">
                {n.label}
              </a>
            ) : (
              <Link key={n.href} href={n.href} className="transition-colors hover:text-ink">
                {n.label}
              </Link>
            ),
          )}
          <Link href="/enquiry" className="bg-charcoal px-4 py-2 text-ivory transition-opacity hover:opacity-90">
            Book a call
          </Link>
        </nav>
      </div>
    </header>
  );
}
