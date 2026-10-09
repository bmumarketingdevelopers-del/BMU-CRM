// v21 backend runtime: every backend process writes a heartbeat row (role, host, jobs and their last runs) every
// 20 seconds, so System health can show all processes, API and worker alike, from whichever API process serves it.
// Written with raw SQL so heartbeats never publish change events or show up as live updates.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_VERSION } from '@bmu/shared';
import { hostname } from 'node:os';
import { PrismaService } from '../prisma/prisma.service.js';
import { jobStats } from './jobs.js';
import { instanceId, isTestRun, processRole } from './process-role.js';

const EVERY_MS = 20_000;
/** A process that has not written for this long is shown as stopped (and cleaned up after a day). */
export const STALE_MS = 60_000;

@Injectable()
export class HeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Heartbeat');
  private timer?: ReturnType<typeof setInterval>;
  private readonly startedAt = new Date();
  private warned = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (isTestRun()) return;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), EVERY_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (isTestRun()) return;
    await this.prisma.$executeRaw`DELETE FROM runtime_processes WHERE id = ${instanceId}`.catch(() => undefined);
  }

  async beat() {
    try {
      const jobs = JSON.stringify(jobStats());
      await this.prisma.$executeRaw`
        INSERT INTO runtime_processes (id, role, host, pid, version, "startedAt", "lastSeenAt", jobs)
        VALUES (${instanceId}, ${processRole()}, ${hostname()}, ${process.pid}, ${APP_VERSION}, ${this.startedAt}, now(), ${jobs}::jsonb)
        ON CONFLICT (id) DO UPDATE SET "lastSeenAt" = now(), jobs = EXCLUDED.jobs`;
      await this.prisma.$executeRaw`DELETE FROM runtime_processes WHERE "lastSeenAt" < now() - interval '1 day'`;
      this.warned = false;
    } catch (e) {
      if (!this.warned) this.log.warn(`Could not write the heartbeat: ${(e as Error).message}`);
      this.warned = true;
    }
  }
}
