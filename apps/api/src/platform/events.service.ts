// v13 foundation: keeps failed event deliveries (EventFailure) and retries them with backoff: 1, 2, 4, 8 minutes,
// then marks them "dead" for a person to retry or dismiss on the System health page.
import { Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { SystemEventFailure } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { eventBus, reviveEvent, type BusEvent } from './event-bus.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const MAX_ATTEMPTS = 5;
// Each process retries only its own subscribers (live updates in an API process, workflows in the worker).
const EVERY_MS = 30_000;

export const backgroundJobsOff = () => !!(process.env.NODE_ENV === 'test' || process.env.VITEST || process.env.AUTOMATIONS_DISABLED);

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('EventBus');
  private job?: JobHandle;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    eventBus.onFailure = (subscriber, event, error) => void this.record(subscriber, event, error);
    this.job = startJob({ name: 'events.retries', hint: 'Retries failed event deliveries', everyMs: EVERY_MS, everywhere: true, run: () => this.retryDue() });
  }

  onModuleDestroy() {
    this.job?.stop();
    eventBus.onFailure = null;
  }

  async record(subscriber: string, event: BusEvent, error: Error) {
    this.log.warn(`${subscriber} failed on ${event.kind} ${event.entity}: ${error.message}`);
    try {
      await this.prisma.eventFailure.create({
        data: {
          orgId: event.orgId,
          subscriber,
          eventKind: event.kind === 'domain' ? event.type : `${event.entity}.${event.op}`,
          entity: event.entity,
          event: JSON.parse(JSON.stringify(event)),
          error: error.message.slice(0, 2000),
          nextAttemptAt: new Date(Date.now() + 60_000),
        },
      });
    } catch (e) {
      this.log.error(`Could not record the failure: ${(e as Error).message}`);
    }
  }

  /** Retries every failure that is due. Returns how many succeeded. */
  async retryDue(now = new Date()) {
    if (this.running) return 0;
    this.running = true;
    let ok = 0;
    try {
      const due = await this.prisma.eventFailure.findMany({ where: { status: 'retrying', nextAttemptAt: { lte: now }, subscriber: { in: eventBus.subscribers() } }, take: 50, orderBy: { createdAt: 'asc' } });
      for (const f of due) if ((await this.attempt(f.id)).ok) ok++;
    } finally {
      this.running = false;
    }
    return ok;
  }

  /** One attempt now. Success resolves it; failure backs off or marks it dead. */
  async attempt(id: string, orgId?: string) {
    const f = await this.prisma.eventFailure.findFirst({ where: { id, ...(orgId ? { orgId } : {}) } });
    if (!f) throw new NotFoundException('Failure not found');
    try {
      await eventBus.deliver(f.subscriber, reviveEvent(f.event));
      await this.prisma.eventFailure.update({ where: { id }, data: { status: 'resolved', nextAttemptAt: null } });
      return { ok: true, message: 'Delivered' };
    } catch (e) {
      const attempts = f.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await this.prisma.eventFailure.update({
        where: { id },
        data: { attempts, error: (e as Error).message.slice(0, 2000), status: dead ? 'dead' : 'retrying', nextAttemptAt: dead ? null : new Date(Date.now() + 60_000 * 2 ** (attempts - 1)) },
      });
      return { ok: false, message: (e as Error).message };
    }
  }

  async dismiss(orgId: string, id: string) {
    const r = await this.prisma.eventFailure.updateMany({ where: { id, OR: [{ orgId }, { orgId: null }] }, data: { status: 'dismissed', nextAttemptAt: null } });
    if (!r.count) throw new NotFoundException('Failure not found');
    return { ok: true as const };
  }

  async open(orgId: string): Promise<SystemEventFailure[]> {
    const rows = await this.prisma.eventFailure.findMany({ where: { status: { in: ['retrying', 'dead'] }, OR: [{ orgId }, { orgId: null }] }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((f) => ({
      id: f.id,
      subscriber: f.subscriber,
      eventKind: f.eventKind,
      entity: f.entity,
      error: f.error,
      attempts: f.attempts,
      status: f.status as 'retrying' | 'dead',
      nextAttemptAt: f.nextAttemptAt?.toISOString() ?? null,
      createdAt: f.createdAt.toISOString(),
    }));
  }
}
