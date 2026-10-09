// v21 backend runtime: one registry for every background job (reminders, sweeps, syncs, nightly forecasts).
// Each feature starts its timer through startJob, which decides whether this process runs jobs (process-role.ts),
// never lets two runs of the same job overlap, logs failures, and keeps run counts for System health and the
// worker's /health/ready. On shutdown the worker stops every timer and waits for runs in progress to finish.
import { Logger } from '@nestjs/common';
import { runsJobs } from './process-role.js';

export type JobOptions = {
  /** Stable id, e.g. "deliver.sla". */
  name: string;
  /** What it does, in plain words (shown on System health). */
  hint: string;
  everyMs: number;
  /** Also run once this long after start-up. */
  firstAfterMs?: number;
  /** Env flags that switch this job off (besides AUTOMATIONS_DISABLED). */
  flags?: string[];
  /** Keeps running when AUTOMATIONS_DISABLED is set (account housekeeping). */
  core?: boolean;
  /** Runs in every process, API ones too (only for work on this process's own memory, e.g. its event retries). */
  everywhere?: boolean;
  run: () => unknown;
};

export type JobStat = {
  name: string;
  hint: string;
  everyMs: number;
  runs: number;
  failures: number;
  lastRunAt: string | null;
  lastMs: number | null;
  lastError: string | null;
  running: boolean;
};

export type JobHandle = { stop(): void; runNow(): Promise<void> };

const log = new Logger('Jobs');
const stats = new Map<string, JobStat>();
const inFlight = new Set<Promise<void>>();
const handles = new Set<JobHandle>();

export function startJob(opts: JobOptions): JobHandle | undefined {
  if (!opts.everywhere && !runsJobs(opts.flags, { core: opts.core })) return undefined;
  if (opts.everywhere && (process.env.NODE_ENV === 'test' || process.env.VITEST)) return undefined;
  const stat: JobStat = { name: opts.name, hint: opts.hint, everyMs: opts.everyMs, runs: 0, failures: 0, lastRunAt: null, lastMs: null, lastError: null, running: false };
  stats.set(opts.name, stat);
  let stopped = false;

  const tick = async () => {
    if (stat.running || stopped) return;
    stat.running = true;
    const t0 = Date.now();
    try {
      await opts.run();
      stat.runs++;
      stat.lastError = null;
    } catch (e) {
      stat.failures++;
      stat.lastError = ((e as Error)?.message ?? String(e)).slice(0, 500);
      log.error(`${opts.name} failed: ${stat.lastError}`);
    } finally {
      stat.running = false;
      stat.lastRunAt = new Date().toISOString();
      stat.lastMs = Date.now() - t0;
    }
  };
  const track = () => {
    const p = tick();
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };

  const timer = setInterval(() => void track(), opts.everyMs);
  timer.unref?.();
  const first = opts.firstAfterMs !== undefined ? setTimeout(() => void track(), opts.firstAfterMs) : undefined;
  first?.unref?.();

  const handle: JobHandle = {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (first) clearTimeout(first);
      stats.delete(opts.name);
      handles.delete(handle);
    },
    runNow: track,
  };
  handles.add(handle);
  return handle;
}

export function jobStats(): JobStat[] {
  return [...stats.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Stops every timer and waits (up to `timeoutMs`) for runs in progress to finish. */
export async function drainJobs(timeoutMs = 20_000) {
  for (const h of handles) h.stop();
  if (!inFlight.size) return;
  log.log(`Waiting for ${inFlight.size} job run(s) to finish…`);
  await Promise.race([Promise.allSettled(inFlight), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
}
