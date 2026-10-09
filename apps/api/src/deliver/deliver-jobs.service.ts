// v10 deliver: built-in scheduled jobs (dev and production; off in tests).
// Every 10 minutes: start this month's retainer cycles, escalate overdue steps, remind pending approvers.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DeliverApprovalsService } from './deliver-approvals.service.js';
import { DeliverCyclesService } from './deliver-cycles.service.js';
import { DeliverSlaService } from './deliver-sla.service.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const EVERY_MS = 10 * 60_000;

@Injectable()
export class DeliverJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DeliverJobs');
  private job?: JobHandle;
  private running = false;

  constructor(
    private readonly cycles: DeliverCyclesService,
    private readonly sla: DeliverSlaService,
    private readonly approvals: DeliverApprovalsService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'deliver.jobs', hint: 'Retainer months, SLA escalation, approval reminders', everyMs: EVERY_MS, firstAfterMs: 20_000, flags: ['DELIVER_JOBS_DISABLED'], run: () => this.tick() });
    if (this.job) this.log.log('Delivery jobs started (retainer months, SLA escalation, approval reminders every 10 minutes)');
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  /** One pass of every job. Each job is isolated so one failure never stops the others. */
  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      for (const [name, job] of [
        ['retainer months', () => this.cycles.runAuto(now)],
        ['SLA escalation', () => this.sla.escalate(now)],
        ['approval reminders', () => this.approvals.autoRemind(now)],
      ] as const) {
        try {
          await job();
        } catch (e) {
          this.log.error(`${name} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
