import { GATES, type GateTrack as Track } from "@bmu/shared";

const fill = { passed: "bg-green", open: "bg-amber", locked: "bg-grey" } as const;

/** Five-segment gate track shown on every engagement (design_system.principles). */
export function GateTrack({ track, clientView = false }: { track: Track; clientView?: boolean }) {
  return (
    <div>
      <div className="flex gap-1" role="list" aria-label={clientView ? "Milestones" : "Gates"}>
        {GATES.map((g) => (
          <div key={g.id} role="listitem" title={g.name} className={`h-2 flex-1 ${fill[track[g.id]]}`} />
        ))}
      </div>
      <div className="mt-1 flex gap-1 text-[11px] text-ink-muted">
        {GATES.map((g) => (
          <span key={g.id} className="flex-1 truncate">
            {g.name}
          </span>
        ))}
      </div>
    </div>
  );
}
