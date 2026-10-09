"use client";

import { liveRoom } from "@bmu/shared";
import { usePresence } from "@/lib/live";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/**
 * v13 presence: small faces of teammates looking at the same record right now. Renders nothing when you are alone.
 * Put it near a record's title: <Presence entity="Lead" id={lead.id} />.
 */
export function Presence({ entity, id, className = "" }: { entity: string; id: string | null | undefined; className?: string }) {
  const users = usePresence(id ? liveRoom(entity, id) : null);
  if (!users.length) return null;
  const names = users.map((u) => u.name);
  const label = names.length === 1 ? `${names[0]} is also looking at this` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are also looking at this`;
  return (
    <div className={`inline-flex items-center gap-2 text-xs text-ink-muted ${className}`} data-testid="presence" title={label}>
      <span className="flex -space-x-1.5">
        {users.slice(0, 4).map((u) => (
          <span key={u.id} className="flex h-6 w-6 items-center justify-center border border-surface bg-charcoal text-[10px] font-medium text-white" aria-hidden>
            {initials(u.name)}
          </span>
        ))}
      </span>
      <span>{names.length === 1 ? `${names[0]} is also here` : `${names.length} others here`}</span>
      <span className="sr-only">{label}</span>
    </div>
  );
}
