// v11 core: scheduled jobs (dev and production; off in tests, or with ACTIONS_JOBS_DISABLED=1).
// Every 10 minutes: expire approvals (72 working hours), generate recurring task instances 7 days ahead,
// alert Department Heads about tasks not started a working day before the deadline, and suggest leave cover.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ApprovalsService } from './approvals.service.js';
import { TasksActionsService } from './tasks/tasks.service.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const EVERY_MS = 10 * 60_000;

@Injectable()
export class ActionsJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ActionsJobs');
  private job?: JobHandle;
  private running = false;

  constructor(
    private readonly approvals: ApprovalsService,
    private readonly tasks: TasksActionsService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'actions.jobs', hint: 'Approval expiry, recurring tasks, not-started alerts, leave cover', everyMs: EVERY_MS, firstAfterMs: 30_000, flags: ['ACTIONS_JOBS_DISABLED'], run: () => this.tick() });
    if (this.job) this.log.log('Action jobs started (approval expiry, recurring tasks, not-started alerts, leave cover every 10 minutes)');
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  /** One pass of every job (optionally for one organisation). Each job is isolated. */
  async tick(now = new Date(), orgId?: string) {
    const results: Record<string, number> = {};
    if (this.running) return results;
    this.running = true;
    try {
      for (const [name, job] of [
        ['approvalsExpired', () => this.approvals.expire(now, orgId)],
        ['recurringCreated', () => this.tasks.generateAll(now, orgId)],
        ['notStartedAlerts', () => this.tasks.notStartedAlerts(now, orgId)],
        ['leaveCoverSuggestions', () => this.tasks.leaveCoverSuggestions(now, orgId)],
      ] as const) {
        try {
          results[name] = await job();
        } catch (e) {
          this.log.error(`${name} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
    return results;
  }
}
