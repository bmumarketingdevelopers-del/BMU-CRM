// v13 foundation: Command Centre → System health. Database, event bus, live connections, search index, background
// jobs and feature flags on one page, for the Founder and Branch Managers.
import { ForbiddenException, Injectable } from '@nestjs/common';
import { hostname } from 'node:os';
import { APP_VERSION, type Me, type SystemHealth, type SystemJobStat, type SystemProcess } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { eventBus } from './event-bus.js';
import { EventsService } from './events.service.js';
import { FlagsService } from './flags.service.js';
import { RealtimeService } from './realtime.service.js';
import { SearchIndexService } from './search-index.service.js';
import { EventBridgeService } from '../runtime/event-bridge.js';
import { STALE_MS } from '../runtime/heartbeat.service.js';
import { jobStats } from '../runtime/jobs.js';
import { instanceId, processRole } from '../runtime/process-role.js';

const startedAt = new Date();
const SUBSCRIBER_LABELS: Record<string, string> = { realtime: 'Live updates', search_index: 'Search index' };

const every = (ms: number) => (ms >= 3600_000 ? `every ${ms / 3600_000} h` : ms >= 60_000 ? `every ${ms / 60_000} min` : `every ${ms / 1000} s`);

/** One line per background job across the running processes (System health "Background jobs"). */
export function jobsSummary(processes: SystemProcess[]): SystemHealth['jobs'] {
  const seen = new Map<string, SystemHealth['jobs'][number]>();
  for (const p of processes.filter((x) => x.alive)) {
    for (const j of p.jobs) {
      if (seen.has(j.name)) continue;
      const last = j.lastError ? ` · last run failed: ${j.lastError}` : j.lastRunAt ? ` · last run ${new Date(j.lastRunAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}` : '';
      seen.set(j.name, { name: j.name, on: true, hint: `${j.hint} (${every(j.everyMs)}, on the ${p.role === 'all' ? 'main' : p.role} process)${last}` });
    }
  }
  if (!seen.size) return [{ name: 'Background jobs', on: false, hint: 'No process is running background jobs. Start the worker (pnpm start:worker) or run PROCESS_ROLE=all.' }];
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function assertSystemAdmin(me: Me) {
  if (me.type !== 'staff' || !me.roles.some((r) => r === 'founder' || r === 'admin')) throw new ForbiddenException('System health is for Founders and Branch Managers');
}

@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly flags: FlagsService,
    private readonly realtime: RealtimeService,
    private readonly search: SearchIndexService,
    private readonly bridge: EventBridgeService,
  ) {}

  async health(me: Me): Promise<SystemHealth> {
    assertSystemAdmin(me);
    const t0 = Date.now();
    let ok = true;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      ok = false;
    }
    const ms = Date.now() - t0;
    const counts = eventBus.counts();
    const processes = await this.processes();
    return {
      version: APP_VERSION,
      startedAt: startedAt.toISOString(),
      database: { ok, ms },
      events: {
        ...counts,
        subscribers: eventBus.subscribers().map((name) => {
          const s = eventBus.stats.get(name)!;
          return { name: SUBSCRIBER_LABELS[name] ?? name, delivered: s.delivered, failed: s.failed, lastError: s.lastError, lastErrorAt: s.lastErrorAt?.toISOString() ?? null };
        }),
        failures: await this.events.open(me.orgId),
        transport: this.bridge.state.transport,
        bridge: { connected: this.bridge.state.connected, sent: this.bridge.state.sent, received: this.bridge.state.received, dropped: this.bridge.state.dropped, lastError: this.bridge.state.lastError },
      },
      realtime: this.realtime.stats(),
      search: await this.search.stats(me.orgId),
      jobs: jobsSummary(processes),
      processes,
      flags: await this.flags.rows(me.orgId),
    };
  }

  /** v21: every backend process seen in the last day (from their heartbeats), plus this one if it has not written yet. */
  async processes(): Promise<SystemProcess[]> {
    type Row = { id: string; role: SystemProcess['role']; host: string; pid: number; version: string; startedAt: Date; lastSeenAt: Date; jobs: SystemJobStat[] };
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT id, role, host, pid, version, "startedAt", "lastSeenAt", jobs FROM runtime_processes ORDER BY "lastSeenAt" DESC LIMIT 50`.catch(() => [] as Row[]);
    const now = Date.now();
    const out: SystemProcess[] = rows.map((r) => ({
      id: r.id,
      role: r.role,
      host: r.host,
      pid: r.pid,
      version: r.version,
      startedAt: r.startedAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      alive: now - r.lastSeenAt.getTime() < STALE_MS,
      current: r.id === instanceId,
      jobs: r.id === instanceId ? jobStats() : (r.jobs ?? []),
    }));
    if (!out.some((p) => p.current)) {
      const t = startedAt.toISOString();
      out.unshift({ id: instanceId, role: processRole(), host: hostname(), pid: process.pid, version: APP_VERSION, startedAt: t, lastSeenAt: new Date().toISOString(), alive: true, current: true, jobs: jobStats() });
    }
    return out;
  }

  async rebuildSearch(me: Me) {
    assertSystemAdmin(me);
    return { documents: await this.search.rebuild(me.orgId) };
  }
}
