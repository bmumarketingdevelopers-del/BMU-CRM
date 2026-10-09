"use client";
// v18 stopwatch: start on a task (or a project), stop to log the time on the task and the timesheet.
import { useEffect, useState } from "react";
import { Button, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Note } from "./kit";

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function TimerWidget({ taskId, onLogged }: { taskId?: string; onLogged?: () => void }) {
  const timer = useLoad(() => api.timer.get(), { live: false });
  const tasks = useLoad(() => (taskId ? Promise.resolve([]) : api.tasks.list("mine")), { live: false });
  const [pick, setPick] = useState(taskId ?? "");
  const [now, setNow] = useState(() => Date.now());
  const [msg, setMsg] = useState<{ error?: string; ok?: string }>({});
  const running = timer.data?.running ?? null;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const start = () => {
    setMsg({});
    api.timer.start({ taskId: pick || null }).then(() => timer.reload()).catch((e: Error) => setMsg({ error: e.message }));
  };
  const stop = () =>
    api.timer
      .stop()
      .then((r) => {
        setMsg({ ok: r.note });
        timer.reload();
        onLogged?.();
      })
      .catch((e: Error) => setMsg({ error: e.message }));
  const open = (tasks.data ?? []).filter((t) => t.status !== "done");
  if (!timer.data) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border border-border bg-surface-raised px-4 py-3 text-sm" data-testid="timer">
      {running ? (
        <>
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green" aria-hidden />
          <span className="font-mono text-base tabular-nums" data-testid="timer-clock">{clock(now - new Date(running.startedAt).getTime())}</span>
          <span className="min-w-0 flex-1 truncate text-ink-muted">{running.taskTitle ?? running.project ?? "Internal work"}</span>
          <Button onClick={stop} data-testid="timer-stop">Stop and log</Button>
          <Button variant="ghost" onClick={() => window.confirm("Throw away this timer without logging?") && api.timer.discard().then(timer.reload)}>Discard</Button>
        </>
      ) : (
        <>
          <span className="font-medium">Stopwatch</span>
          {!taskId && (
            <Select value={pick} onChange={(e) => setPick(e.target.value)} className="max-w-xs" data-testid="timer-task">
              <option value="">Internal work (no task)</option>
              {open.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </Select>
          )}
          <Button variant="secondary" onClick={start} data-testid="timer-start">Start timer</Button>
        </>
      )}
      <Note {...msg} />
    </div>
  );
}
