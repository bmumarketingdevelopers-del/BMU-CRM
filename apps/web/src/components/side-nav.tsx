"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UnreadBadge } from "@/components/service/unread-badge";

export type NavSection = { section: string; items: { label: string; href?: string }[] };

export function SideNav({ sections }: { sections: NavSection[] }) {
  const path = usePathname()!;
  return (
    <nav className="flex gap-4 overflow-x-auto px-5 pb-3 text-sm md:block md:space-y-5 md:overflow-visible">
      {sections.map((s) => (
        <div key={s.section} className="shrink-0">
          <p className="mb-1.5 hidden px-2 text-[11px] uppercase tracking-[0.14em] text-ink-muted md:block">{s.section}</p>
          <ul className="flex gap-3 md:block md:space-y-0.5">
            {s.items.map((i) =>
              i.href ? (
                <li key={i.label}>
                  {/* No prefetch: with ~30 links, every page view would otherwise render every page in the menu on the server. */}
                  <Link
                    href={i.href}
                    prefetch={false}
                    className={`block whitespace-nowrap border-l-2 py-1 md:px-2 ${path === i.href ? "border-green font-medium text-ink md:bg-canvas/60" : "border-transparent text-ink-muted hover:text-ink"}`}
                  >
                    {i.label}
                    {i.label === "Messages" && <UnreadBadge />}
                  </Link>
                </li>
              ) : (
                <li key={i.label} className="hidden border-l-2 border-transparent py-1 text-ink-muted/40 md:block md:px-2" title="Coming in a later release">
                  {i.label}
                </li>
              ),
            )}
          </ul>
        </div>
      ))}
    </nav>
  );
}
