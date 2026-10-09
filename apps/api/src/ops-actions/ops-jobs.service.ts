// v11 ops: scheduled job — every 10 minutes, alert owners and sales managers about new leads past their first-reply
// time. Off in tests (and with ACTIONS_JOBS_DISABLED=1), like the core action jobs.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OpsLeadsService } from './ops-leads.service.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const EVERY_MS = 10 * 60_000;

@Injectable()
export class OpsJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsJobs');
  private job?: JobHandle;
  private running = false;

  constructor(private readonly leads: OpsLeadsService) {}

  onModuleInit() {
    this.job = startJob({ name: 'ops.lead_alerts', hint: 'Lead first-reply alerts', everyMs: EVERY_MS, flags: ['ACTIONS_JOBS_DISABLED'], run: () => this.tick() });
    if (this.job) this.log.log('Ops jobs started (lead first-reply alerts every 10 minutes)');
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  async tick(now = new Date()) {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.leads.firstReplyAlerts(now);
    } catch (e) {
      this.log.error(`firstReplyAlerts failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
