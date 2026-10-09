"use client";
import { useMemo, useRef, useState } from "react";
import { craftScriptStats, type CraftHookView, type CraftScriptPanels, type CraftScriptView } from "@bmu/shared";
import { Insight } from "@/components/charts";
import { Empty, Grid, Meter, Panel } from "@/components/dash";
import { Badge, Button, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { CommentList, ErrorLine, JobRow, StageBoard, fmtDay, useAction } from "./craft-bits";

export function ScriptPanels({ p, readOnly, onChanged }: { p: CraftScriptPanels; readOnly: boolean; onChanged: () => void }) {
  const [hooks, setHooks] = useState(p.hooks);
  const [insert, setInsert] = useState<{ text: string; n: number }>();
  return (
    <>
      <Grid>
        <Panel title="Briefs waiting for a script" subtitle="Not started yet, soonest first.">
          {p.briefs.length ? (
            <div className="divide-y divide-border">
              {p.briefs.map((j) => (
                <JobRow key={`${j.deliverableId}-${j.taskId}`} job={j} />
              ))}
            </div>
          ) : (
            <Empty>No briefs waiting. Ask your AM what is coming next.</Empty>
          )}
        </Panel>
        <Panel title="Client feedback to address" subtitle="Changes requested and open client comments on your scripts.">
          {p.changesRequested.length > 0 && (
            <div className="mb-3 divide-y divide-border border-b border-border pb-2">
              {p.changesRequested.map((j) => (
                <JobRow key={j.deliverableId} job={j} extra={<Badge tone="red">Changes requested</Badge>} />
              ))}
            </div>
          )}
          <CommentList comments={p.feedback} readOnly={readOnly} empty="No open client comments on your scripts." />
        </Panel>
      </Grid>

      <Panel title="Scripts by stage" subtitle="Drafting, with QC or the client, and recently approved.">
        <StageBoard
          stages={[
            { key: "draft", label: "Drafting", items: p.scripts.draft },
            { key: "review", label: "In review", items: p.scripts.review },
            { key: "approved", label: "Approved (45 days)", items: p.scripts.approved },
          ]}
        />
      </Panel>

      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr] [&>*]:min-w-0">
        <ScriptEditor drafts={p.drafts} deliverables={p.deliverables} readOnly={readOnly} insert={insert} onSubmitted={onChanged} />
        <HooksLibrary hooks={hooks} setHooks={setHooks} readOnly={readOnly} onInsert={(text) => setInsert({ text, n: Date.now() })} />
      </div>

      <Panel title="Quality & speed" subtitle="First-time approvals and turnaround for this period.">
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-sm">First-time approval</p>
            <Meter value={p.firstTime.rate ?? 0} tone={(p.firstTime.rate ?? 0) >= 70 ? "good" : "warn"} />
            <p className="mt-1 text-xs text-ink-muted">{p.firstTime.total ? `${p.firstTime.good} of ${p.firstTime.total} scripts approved with no changes` : "No scripts approved in this period"}</p>
          </div>
          <div>
            <p className="mb-2 text-sm">Average turnaround</p>
            <p className="text-2xl font-semibold tabular-nums">{p.turnaround.avgDays ?? "—"}{p.turnaround.avgDays !== null ? " days" : ""}</p>
            <p className="mt-1 text-xs text-ink-muted">{p.turnaround.previous !== null ? `${p.turnaround.previous} days the period before` : "No comparison yet"}</p>
          </div>
        </div>
        {p.firstTime.rate !== null && p.firstTime.previous !== null && (
          <Insight tone={p.firstTime.rate >= p.firstTime.previous ? "good" : "warn"}>
            First-time approvals {p.firstTime.rate >= p.firstTime.previous ? "improved" : "dropped"} from {p.firstTime.previous}% to {p.firstTime.rate}%. {p.firstTime.rate < p.firstTime.previous ? "Re-read the brief and the client's past comments before drafting." : "Keep using the hooks that land."}
          </Insight>
        )}
      </Panel>
    </>
  );
}

/** Markdown script editor with live word count and spoken runtime. Saves drafts; submits as a deliverable version. */
function ScriptEditor({
  drafts: initial,
  deliverables,
  readOnly,
  insert,
  onSubmitted,
}: {
  drafts: CraftScriptView[];
  deliverables: CraftScriptPanels["deliverables"];
  readOnly: boolean;
  insert?: { text: string; n: number };
  onSubmitted: () => void;
}) {
  const [drafts, setDrafts] = useState(initial);
  const [id, setId] = useState<string | undefined>(initial[0]?.id);
  const current = drafts.find((d) => d.id === id);
  const [form, setForm] = useState({ title: current?.title ?? "", body: current?.body ?? "", deliverableId: current?.deliverableId ?? "" });
  const [saved, setSaved] = useState<string>();
  const { busy, error, run } = useAction();
  const area = useRef<HTMLTextAreaElement>(null);
  const stats = useMemo(() => craftScriptStats(form.body), [form.body]);

  // A hook picked in the library waits here until the writer inserts it at the cursor.
  const [dismissed, setDismissed] = useState<number>();
  const pending = insert && insert.n !== dismissed ? insert : undefined;
  function insertHook() {
    if (!pending) return;
    const pos = area.current?.selectionStart ?? form.body.length;
    setForm({ ...form, body: `${form.body.slice(0, pos)}${pending.text}\n${form.body.slice(pos)}` });
    setDismissed(pending.n);
  }

  function open(d?: CraftScriptView) {
    setId(d?.id);
    setForm({ title: d?.title ?? "", body: d?.body ?? "", deliverableId: d?.deliverableId ?? "" });
    setSaved(undefined);
  }

  async function save() {
    const input = { title: form.title, body: form.body, deliverableId: form.deliverableId || null };
    const s = await run("save", () => (id ? api.craft.saveScript(id, input) : api.craft.createScript(input)));
    if (s) {
      setDrafts((ds) => [s, ...ds.filter((x) => x.id !== s.id)]);
      setId(s.id);
      setSaved(`Saved at ${new Intl.DateTimeFormat("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date())}`);
    }
    return s;
  }

  async function submit() {
    const s = await save();
    if (!s) return;
    const done = await run("submit", () => api.craft.submitScript(s.id));
    if (done) {
      setDrafts((ds) => ds.map((x) => (x.id === done.id ? done : x)));
      setSaved("Submitted as a new version — it is now with QC.");
      onSubmitted();
    }
  }

  const target = deliverables.find((d) => d.id === form.deliverableId);
  return (
    <Panel
      title="Script editor"
      subtitle="Write in plain text or Markdown. Word count and spoken runtime (150 words a minute) update as you type."
      action={
        !readOnly ? (
          <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => open()}>
            New script
          </Button>
        ) : undefined
      }
    >
      {drafts.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {drafts.slice(0, 6).map((d) => (
            <button key={d.id} onClick={() => open(d)} className={`border px-2.5 py-1 text-xs ${d.id === id ? "border-charcoal bg-charcoal text-ivory" : "border-border text-ink-muted hover:text-ink"}`}>
              {d.title.slice(0, 32)}
              {d.submittedVersionId ? " ✓" : ""}
            </button>
          ))}
        </div>
      )}
      {readOnly ? (
        current ? (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap border border-border bg-surface p-3 text-sm">{current.body}</pre>
        ) : (
          <Empty>No drafts yet.</Empty>
        )
      ) : (
        <div className="space-y-3" data-script-editor>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
            <Input aria-label="Script title" placeholder="Script title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <Select aria-label="Deliverable" value={form.deliverableId} onChange={(e) => setForm({ ...form, deliverableId: e.target.value })}>
              <option value="">Not linked to a deliverable yet</option>
              {deliverables.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title} · {d.client}
                </option>
              ))}
            </Select>
          </div>
          {pending && (
            <div className="flex flex-wrap items-center gap-2 border border-border bg-canvas/60 px-3 py-2 text-sm" data-pending-hook>
              <span className="min-w-0 flex-1 truncate">Hook: “{pending.text}”</span>
              <Button className="px-2.5 py-1 text-xs" onClick={insertHook}>
                Insert at cursor
              </Button>
              <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setDismissed(pending.n)}>
                Dismiss
              </Button>
            </div>
          )}
          <textarea
            ref={area}
            aria-label="Script"
            className="min-h-64 w-full border border-border bg-surface-raised px-3 py-2 font-mono text-sm leading-relaxed"
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            placeholder={"## Hook (0–3s)\nStop scrolling if…\n\n## Scene 1\nVO: …\n\n## CTA\n…"}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm tabular-nums" data-script-stats>
              <strong>{stats.words}</strong> words · about <strong>{stats.label}</strong> spoken
              {stats.seconds > 90 && <span className="ml-2 text-xs text-[#9a6b00]">Long for a reel — aim for under 60s</span>}
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={!!busy || form.title.trim().length < 2} onClick={save}>
                {busy === "save" ? "Saving…" : "Save draft"}
              </Button>
              <Button disabled={!!busy || !form.deliverableId || !target?.canUpload} onClick={submit} title={!form.deliverableId ? "Link a deliverable first" : !target?.canUpload ? "This deliverable is with QC or the client right now" : ""}>
                {busy === "submit" ? "Submitting…" : "Submit as version"}
              </Button>
            </div>
          </div>
          {form.deliverableId && target && !target.canUpload && <p className="text-xs text-ink-muted">This deliverable is with QC or the client right now, so a new version can be submitted once it comes back.</p>}
          {saved && <p className="text-xs text-[#5f8a12]">✓ {saved}</p>}
          <ErrorLine error={error} />
        </div>
      )}
    </Panel>
  );
}

/** Reusable hook lines: save, tag, insert into the editor, and see which ones you reuse most. */
function HooksLibrary({ hooks, setHooks, readOnly, onInsert }: { hooks: CraftHookView[]; setHooks: (h: CraftHookView[]) => void; readOnly: boolean; onInsert: (text: string) => void }) {
  const [text, setText] = useState("");
  const [tags, setTags] = useState("");
  const [filter, setFilter] = useState<string>();
  const { busy, error, run } = useAction();
  const allTags = [...new Set(hooks.flatMap((h) => h.tags))].sort();
  const shown = filter ? hooks.filter((h) => h.tags.includes(filter)) : hooks;
  return (
    <Panel title="Hooks library" subtitle="Opening lines that work. Save them once, reuse them in any script.">
      {!readOnly && (
        <form
          className="mb-4 space-y-2"
          data-hook-form
          onSubmit={async (e) => {
            e.preventDefault();
            const h = await run("add", () => api.craft.saveHook({ text, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }));
            if (h) {
              setHooks([h, ...hooks]);
              setText("");
              setTags("");
            }
          }}
        >
          <Input aria-label="New hook" placeholder="e.g. Nobody tells you this about…" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-2">
            <Input aria-label="Hook tags" placeholder="Tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} />
            <Button type="submit" className="shrink-0" disabled={busy === "add" || text.trim().length < 4}>
              {busy === "add" ? "Saving…" : "Save hook"}
            </Button>
          </div>
        </form>
      )}
      {allTags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          <button onClick={() => setFilter(undefined)} className={`px-2 py-0.5 text-xs ${!filter ? "bg-charcoal text-ivory" : "bg-canvas text-ink-muted"}`}>
            All
          </button>
          {allTags.map((t) => (
            <button key={t} onClick={() => setFilter(t === filter ? undefined : t)} className={`px-2 py-0.5 text-xs ${filter === t ? "bg-charcoal text-ivory" : "bg-canvas text-ink-muted"}`}>
              #{t}
            </button>
          ))}
        </div>
      )}
      {shown.length ? (
        <ul className="divide-y divide-border" data-hooks>
          {shown.map((h) => (
            <li key={h.id} className="py-2.5">
              <p className="text-sm">“{h.text}”</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                {h.client && <span>{h.client}</span>}
                <span>
                  used {h.uses}× · saved {fmtDay(h.at)}
                </span>
                {!readOnly && (
                  <>
                    <button
                      className="underline-offset-2 hover:text-ink hover:underline"
                      onClick={async () => {
                        onInsert(h.text);
                        const u = await run(h.id, () => api.craft.useHook(h.id));
                        if (u) setHooks(hooks.map((x) => (x.id === u.id ? u : x)));
                      }}
                    >
                      Insert in script
                    </button>
                    <button
                      className="underline-offset-2 hover:text-red hover:underline"
                      onClick={async () => {
                        if (!window.confirm("Remove this hook from your library?")) return;
                        const ok = await run(h.id, () => api.craft.deleteHook(h.id));
                        if (ok) setHooks(hooks.filter((x) => x.id !== h.id));
                      }}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No hooks saved yet.</Empty>
      )}
      <ErrorLine error={error} />
    </Panel>
  );
}
