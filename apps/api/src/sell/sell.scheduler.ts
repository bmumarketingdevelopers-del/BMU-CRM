import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ProposalsService } from '../proposals/proposals.service.js';
import { SellService } from './sell.service.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

/** Every minute in dev/production (never in tests): expire overdue proposals and send follow-up reminders. */
@Injectable()
export class SellScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SellScheduler');
  private job?: JobHandle;
  private running = false;

  constructor(
    private readonly sell: SellService,
    private readonly proposals: ProposalsService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'sell.scheduler', hint: 'Follow-up reminders and proposal expiry', everyMs: 60_000, firstAfterMs: 5_000, run: () => this.tick() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const expired = await this.proposals.expireDue();
      const reminded = await this.sell.sendFollowUpReminders();
      if (expired || reminded) this.log.log(`Expired ${expired} proposal(s), sent ${reminded} follow-up reminder(s)`);
    } catch (e) {
      this.log.error(`Sell sweep failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
