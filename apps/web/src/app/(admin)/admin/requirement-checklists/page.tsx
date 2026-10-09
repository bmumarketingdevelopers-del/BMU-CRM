"use client";

import { useState } from "react";
import type { ServiceSummary, SettingsValue } from "@bmu/shared";
import { Empty, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ReadOnlyNote, SaveBar, useSaver } from "../_platform/kit";

type Lists = SettingsValue<"requirementChecklists">;
type Item = Lists[string][number];

const TYPES: { value: string; label: string; hint: string }[] = [
  { value: "file", label: "File", hint: "Client uploads a file (logo, photos)" },
  { value: "access", label: "Access", hint: "Login or manager access to an account" },
  { value: "call", label: "Call", hint: "A meeting, e.g. the kick-off call" },
  { value: "text", label: "Answer", hint: "Written answers, e.g. a questionnaire" },
];

export default function RequirementChecklistsPage() {
  const data = useLoad(() => Promise.all([api.settings.all(), api.adminPlatform.access(), api.services()]));
  if (!data.data) {
    return (
      <>
        <PageTitle title="Requirement Checklists" subtitle="What we collect from a new client before work can start." />
        <LoadState loading={data.loading} error={data.error} />
      </>
    );
  }
  const [settings, access, services] = data.data;
  return <Editor initial={settings.requirementChecklists} canEdit={access.operations} services={services} />;
}

function Editor({ initial, canEdit, services }: { initial: Lists; canEdit: boolean; services: ServiceSummary[] }) {
  const [saved, setSaved] = useState(initial);
  const [lists, setLists] = useState(initial);
  const [key, setKey] = useState("default");
  const { busy, msg, setMsg, save } = useSaver("requirementChecklists", (s) => {
    setSaved(s.requirementChecklists);
    setLists(s.requirementChecklists);
  });
  const dirty = JSON.stringify(saved) !== JSON.stringify(lists);
  const own = services.filter((s) => lists[s.id]?.length);
  const name = key === "default" ? "Default list" : (services.find((s) => s.id === key)?.name ?? key);
  const hasOwn = key === "default" || !!lists[key];
  const items = lists[key] ?? lists.default ?? [];

  const setItems = (next: Item[]) => setLists({ ...lists, [key]: next });
  const patch = (i: number, p: Partial<Item>) => setItems(items.map((it, j) => (j === i ? { ...it, ...p } : it)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setItems(next);
  };
  const switchToDefault = () => {
    const next = { ...lists };
    delete next[key];
    setLists(next);
  };
  const invalid = Object.values(lists).some((l) => l.some((i) => !i.label.trim()));

  return (
    <>
      <PageTitle
        title="Requirement Checklists"
        subtitle="What we collect from a new client before work can start. New services get their own list, or the default list when they have none. Changes apply to new engagements only."
      />
      {!canEdit && <ReadOnlyNote who="operations" />}
      <div className="mb-6">
        <StatRow cols={3}>
          <StatTile label="Items on the default list" value={lists.default?.length ?? 0} />
          <StatTile label="Services with their own list" value={`${own.length} of ${services.length}`} />
          <StatTile label="Services using the default" value={services.length - own.length} />
        </StatRow>
      </div>

      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-[300px_1fr]">
        <Panel flush title="Lists" subtitle="Pick a list to edit">
          <ul className="max-h-[560px] divide-y divide-border overflow-y-auto">
            {[{ id: "default", name: "Default list" }, ...services].map((s) => (
              <li key={s.id}>
                <button onClick={() => setKey(s.id)} className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm hover:bg-canvas/50 ${key === s.id ? "border-l-2 border-charcoal bg-canvas/60" : "border-l-2 border-transparent"}`}>
                  <span className="min-w-0 truncate">{s.name}</span>
                  {s.id === "default" ? <Badge tone="dark">{lists.default?.length ?? 0} items</Badge> : lists[s.id]?.length ? <span className="shrink-0 text-xs text-ink-muted">{lists[s.id].length} items</span> : <span className="shrink-0 text-xs text-ink-muted">default</span>}
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title={name}
          subtitle={hasOwn ? (key === "default" ? "Used by every service without its own list." : "This service has its own list.") : "This service uses the default list. Give it its own list to change it."}
          action={
            canEdit && key !== "default" ? (
              hasOwn ? (
                <Button variant="ghost" onClick={switchToDefault}>
                  Use the default list instead
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => setLists({ ...lists, [key]: [...(lists.default ?? [])] })}>
                  Give this service its own list
                </Button>
              )
            ) : undefined
          }
        >
          {items.length === 0 && <Empty>No items yet.</Empty>}
          <ol className="space-y-2">
            {items.map((it, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 border border-border px-3 py-2 sm:flex-nowrap">
                <span className="w-5 text-xs tabular-nums text-ink-muted">{i + 1}</span>
                {hasOwn && canEdit ? (
                  <>
                    <Input className="min-w-0 flex-1 py-1.5" value={it.label} aria-label="Item" onChange={(e) => patch(i, { label: e.target.value })} placeholder="What do we need?" />
                    <Select value={it.type} aria-label="Type" onChange={(e) => patch(i, { type: e.target.value })}>
                      {TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                      {!TYPES.some((t) => t.value === it.type) && <option value={it.type}>{it.type}</option>}
                    </Select>
                    <div className="flex">
                      <Button variant="ghost" className="px-2" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                        ↑
                      </Button>
                      <Button variant="ghost" className="px-2" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                        ↓
                      </Button>
                      <Button variant="ghost" className="px-2" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Remove">
                        ✕
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm">{it.label}</span>
                    <Badge>{TYPES.find((t) => t.value === it.type)?.label ?? it.type}</Badge>
                  </>
                )}
              </li>
            ))}
          </ol>
          {hasOwn && canEdit && (
            <Button variant="secondary" className="mt-3" disabled={items.length >= 50} onClick={() => setItems([...items, { label: "", type: "file" }])}>
              Add item
            </Button>
          )}
          <dl className="mt-6 grid gap-x-6 gap-y-1 border-t border-border pt-4 text-xs text-ink-muted sm:grid-cols-2">
            {TYPES.map((t) => (
              <div key={t.value}>
                <dt className="inline font-medium text-ink">{t.label}:</dt> <dd className="inline">{t.hint}</dd>
              </div>
            ))}
          </dl>
          {canEdit && (
            <SaveBar
              busy={busy}
              dirty={dirty}
              disabled={invalid}
              msg={invalid ? { ok: false, text: "Every item needs a name." } : msg}
              onSave={() => save(lists)}
              onReset={() => {
                setLists(saved);
                setMsg(undefined);
              }}
            />
          )}
        </Panel>
      </div>
    </>
  );
}
