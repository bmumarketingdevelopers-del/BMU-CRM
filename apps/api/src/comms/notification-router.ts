// v17 notification router timer: once a minute, sends alerts held back by quiet hours and the daily digests.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

@Injectable()
export class NotificationRouter implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('NotifyRouter');
  private job?: JobHandle;
  private busy = false;

  constructor(private readonly notifications: NotificationsService) {}

  onModuleInit() {
    this.job = startJob({ name: 'comms.notification_router', hint: 'Sends batched notification emails and digests', everyMs: 60_000, run: () => this.tick() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await this.notifications.flushDue();
      if (r.sent || r.digests) this.log.log(`Sent ${r.sent} held alert(s) and ${r.digests} digest(s)`);
    } catch (e) {
      this.log.warn((e as Error).message);
    } finally {
      this.busy = false;
    }
  }
}
