// v19 outgoing webhooks. Every audited action is a domain event (v13 bus); subscriptions whose event list matches
// get a delivery row. A dispatcher sends them as signed JSON POSTs and retries failures after 1 min, 5 min, 30 min,
// 2 h, 6 h and 12 h; after 7 tries the delivery is "dead" (Founder and Admin are told when a URL starts failing).
// Signature: X-BMU-Signature = "sha256=" + hex HMAC-SHA256(secret, `${X-BMU-Timestamp}.${raw body}`).
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { webhookCreateSchema, webhookUpdateSchema, type Me, type WebhookCreated, type WebhookDeliveryView, type WebhookPayload, type WebhookView } from '@bmu/shared';
import type { Prisma, WebhookDelivery, WebhookSubscription } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { hasRole } from '../creative/scope.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { eventBus, type BusEvent } from '../platform/event-bus.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { seal, unseal } from './crypto.js';
import { snapshot } from './shapes.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';
import { isServerless, processRole } from '../runtime/process-role.js';

export const RETRY_MINUTES = [1, 5, 30, 120, 360, 720];
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

/** "lead.created" matches "lead.created", "lead.*" and "*". */
export const matches = (patterns: string[], type: string) => patterns.some((p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));

export function sign(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const isPrivate = (ip: string) => (isIP(ip) === 4 ? PRIVATE_V4.some((r) => r.test(ip)) : ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80') || ip.startsWith('::ffff:127.') || ip === '::');

/** On a live server webhooks must use https and may not point at the server's own network. */
async function assertSafeUrl(raw: string) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new BadRequestException('The address must start with https://');
  if (process.env.NODE_ENV !== 'production' && process.env.WEBHOOKS_ALLOW_PRIVATE !== '0') return;
  if (url.protocol !== 'https:') throw new BadRequestException('The address must start with https://');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!ips.length) throw new BadRequestException(`Could not find ${host}`);
  if (ips.some(isPrivate)) throw new BadRequestException('That address points at a private network');
}

@Injectable()
export class WebhooksService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Webhooks');
  private job?: JobHandle;
  private unsubscribe: (() => void) | null = null;
  private cache = new Map<string, { at: number; subs: Pick<WebhookSubscription, 'id' | 'events'>[] }>();
  private sending = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {
    // v21: a webhook added through any API process is known to the worker before the next event arrives.
    eventBus.watch(['WebhookSubscription'], (e) => (e.orgId ? this.cache.delete(e.orgId) : this.cache.clear()));
  }

  onModuleInit() {
    // Deliveries are queued once, by the process that runs jobs (an API-only process leaves it to the worker).
    // Serverless: every request queues its own events (nothing passes them on to a worker); the cron call sends them.
    if (processRole() !== 'api' || isServerless()) this.unsubscribe = eventBus.subscribe('webhooks', (e) => this.onEvent(e), ['domain']);
    this.job = startJob({ name: 'integrations.webhooks', hint: 'Delivers outgoing webhooks (with retries)', everyMs: 15_000, run: () => this.dispatchDue() });
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    this.job?.stop();
  }

  private assertAdmin(me: Me) {
    if (me.type !== 'staff' || !hasRole(me, 'founder', 'admin')) throw new ForbiddenException('Only Founders and Admins can manage API keys and webhooks');
  }

  // ------------------------------------------------------------------------------------------------ queueing

  private async subsFor(orgId: string) {
    const hit = this.cache.get(orgId);
    if (hit && hit.at > Date.now() - 30_000) return hit.subs;
    const subs = await this.prisma.webhookSubscription.findMany({ where: { orgId, active: true }, select: { id: true, events: true } });
    this.cache.set(orgId, { at: Date.now(), subs });
    return subs;
  }

  /** Bus subscriber: one delivery per matching subscription. */
  async onEvent(e: BusEvent) {
    if (e.kind !== 'domain') return;
    const subs = (await this.subsFor(e.orgId)).filter((s) => matches(s.events, e.type));
    if (!subs.length) return;
    const payload: WebhookPayload = { id: `evt_${randomBytes(10).toString('hex')}`, type: e.type, occurredAt: e.at.toISOString(), entity: e.entity, entityId: e.entityId, data: await snapshot(this.prisma, e.orgId, e.entity, e.entityId) };
    await this.prisma.webhookDelivery.createMany({ data: subs.map((s) => ({ orgId: e.orgId, subscriptionId: s.id, type: e.type, payload: payload as unknown as Prisma.InputJsonValue })) });
  }

  // ------------------------------------------------------------------------------------------------ sending

  /** Sends every due delivery. Each one is leased for 2 minutes first, so two servers never send it twice. */
  async dispatchDue(now = new Date()) {
    if (this.sending) return 0;
    this.sending = true;
    let sent = 0;
    try {
      const due = await this.prisma.webhookDelivery.findMany({ where: { status: 'pending', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: 50 });
      for (const d of due) {
        const lease = await this.prisma.webhookDelivery.updateMany({ where: { id: d.id, status: 'pending', nextAttemptAt: d.nextAttemptAt }, data: { nextAttemptAt: new Date(now.getTime() + 2 * 60_000) } });
        if (!lease.count) continue;
        await this.send(d, now);
        sent++;
      }
    } finally {
      this.sending = false;
    }
    return sent;
  }

  async send(d: WebhookDelivery, now = new Date()): Promise<WebhookDelivery> {
    const sub = await this.prisma.webhookSubscription.findUnique({ where: { id: d.subscriptionId } });
    if (!sub) return this.prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'dead', lastError: 'The webhook was deleted' } });
    const body = JSON.stringify(d.payload);
    const ts = String(Math.floor(now.getTime() / 1000));
    const started = Date.now();
    let status: number | null = null;
    let error: string | null = null;
    try {
      await assertSafeUrl(sub.url);
      const res = await fetch(sub.url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', 'user-agent': 'BMU-Hub-Webhooks/1', 'x-bmu-event': d.type, 'x-bmu-delivery': d.id, 'x-bmu-timestamp': ts, 'x-bmu-signature': sign(unseal(sub.secretEnc) ?? '', ts, body) },
        body,
      });
      status = res.status;
      if (res.status < 200 || res.status >= 300) {
        const text = (await res.text().catch(() => '')).slice(0, 120);
        error = `The server answered ${res.status}${text ? `: ${text}` : ''}`;
      }
    } catch (e) {
      error = e instanceof BadRequestException ? e.message : `Could not reach the address (${(e as Error).message})`;
    }
    const durationMs = Date.now() - started;
    const attempts = d.attempts + 1;
    if (!error) {
      if (sub.failingSince) await this.prisma.webhookSubscription.update({ where: { id: sub.id }, data: { failingSince: null } });
      return this.prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'delivered', attempts, lastStatus: status, lastError: null, durationMs, deliveredAt: new Date() } });
    }
    const dead = attempts >= MAX_ATTEMPTS;
    if (!sub.failingSince) {
      await this.prisma.webhookSubscription.update({ where: { id: sub.id }, data: { failingSince: now } });
      const admins = await this.prisma.user.findMany({ where: { orgId: sub.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: { in: ['founder', 'admin'] } } } } }, select: { id: true } });
      await this.notifications.notify(sub.orgId, admins.map((a) => a.id), { kind: 'integration', title: 'A webhook is failing', body: `${sub.url}: ${error}. BMU keeps retrying.`, link: '/admin/developer' });
    }
    return this.prisma.webhookDelivery.update({
      where: { id: d.id },
      data: { status: dead ? 'dead' : 'pending', attempts, lastStatus: status, lastError: error.slice(0, 300), durationMs, nextAttemptAt: dead ? d.nextAttemptAt : new Date(now.getTime() + RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] * 60_000) },
    });
  }

  // ------------------------------------------------------------------------------------------------ admin

  private async view(subs: WebhookSubscription[]): Promise<WebhookView[]> {
    const [counts, last] = await Promise.all([
      this.prisma.webhookDelivery.groupBy({ by: ['subscriptionId', 'status'], where: { subscriptionId: { in: subs.map((s) => s.id) } }, _count: { _all: true } }),
      this.prisma.webhookDelivery.groupBy({ by: ['subscriptionId'], where: { subscriptionId: { in: subs.map((s) => s.id) }, status: 'delivered' }, _max: { deliveredAt: true } }),
    ]);
    const c = (id: string, status: string) => counts.find((x) => x.subscriptionId === id && x.status === status)?._count._all ?? 0;
    return subs.map((s) => ({
      id: s.id,
      url: s.url,
      description: s.description,
      events: s.events,
      active: s.active,
      failingSince: s.failingSince?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      stats: { delivered: c(s.id, 'delivered'), pending: c(s.id, 'pending'), dead: c(s.id, 'dead'), lastDeliveredAt: last.find((x) => x.subscriptionId === s.id)?._max.deliveredAt?.toISOString() ?? null },
    }));
  }

  private deliveryView(d: WebhookDelivery): WebhookDeliveryView {
    return { id: d.id, type: d.type, status: d.status as WebhookDeliveryView['status'], attempts: d.attempts, lastStatus: d.lastStatus, lastError: d.lastError, durationMs: d.durationMs, nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt.toISOString() : null, deliveredAt: d.deliveredAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString() };
  }

  private async sub(me: Me, id: string) {
    this.assertAdmin(me);
    const s = await this.prisma.webhookSubscription.findFirst({ where: { id, orgId: me.orgId } });
    if (!s) throw new NotFoundException('Webhook not found');
    return s;
  }

  async list(me: Me) {
    this.assertAdmin(me);
    return this.view(await this.prisma.webhookSubscription.findMany({ where: { orgId: me.orgId }, orderBy: { createdAt: 'desc' } }));
  }

  async create(me: Me, body: unknown, ip?: string): Promise<WebhookCreated> {
    this.assertAdmin(me);
    const input = parse(webhookCreateSchema, body);
    await assertSafeUrl(input.url);
    const count = await this.prisma.webhookSubscription.count({ where: { orgId: me.orgId } });
    if (count >= 20) throw new BadRequestException('At most 20 webhooks');
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    const s = await this.prisma.webhookSubscription.create({ data: { orgId: me.orgId, url: input.url, description: input.description || null, events: [...new Set(input.events)], secretEnc: seal(secret), createdById: me.id } });
    this.cache.delete(me.orgId);
    await this.audit.log(me, 'webhook.created', 'WebhookSubscription', s.id, undefined, { url: s.url, events: s.events }, ip);
    return { secret, row: (await this.view([s]))[0] };
  }

  async update(me: Me, id: string, body: unknown, ip?: string): Promise<WebhookView> {
    const s = await this.sub(me, id);
    const input = parse(webhookUpdateSchema, body);
    if (input.url) await assertSafeUrl(input.url);
    const updated = await this.prisma.webhookSubscription.update({ where: { id }, data: { ...(input.url ? { url: input.url } : {}), ...(input.description !== undefined ? { description: input.description || null } : {}), ...(input.events ? { events: [...new Set(input.events)] } : {}), ...(input.active !== undefined ? { active: input.active, ...(input.active ? { failingSince: null } : {}) } : {}) } });
    this.cache.delete(me.orgId);
    await this.audit.log(me, 'webhook.updated', 'WebhookSubscription', id, { url: s.url, events: s.events, active: s.active }, input, ip);
    return (await this.view([updated]))[0];
  }

  async remove(me: Me, id: string, ip?: string) {
    const s = await this.sub(me, id);
    await this.prisma.webhookDelivery.deleteMany({ where: { subscriptionId: id } });
    await this.prisma.webhookSubscription.delete({ where: { id } });
    this.cache.delete(me.orgId);
    await this.audit.log(me, 'webhook.deleted', 'WebhookSubscription', id, { url: s.url }, undefined, ip);
    return { ok: true as const };
  }

  async rotate(me: Me, id: string, ip?: string): Promise<WebhookCreated> {
    await this.sub(me, id);
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    const s = await this.prisma.webhookSubscription.update({ where: { id }, data: { secretEnc: seal(secret) } });
    await this.audit.log(me, 'webhook.secret_rotated', 'WebhookSubscription', id, undefined, undefined, ip);
    return { secret, row: (await this.view([s]))[0] };
  }

  async test(me: Me, id: string): Promise<WebhookDeliveryView> {
    const s = await this.sub(me, id);
    const payload: WebhookPayload = { id: `evt_${randomBytes(10).toString('hex')}`, type: 'ping', occurredAt: new Date().toISOString(), entity: 'WebhookSubscription', entityId: s.id, data: { message: 'Test event from BMU Hub' } };
    const d = await this.prisma.webhookDelivery.create({ data: { orgId: me.orgId, subscriptionId: s.id, type: 'ping', payload: payload as unknown as Prisma.InputJsonValue, nextAttemptAt: new Date(Date.now() + 2 * 60_000) } });
    return this.deliveryView(await this.send(d));
  }

  async deliveries(me: Me, id: string): Promise<WebhookDeliveryView[]> {
    await this.sub(me, id);
    return (await this.prisma.webhookDelivery.findMany({ where: { subscriptionId: id }, orderBy: { createdAt: 'desc' }, take: 50 })).map((d) => this.deliveryView(d));
  }

  async redeliver(me: Me, deliveryId: string): Promise<WebhookDeliveryView> {
    this.assertAdmin(me);
    const old = await this.prisma.webhookDelivery.findFirst({ where: { id: deliveryId, orgId: me.orgId } });
    if (!old) throw new NotFoundException('Delivery not found');
    const d = await this.prisma.webhookDelivery.create({ data: { orgId: me.orgId, subscriptionId: old.subscriptionId, type: old.type, payload: old.payload as Prisma.InputJsonValue, nextAttemptAt: new Date(Date.now() + 2 * 60_000) } });
    return this.deliveryView(await this.send(d));
  }
}
