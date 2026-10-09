"use client";

// v20 goals: company goals that follow a metric automatically, plus team and personal goals with check-ins.
import { useState } from "react";
import {
  GOAL_LEVELS,
  METRICS,
  goalSchema,
  goalStatusLabels,
  type GoalInput,
  type GoalView,
} from "@bmu/shared";
import { Meter, Panel } from "@/components/dash";
import {
  Badge,
  Button,
  Input,
  LoadState,
  PageTitle,
  Select,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const levelLabel = {
  company: "Company",
  team: "Team",
  person: "Personal",
} as const;
const statusTone = {
  on_track: "green",
  at_risk: "amber",
  behind: "red",
  done: "green",
  missed: "neutral",
} as const;
const day = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});
const isoToday = () =>
  new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const quarterEnd = () => {
  const d = new Date(Date.now() + 330 * 60_000);
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0))
    .toISOString()
    .slice(0, 10);
};

export function GoalsBoard() {
  const data = useLoad(() => api.intelligence.goals());
  const tree = useLoad(() => api.org.tree().catch(() => null), { live: false });
  const [adding, setAdding] = useState(false);
  const d = data.data;
  return (
    <>
      <PageTitle
        title="Goals"
        subtitle="Company goals follow a metric automatically. Team and personal goals move with check-ins. Status compares progress with how much of the time has gone."
        action={
          <Button onClick={() => setAdding((a) => !a)}>
            {adding ? "Close" : "New goal"}
          </Button>
        }
      />
      <LoadState loading={data.loading && !d} error={data.error} />
      {adding && d && (
        <GoalForm
          canCompany={d.canCreateCompany}
          departments={(tree.data?.branches ?? []).flatMap((b) =>
            b.departments.map((x) => ({
              id: x.id,
              name: `${x.name} · ${b.name}`,
            })),
          )}
          people={(tree.data?.users ?? [])
            .filter((u) => u.type === "staff")
            .map((u) => ({ id: u.id, name: u.name }))}
          onSaved={() => (setAdding(false), data.reload())}
        />
      )}
      {d && (
        <div className="grid gap-6">
          {GOAL_LEVELS.map((level) => {
            const goals = d.goals.filter((g) => g.level === level);
            if (!goals.length) return null;
            return (
              <Panel key={level} title={`${levelLabel[level]} goals`} flush>
                <ul className="divide-y divide-border">
                  {goals.map((g) => (
                    <GoalRow key={g.id} g={g} onChange={data.reload} />
                  ))}
                </ul>
              </Panel>
            );
          })}
          {!d.goals.length && (
            <p className="text-sm text-ink-muted">No goals yet.</p>
          )}
        </div>
      )}
    </>
  );
}

function GoalRow({ g, onChange }: { g: GoalView; onChange: () => void }) {
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string>();
  const [open, setOpen] = useState(false);
  return (
    <li className="grid gap-2 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{g.title}</span>
        <span className="flex items-center gap-2">
          <Badge tone={statusTone[g.status]}>
            {goalStatusLabels[g.status]}
          </Badge>
          <span className="text-xs text-ink-muted">
            {day.format(new Date(g.startDate))} –{" "}
            {day.format(new Date(g.endDate))}
          </span>
        </span>
      </div>
      <div>
        <p className="mb-1 text-sm">{`${g.display.target.startsWith("not shown") ? "Numbers not shown to your role" : `${g.display.current} of ${g.display.target}`}${g.metricLabel ? ` · follows ${g.metricLabel}` : ""}${g.owner ? ` · ${g.owner.name}` : ""}${g.department ? ` · ${g.department.name}` : ""}`}</p>
        <Meter
          value={g.progress}
          label={`${g.display.target.startsWith("not shown") ? "Numbers not shown to your role" : `${g.display.current} of ${g.display.target}`}${g.metricLabel ? ` · follows ${g.metricLabel}` : ""}${g.owner ? ` · ${g.owner.name}` : ""}${g.department ? ` · ${g.department.name}` : ""}`}
          tone={
            g.status === "behind" || g.status === "missed"
              ? "bad"
              : g.status === "at_risk"
                ? "warn"
                : "good"
          }
        />
      </div>
      {g.checkIns.length > 0 && (
        <button
          className="text-left text-xs text-ink-muted underline"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide" : "Show"} {g.checkIns.length} check-in
          {g.checkIns.length === 1 ? "" : "s"}
        </button>
      )}
      {open && (
        <ul className="grid gap-1 text-xs text-ink-muted">
          {g.checkIns.map((c) => (
            <li key={c.id}>
              {day.format(new Date(c.createdAt))} · {c.by}: {c.value} {g.unit}
              {c.note ? ` · ${c.note}` : ""}
            </li>
          ))}
        </ul>
      )}
      {g.canCheckIn && !g.metricKey && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setErr(undefined);
            void api.intelligence
              .checkIn(g.id, Number(value), note || undefined)
              .then(
                () => (setValue(""), setNote(""), onChange()),
                (x: Error) => setErr(x.message),
              );
          }}
        >
          <input
            className="w-32 border border-border bg-surface-raised px-3 py-2 text-sm"
            type="number"
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Now (${g.unit || "value"})`}
            aria-label="Current value"
            required
          />
          <Input
            className="min-w-0 flex-1"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            aria-label="Note"
          />
          <Button variant="secondary" type="submit" className="px-3 py-1.5">
            Check in
          </Button>
          {g.canEdit && (
            <Button
              variant="ghost"
              type="button"
              className="px-3 py-1.5"
              onClick={() =>
                void api.intelligence
                  .updateGoal(g.id, { archived: true })
                  .then(onChange)
              }
            >
              Archive
            </Button>
          )}
        </form>
      )}
      {err && <p className="text-xs text-red">{err}</p>}
    </li>
  );
}

function GoalForm({
  canCompany,
  departments,
  people,
  onSaved,
}: {
  canCompany: boolean;
  departments: { id: string; name: string }[];
  people: { id: string; name: string }[];
  onSaved: () => void;
}) {
  const [f, setF] = useState<GoalInput>({
    title: "",
    level: canCompany ? "company" : "person",
    metricKey: canCompany ? "mrr" : null,
    direction: "higher",
    startValue: 0,
    target: 0,
    unit: "",
    startDate: isoToday(),
    endDate: quarterEnd(),
    ownerId: null,
    departmentId: null,
  });
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const metric = METRICS.find((m) => m.key === f.metricKey);
  const money = metric?.unit === "paise";

  async function save() {
    const parsed = goalSchema.safeParse(f);
    if (!parsed.success) return setErr(parsed.error.issues[0]?.message);
    setBusy(true);
    setErr(undefined);
    try {
      await api.intelligence.createGoal(f);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const num = (v: number) => (money ? v / 100 : v);
  const unnum = (v: string) =>
    money ? Math.round(Number(v) * 100) : Number(v);

  return (
    <Panel title="New goal" className="mb-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm sm:col-span-2">
          Goal
          <Input
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
            placeholder="e.g. Reach ₹12 lakh MRR"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Level
          <Select
            value={f.level}
            onChange={(e) =>
              setF({
                ...f,
                level: e.target.value as GoalInput["level"],
                metricKey:
                  e.target.value === "company" ? (f.metricKey ?? "mrr") : null,
              })
            }
          >
            {GOAL_LEVELS.filter((l) => l !== "company" || canCompany).map(
              (l) => (
                <option key={l} value={l}>
                  {levelLabel[l]}
                </option>
              ),
            )}
          </Select>
        </label>
        {f.level === "company" && (
          <label className="grid gap-1 text-sm">
            Follows the metric
            <Select
              value={f.metricKey ?? ""}
              onChange={(e) =>
                setF({
                  ...f,
                  metricKey: e.target.value || null,
                  direction:
                    METRICS.find((m) => m.key === e.target.value)?.direction ??
                    "higher",
                })
              }
            >
              <option value="">None (check-ins)</option>
              {METRICS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </Select>
          </label>
        )}
        {f.level === "team" && (
          <label className="grid gap-1 text-sm">
            Team
            <Select
              value={f.departmentId ?? ""}
              onChange={(e) =>
                setF({ ...f, departmentId: e.target.value || null })
              }
            >
              <option value="">Choose…</option>
              {departments.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        {f.level === "person" && people.length > 0 && (
          <label className="grid gap-1 text-sm">
            For
            <Select
              value={f.ownerId ?? ""}
              onChange={(e) => setF({ ...f, ownerId: e.target.value || null })}
            >
              <option value="">Me</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label className="grid gap-1 text-sm">
          Starting value{money ? " (₹)" : ""}
          <Input
            type="number"
            step="any"
            value={num(f.startValue ?? 0)}
            onChange={(e) => setF({ ...f, startValue: unnum(e.target.value) })}
          />
        </label>
        <label className="grid gap-1 text-sm">
          Target{money ? " (₹)" : ""}
          <Input
            type="number"
            step="any"
            value={num(f.target)}
            onChange={(e) => setF({ ...f, target: unnum(e.target.value) })}
          />
        </label>
        {!f.metricKey && (
          <label className="grid gap-1 text-sm">
            Unit
            <Input
              value={f.unit ?? ""}
              onChange={(e) => setF({ ...f, unit: e.target.value })}
              placeholder="e.g. clients, posts, %"
            />
          </label>
        )}
        <label className="grid gap-1 text-sm">
          From
          <Input
            type="date"
            value={f.startDate}
            onChange={(e) => setF({ ...f, startDate: e.target.value })}
          />
        </label>
        <label className="grid gap-1 text-sm">
          To
          <Input
            type="date"
            value={f.endDate}
            onChange={(e) => setF({ ...f, endDate: e.target.value })}
          />
        </label>
      </div>
      {err && <p className="mt-2 text-sm text-red">{err}</p>}
      <div className="mt-4">
        <Button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save goal"}
        </Button>
      </div>
    </Panel>
  );
}
