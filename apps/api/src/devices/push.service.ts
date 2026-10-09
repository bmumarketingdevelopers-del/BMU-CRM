// v20 push notifications with quick actions: every in-app notification is also pushed to the person's phones
// (Expo push service), with buttons for what can be done straight from the lock screen: Approve / Reject,
// Reply, Done, Snooze. Quiet hours hold pushes back like email (critical ones always go).
import { ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PUSH_CATEGORIES, pushCategory, pushTokenSchema, quickActionSchema, type Me } from '@bmu/shared';
import { MeService } from '../auth/me.service.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { inQuietHours, onNotificationsCreated, type CreatedNotice } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApprovalsService } from '../actions/approvals.service.js';
import { MessagesService } from '../requests/messages.service.js';
import { ProductionService } from '../production/production.service.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const SNOOZE_MS = 60 * 60_000;
const pushUrl = () => process.env.EXPO_PUSH_URL || 'https://exp.host/--/api/v2/push/send';
/** Pushes are off in tests unless a test points EXPO_PUSH_URL at its own server, and when PUSH_DISABLED=1. */
const pushOn = () => process.env.PUSH_DISABLED !== '1' && (!(process.env.NODE_ENV === 'test' || process.env.VITEST) || !!process.env.EXPO_PUSH_URL);

@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Push');
  private off?: () => void;
  private job?: JobHandle;

  constructor(
    private readonly prisma: PrismaService,
    private readonly meService: MeService,
    private readonly audit: AuditService,
    private readonly ref: ModuleRef,
  ) {}

  onModuleInit() {
    this.off = onNotificationsCreated((rows) => void this.deliver(rows).catch((e: Error) => this.log.warn(e.message)));
    this.job = startJob({ name: 'devices.snoozed', hint: 'Brings snoozed notifications back (and pushes them)', everyMs: 60_000, run: () => this.wakeSnoozed() });
    // Snoozed notifications come back (and are pushed again) when the snooze ends.
  }

  onModuleDestroy() {
    this.off?.();
    this.job?.stop();
  }

  async register(me: Me, body: unknown) {
    const input = parse(pushTokenSchema, body);
    await this.prisma.pushToken.upsert({ where: { token: input.token }, create: { orgId: me.orgId, userId: me.id, token: input.token, platform: input.platform }, update: { userId: me.id, orgId: me.orgId, platform: input.platform, lastSeenAt: new Date() } });
    return { ok: true as const };
  }

  async unregister(me: Me, token: string) {
    await this.prisma.pushToken.deleteMany({ where: { token, userId: me.id } });
    return { ok: true as const };
  }

  /** Sends the Expo push messages for newly created notifications. Returns how many were sent. */
  async deliver(rows: CreatedNotice[]): Promise<number> {
    if (!rows.length || !pushOn()) return 0;
    const tokens = await this.prisma.pushToken.findMany({ where: { userId: { in: [...new Set(rows.map((r) => r.userId))] } } });
    if (!tokens.length) return 0;
    const routing = await this.prisma.notificationSetting.findMany({ where: { userId: { in: tokens.map((t) => t.userId) } } });
    const now = new Date();
    const messages = rows.flatMap((r) => {
      const quiet = routing.find((x) => x.userId === r.userId);
      if (!r.critical && quiet && inQuietHours(quiet.quietStart, quiet.quietEnd, now)) return [];
      const { category, ref } = pushCategory(r);
      return tokens
        .filter((t) => t.userId === r.userId)
        .map((t) => ({ to: t.token, title: r.title, body: r.body ?? undefined, sound: 'default', categoryId: category, priority: r.critical ? 'high' : 'default', data: { notificationId: r.id, link: r.link, category, ref, actions: PUSH_CATEGORIES[category] } }));
    });
    if (!messages.length) return 0;
    try {
      const res = await fetch(pushUrl(), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(messages), signal: AbortSignal.timeout(10_000) });
      const out = (await res.json().catch(() => null)) as { data?: { status: string; details?: { error?: string } }[] } | null;
      // Tokens of uninstalled apps are removed so we stop sending to them.
      const gone = (out?.data ?? []).map((d, i) => (d.status === 'error' && d.details?.error === 'DeviceNotRegistered' ? messages[i].to : null)).filter((x): x is string => !!x);
      if (gone.length) await this.prisma.pushToken.deleteMany({ where: { token: { in: gone } } });
    } catch (e) {
      this.log.warn(`Push not sent: ${(e as Error).message}`);
      return 0;
    }
    return messages.length;
  }

  async wakeSnoozed(now = new Date()) {
    const due = await this.prisma.notification.findMany({ where: { snoozedUntil: { lte: now } }, take: 200 });
    if (!due.length) return 0;
    await this.prisma.notification.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { snoozedUntil: null } });
    await this.deliver(due.map((n) => ({ id: n.id, orgId: n.orgId, userId: n.userId, kind: n.kind, title: n.title, body: n.body, link: n.link, critical: n.critical, ref: n.ref ?? undefined })));
    return due.length;
  }

  /** A button pressed on a push notification (or the same action from the in-app list). */
  async quickAction(me: Me, body: unknown, ip?: string) {
    const input = parse(quickActionSchema, body);
    const n = await this.prisma.notification.findFirst({ where: { id: input.notificationId, userId: me.id } });
    if (!n) throw new NotFoundException('Notification not found');
    const { category, ref } = pushCategory({ kind: n.kind, link: n.link, ref: n.ref });
    if (!(PUSH_CATEGORIES[category] as readonly string[]).includes(input.action)) throw new ForbiddenException('That action is not available for this notification');
    let message: string;
    switch (input.action) {
      case 'snooze':
        await this.prisma.notification.update({ where: { id: n.id }, data: { snoozedUntil: new Date(Date.now() + SNOOZE_MS), readAt: null } });
        message = 'Snoozed for an hour';
        break;
      case 'approve':
      case 'reject':
        await this.ref.get(ApprovalsService, { strict: false }).decide(me, ref!, { decision: input.action, note: input.text || undefined }, ip);
        message = input.action === 'approve' ? 'Approved' : 'Rejected';
        break;
      case 'reply':
        if (!input.text) throw new ForbiddenException('Type a reply');
        await this.ref.get(MessagesService, { strict: false }).send(me, ref, input.text, false, ip);
        message = 'Reply sent';
        break;
      case 'done':
        await this.ref.get(ProductionService, { strict: false }).updateTask(me, ref!, { status: 'done' }, ip);
        message = 'Marked done';
        break;
    }
    if (input.action !== 'snooze') await this.prisma.notification.update({ where: { id: n.id }, data: { readAt: new Date() } });
    await this.audit.log(me, 'push.quick_action', 'Notification', n.id, undefined, { action: input.action, category }, ip);
    return { ok: true as const, message };
  }
}
