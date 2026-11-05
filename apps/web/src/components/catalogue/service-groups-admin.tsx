"use client";

// v47: Admin → Catalogue: the services and sub-services a Client Manager can pick. Hiding keeps running projects as they are.
import { useState } from "react";
import type { ServiceGroupView, SubServiceView } from "@bmu/shared";
import { Badge, Button, Input, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const area = "h-20 w-full border border-border bg-surface px-3 py-2 text-sm";
const link = "text-xs underline";

function SubRow({ s, onSave }: { s: SubServiceView; onSave: (input: { name: string; covers: string; archived?: boolean }, label: string) => void }) {
  const [name, setName] = useState(s.name);
  const [covers, setCovers] = useState(s.covers);
  const changed = name !== s.name || covers !== s.covers;
  return (
    <li className="grid gap-2 py-3" data-testid="sub-service-row">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="min-w-[200px] flex-1 py-1" value={name} onChange={(e) => setName(e.target.value)} aria-label={`${s.name} name`} maxLength={120} />
        {s.archived && <Badge>hidden</Badge>}
        {changed && (
          <Button type="button" variant="secondary" className="py-1" onClick={() => onSave({ name: name.trim(), covers: covers.trim() }, `${name.trim()} saved`)}>
            Save
          </Button>
        )}
        <button type="button" className={link} onClick={() => onSave({ name: s.name, covers: s.covers, archived: !s.archived }, `${s.name} ${s.archived ? "shown again" : "hidden"}`)}>
          {s.archived ? "Show" : "Hide"}
        </button>
      </div>
      <textarea className={area} value={covers} onChange={(e) => setCovers(e.target.value)} placeholder="What it covers" aria-label={`${s.name} what it covers`} maxLength={600} />
    </li>
  );
}

function NewSub({ onAdd }: { onAdd: (input: { name: string; covers: string }) => void }) {
  const [name, setName] = useState("");
  const [covers, setCovers] = useState("");
  return (
    <form
      className="grid gap-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ name: name.trim(), covers: covers.trim() });
        setName("");
        setCovers("");
      }}
    >
      <p className="text-xs text-ink-muted">Add a sub-service</p>
      <Input className="py-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sub-service name" aria-label="New sub-service name" required minLength={2} maxLength={120} />
      <textarea className={area} value={covers} onChange={(e) => setCovers(e.target.value)} placeholder="What it covers" aria-label="New sub-service what it covers" maxLength={600} />
      <Button type="submit" variant="secondary" className="justify-self-start py-1">
        Add sub-service
      </Button>
    </form>
  );
}

function GroupCard({ g, run }: { g: ServiceGroupView; run: (label: string, fn: () => Promise<unknown>) => void }) {
  const [name, setName] = useState(g.name);
  const live = g.subServices.filter((s) => !s.archived).length;
  return (
    <details className="border border-border bg-surface-raised" data-testid="service-group">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 font-medium">
        <span>
          {g.name} {g.archived && <Badge>hidden</Badge>}
        </span>
        <span className="text-xs font-normal text-ink-muted">
          {live} sub-service{live === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="grid gap-3 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="min-w-[200px] flex-1 py-1" value={name} onChange={(e) => setName(e.target.value)} aria-label={`${g.name} service name`} maxLength={120} />
          {name.trim() !== g.name && (
            <Button type="button" variant="secondary" className="py-1" onClick={() => run(`${name.trim()} saved`, () => api.catalogue.saveGroup(g.id, { name: name.trim() }))}>
              Rename
            </Button>
          )}
          <button type="button" className={link} onClick={() => run(`${g.name} ${g.archived ? "shown again" : "hidden"}`, () => api.catalogue.saveGroup(g.id, { name: g.name, archived: !g.archived }))}>
            {g.archived ? "Show this service" : "Hide this service"}
          </button>
        </div>
        <ul className="divide-y divide-border">
          {g.subServices.map((s) => (
            <SubRow key={s.id} s={s} onSave={(input, label) => run(label, () => api.catalogue.saveSubService(s.id, input))} />
          ))}
        </ul>
        <NewSub onAdd={(input) => run(`${input.name} added to ${g.name}`, () => api.catalogue.addSubService(g.id, input))} />
      </div>
    </details>
  );
}

export function ServiceGroupsAdmin() {
  const groups = useLoad(() => api.catalogue.groups());
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [name, setName] = useState("");
  async function run(label: string, fn: () => Promise<unknown>) {
    setError(undefined);
    setSaved(undefined);
    try {
      await fn();
      setSaved(label);
      groups.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="mb-10" data-testid="service-groups-admin">
      <h2 className="font-semibold">Services and sub-services</h2>
      <p className="mb-3 text-sm text-ink-muted">What Client Managers can add to a client. &quot;What it covers&quot; is the starting text on a quotation; the Client Manager can edit it and add the price there.</p>
      {error && <p className="mb-3 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
      {saved && !error && <p className="mb-3 border border-green bg-green/10 px-4 py-2 text-sm">{saved}</p>}
      <LoadState loading={groups.loading} error={groups.error} />
      <div className="grid gap-2">
        {(groups.data ?? []).map((g) => (
          <GroupCard key={g.id} g={g} run={run} />
        ))}
      </div>
      {groups.data && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            run(`${n} added`, () => api.catalogue.addGroup({ name: n }));
            setName("");
          }}
        >
          <Input className="min-w-[220px] flex-1 py-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="New service name" aria-label="New service name" required minLength={2} maxLength={120} />
          <Button type="submit" variant="secondary" className="py-1">
            Add service
          </Button>
        </form>
      )}
    </section>
  );
}
