"use client";

/**
 * DuplicateWarning: "This may already exist" under a create form's key field (spec duplicate detection).
 * Give it a search function; it debounces, and lists close matches with links. It never blocks saving.
 *
 *   <DuplicateWarning value={title} search={(q) => api.coreTasks.query({ q, clientId }).then((r) => r.map((t) => ({ id: t.id, label: t.title, href: `/team/tasks/${t.id}` })))} />
 */
import { useEffect, useState } from "react";
import Link from "next/link";

export type DuplicateMatch = { id: string; label: string; sub?: string; href?: string };

export function DuplicateWarning({ value, search, minLength = 4, noun = "record" }: { value: string; search: (q: string) => Promise<DuplicateMatch[]>; minLength?: number; noun?: string }) {
  const [matches, setMatches] = useState<DuplicateMatch[]>([]);
  const q = value.trim();
  useEffect(() => {
    if (q.length < minLength) return;
    let live = true;
    const t = setTimeout(() => {
      search(q)
        .then((m) => live && setMatches(m.slice(0, 3)))
        .catch(() => live && setMatches([]));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // search is usually an inline arrow; re-run on the text only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, minLength]);
  if (q.length < minLength || !matches.length) return null;
  return (
    <div className="border border-amber bg-amber/10 px-3 py-2 text-xs" role="note" data-testid="duplicate-warning">
      <p className="font-medium">A similar {noun} already exists:</p>
      <ul className="mt-1 space-y-0.5">
        {matches.map((m) => (
          <li key={m.id}>
            {m.href ? (
              <Link href={m.href} target="_blank" className="underline">
                {m.label}
              </Link>
            ) : (
              m.label
            )}
            {m.sub && <span className="text-ink-muted"> · {m.sub}</span>}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-ink-muted">You can still save if this is a different one.</p>
    </div>
  );
}
