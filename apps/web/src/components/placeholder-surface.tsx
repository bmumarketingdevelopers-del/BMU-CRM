import Link from "next/link";

/** Shell for a surface that's scaffolded but not built yet; lists the screens it will hold. */
export function PlaceholderSurface({ title, screens }: { title: string; screens: readonly string[] }) {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">
      <Link href="/" className="text-sm text-ink-muted hover:text-green">
        ← bmu.marketing
      </Link>
      <h1 className="mt-4 font-display text-3xl">{title}</h1>
      <p className="mt-2 text-ink-muted">Scaffolded. These screens come next, built from the uploaded designs:</p>
      <ul className="mt-6 grid gap-2 sm:grid-cols-2">
        {screens.map((s) => (
          <li key={s} className="border border-border bg-surface-raised px-4 py-3">
            {s}
          </li>
        ))}
      </ul>
    </main>
  );
}
