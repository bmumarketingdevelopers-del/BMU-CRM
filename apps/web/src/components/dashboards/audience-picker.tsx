"use client";

/** v12: who sees a custom dashboard (everyone, roles, specialties, named people) and where it shows. */
import { useState } from "react";
import { DASHBOARD_PLACEMENTS, dashboardPlacementLabels, type DashboardAudience, type DashboardPlacement, type DashboardStudio } from "@bmu/shared";
import { Field } from "@/components/actions/action-drawer";
import { Input, Select } from "@/components/ui";

function Chip({ on, label, onToggle, testId }: { on: boolean; label: string; onToggle: () => void; testId?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      data-testid={testId}
      className={`border px-2.5 py-1 text-xs ${on ? "border-charcoal bg-charcoal text-ivory" : "border-border text-ink-muted hover:border-ink hover:text-ink"}`}
    >
      {label}
    </button>
  );
}

const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

export function PlacementSelect({ value, onChange }: { value: DashboardPlacement; onChange: (v: DashboardPlacement) => void }) {
  return (
    <Field label="Where it shows" htmlFor="dash-placement" hint="A home page made for someone replaces their usual one. Named people win over specialties, then roles.">
      <Select id="dash-placement" value={value} onChange={(e) => onChange(e.target.value as DashboardPlacement)} className="w-full">
        {DASHBOARD_PLACEMENTS.map((p) => (
          <option key={p} value={p}>
            {dashboardPlacementLabels[p]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function AudiencePicker({ value, onChange, studio }: { value: DashboardAudience; onChange: (v: DashboardAudience) => void; studio: Pick<DashboardStudio, "roles" | "specialties" | "people"> }) {
  const [q, setQ] = useState("");
  const people = studio.people.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  const picked = studio.people.filter((p) => value.userIds.includes(p.id));
  return (
    <div className="space-y-4" data-testid="audience-picker">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.everyone} onChange={(e) => onChange({ ...value, everyone: e.target.checked })} />
        Everyone in the team
      </label>
      {!value.everyone && (
        <>
          <Field label="Roles">
            <div className="flex flex-wrap gap-1.5">
              {studio.roles.map((r) => (
                <Chip key={r.id} on={value.roles.includes(r.id)} label={r.label} onToggle={() => onChange({ ...value, roles: toggle(value.roles, r.id) })} testId={`role-${r.id}`} />
              ))}
            </div>
          </Field>
          <Field label="Specialties">
            <div className="flex flex-wrap gap-1.5">
              {studio.specialties.map((s) => (
                <Chip key={s.id} on={value.specialties.includes(s.id)} label={s.label} onToggle={() => onChange({ ...value, specialties: toggle(value.specialties, s.id) })} />
              ))}
            </div>
          </Field>
          <Field label="Named people" htmlFor="dash-people-q">
            {picked.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {picked.map((p) => (
                  <Chip key={p.id} on label={`${p.name} ✕`} onToggle={() => onChange({ ...value, userIds: toggle(value.userIds, p.id) })} />
                ))}
              </div>
            )}
            <Input id="dash-people-q" placeholder="Search the team" value={q} onChange={(e) => setQ(e.target.value)} className="w-full" />
            {q && (
              <ul className="mt-1 max-h-48 overflow-y-auto border border-border bg-surface-raised">
                {people.length ? (
                  people.map((p) => (
                    <li key={p.id}>
                      <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-canvas/50">
                        <input type="checkbox" checked={value.userIds.includes(p.id)} onChange={() => onChange({ ...value, userIds: toggle(value.userIds, p.id) })} />
                        {p.name}
                      </label>
                    </li>
                  ))
                ) : (
                  <li className="px-3 py-2 text-sm text-ink-muted">Nobody matches.</li>
                )}
              </ul>
            )}
          </Field>
        </>
      )}
      <p className="text-xs text-ink-muted">The Founder and Branch Managers can always open it. Everyone sees only the numbers their role allows: people outside the Command Centre see their own numbers.</p>
    </div>
  );
}
