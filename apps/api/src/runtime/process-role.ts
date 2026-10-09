// v21 backend runtime: which part of the backend this Node process runs.
//
//   PROCESS_ROLE=all     (default) one process does everything: HTTP API, live updates and background jobs.
//                        This is what `pnpm dev` and a small single-server install use.
//   PROCESS_ROLE=api     HTTP API and live updates only. Run as many as you like behind a load balancer.
//   PROCESS_ROLE=worker  background jobs and write-side event handlers (workflows, AI agents, webhooks) only.
//                        Run one; a second one waits on standby and takes over if the first stops (see leader.ts).
//
// Processes share events through Postgres LISTEN/NOTIFY (event-bridge.ts), so a change saved by the API moves a
// workflow on in the worker, and a task the worker creates shows up live on screens served by any API process.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export type ProcessRole = 'all' | 'api' | 'worker';

const ROLES: ProcessRole[] = ['all', 'api', 'worker'];

export function processRole(): ProcessRole {
  const raw = (process.env.PROCESS_ROLE?.trim() || 'all').toLowerCase() as ProcessRole;
  if (!ROLES.includes(raw)) throw new Error(`PROCESS_ROLE must be one of ${ROLES.join(', ')} (got "${process.env.PROCESS_ROLE}")`);
  return raw;
}

/** Unique per running process: tells our own NOTIFY messages apart from other processes'. */
export const instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export const isTestRun = () => process.env.NODE_ENV === 'test' || !!process.env.VITEST;

const on = (name: string) => {
  const v = process.env[name];
  return !!v && v !== '0' && v.toLowerCase() !== 'false';
};

/** This process answers HTTP requests and holds live-update connections. */
export const servesHttp = () => processRole() !== 'worker';

/**
 * Background jobs and write-side event handlers run here: never in tests or in an API-only process; otherwise in
 * the worker (or the all-in-one process). AUTOMATIONS_DISABLED switches off everything except `core` jobs (account
 * housekeeping such as suspending leavers); extra flags (e.g. AGENTS_DISABLED) switch off one area.
 */
export function runsJobs(flags: string[] = [], opts: { core?: boolean } = {}) {
  if (isTestRun() || processRole() === 'api') return false;
  if (!opts.core && on('AUTOMATIONS_DISABLED')) return false;
  return !flags.some(on);
}

/** Events are shared between processes through Postgres unless EVENT_BRIDGE=0 (off in tests). */
export const bridgeEnabled = () => !isTestRun() && (process.env.EVENT_BRIDGE === undefined || on('EVENT_BRIDGE'));
