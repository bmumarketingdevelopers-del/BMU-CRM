import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import {
  SERVICE_ALWAYS_IN_APP,
  serviceNoticeKindsFor,
  serviceNotificationPrefsSchema,
  type Me,
  type ServiceNotificationPrefsView,
  type ServiceOutboxDetail,
  type ServiceOutboxView,
  type ServiceSatisfaction,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { isLeadership } from '../engagements/engagement-access.js';
import { canReadCommand } from '../insights/access.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { BillingRunService } from './billing-run.service.js';
import { DunningService } from './dunning.service.js';
import { EmailService } from './email.service.js';
import { unreadMessages } from '../requests/messages.service.js';
import { ServiceBillingService } from './service-billing.service.js';

const DAY = 86_400_000;
const isFounderAdmin = (me: Me) => me.type === 'staff' && me.roles.some((r) => r === 'founder' || r === 'admin');

/** v10 service flows: preferences, unread counts, outbox, satisfaction, billing, dunning and billing runs. */
@Controller('service')
export class ServiceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly email: EmailService,
    private readonly billing: ServiceBillingService,
    private readonly dunning: DunningService,
    private readonly runs: BillingRunService,
  ) {}

  // ---------------------------------------------------------------------------
  // Notification preferences

  private async prefsView(me: Me): Promise<ServiceNotificationPrefsView> {
    const audience = me.type === 'client' ? 'client' : 'team';
    const [templates, rows, routing, waiting, user] = await Promise.all([
      this.settings.get(me.orgId, 'notificationTemplates'),
      this.prisma.notificationPreference.findMany({ where: { userId: me.id } }),
      this.prisma.notificationSetting.findUnique({ where: { userId: me.id } }),
      this.prisma.notificationDelivery.count({ where: { userId: me.id, sentAt: null } }),
      this.prisma.user.findUnique({ where: { id: me.id }, select: { phone: true } }),
    ]);
    return {
      email: me.email ?? null,
      audience,
      phone: user?.phone ?? null,
      quietStart: routing?.quietStart ?? null,
      quietEnd: routing?.quietEnd ?? null,
      digest: routing?.digest === 'daily' ? 'daily' : 'off',
      digestHour: routing?.digestHour ?? 18,
      waiting,
      prefs: serviceNoticeKindsFor(audience).map((k) => {
        const row = rows.find((r) => r.kind === k.key);
        const tpl = templates[k.key] ?? { inApp: true, email: false };
        return { kind: k.key, label: k.label, inApp: row?.inApp ?? true, email: row?.email ?? true, whatsapp: row?.whatsapp ?? false, orgInApp: tpl.inApp, orgEmail: tpl.email, locked: SERVICE_ALWAYS_IN_APP.includes(k.key) };
      }),
    };
  }

  @Get('notification-preferences')
  prefs(@CurrentUser() me: Me) {
    if (me.type === 'creator') throw new ForbiddenException('Not available for creator accounts');
    return this.prefsView(me);
  }

  @Put('notification-preferences')
  async savePrefs(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    if (me.type === 'creator') throw new ForbiddenException('Not available for creator accounts');
    const { prefs, quietStart, quietEnd, digest, digestHour } = parse(serviceNotificationPrefsSchema, body);
    const allowed = new Set(serviceNoticeKindsFor(me.type === 'client' ? 'client' : 'team').map((k) => k.key));
    for (const p of prefs) {
      if (!allowed.has(p.kind)) continue;
      const inApp = SERVICE_ALWAYS_IN_APP.includes(p.kind) ? true : p.inApp;
      await this.prisma.notificationPreference.upsert({
        where: { userId_kind: { userId: me.id, kind: p.kind } },
        create: { userId: me.id, orgId: me.orgId, kind: p.kind, inApp, email: p.email, whatsapp: p.whatsapp ?? false },
        update: { inApp, email: p.email, whatsapp: p.whatsapp ?? undefined },
      });
    }
    // v17: quiet hours (both times, or neither) and the daily digest.
    if (quietStart !== undefined || quietEnd !== undefined || digest !== undefined || digestHour !== undefined) {
      const both = quietStart && quietEnd ? { quietStart, quietEnd } : quietStart === undefined && quietEnd === undefined ? {} : { quietStart: null, quietEnd: null };
      await this.prisma.notificationSetting.upsert({
        where: { userId: me.id },
        create: { userId: me.id, orgId: me.orgId, ...both, digest: digest ?? 'off', digestHour: digestHour ?? 18 },
        update: { ...both, digest: digest ?? undefined, digestHour: digestHour ?? undefined },
      });
    }
    await this.audit.log(me, 'user.notification_preferences', 'User', me.id, undefined, { prefs, quietStart, quietEnd, digest, digestHour }, ip);
    return this.prefsView(me);
  }

  // ---------------------------------------------------------------------------
  // Unread messages (badge in the menus)

  @Get('unread')
  async unread(@CurrentUser() me: Me) {
    return { messages: await unreadMessages(this.prisma, me) };
  }

  // ---------------------------------------------------------------------------
  // Outbox (Command Centre → Platform → Outbox)

  private row(r: Prisma.EmailOutboxGetPayload<object>) {
    return { id: r.id, to: r.toEmail, toName: r.toName, subject: r.kind === 'otp' ? r.subject.replace(/\b\d{6}\b/g, '••••••') : r.subject, kind: r.kind, status: r.status, error: r.error, entity: r.entity, entityId: r.entityId, createdAt: r.createdAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null };
  }

  @Get('outbox')
  async outbox(@CurrentUser() me: Me, @Query('status') status?: string, @Query('kind') kind?: string, @Query('q') q?: string): Promise<ServiceOutboxView> {
    if (!isFounderAdmin(me)) throw new ForbiddenException('The outbox is for Founder and Branch Manager');
    const base: Prisma.EmailOutboxWhereInput = { OR: [{ orgId: me.orgId }, { orgId: null }] };
    const where: Prisma.EmailOutboxWhereInput = {
      AND: [
        base,
        ...(status ? [{ status }] : []),
        ...(kind ? [{ kind }] : []),
        ...(q?.trim() ? [{ OR: [{ toEmail: { contains: q.trim(), mode: 'insensitive' as const } }, { subject: { contains: q.trim(), mode: 'insensitive' as const } }] }] : []),
      ],
    };
    const [rows, total, last7Days, failed, byKind] = await Promise.all([
      this.prisma.emailOutbox.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 }),
      this.prisma.emailOutbox.count({ where: base }),
      this.prisma.emailOutbox.count({ where: { AND: [base, { createdAt: { gte: new Date(Date.now() - 7 * DAY) } }] } }),
      this.prisma.emailOutbox.count({ where: { AND: [base, { status: 'failed' }] } }),
      this.prisma.emailOutbox.groupBy({ by: ['kind'], where: base, _count: { _all: true } }),
    ]);
    return {
      rows: rows.map((r) => this.row(r)),
      smtp: { configured: this.email.configured, host: process.env.SMTP_HOST || null, from: this.email.from },
      counts: { total, last7Days, failed, byKind: byKind.map((k) => ({ kind: k.kind, count: k._count._all })).sort((a, b) => b.count - a.count) },
      canResend: this.email.configured,
    };
  }

  private async outboxRow(me: Me, id: string) {
    if (!isFounderAdmin(me)) throw new ForbiddenException('The outbox is for Founder and Branch Manager');
    const r = await this.prisma.emailOutbox.findFirst({ where: { id, OR: [{ orgId: me.orgId }, { orgId: null }] } });
    if (!r) throw new NotFoundException('Email not found');
    return r;
  }

  @Get('outbox/:id')
  async outboxEmail(@CurrentUser() me: Me, @Param('id') id: string): Promise<ServiceOutboxDetail> {
    const r = await this.outboxRow(me, id);
    // Sign-in codes are secrets: never show them to anyone after the fact.
    const hide = (s: string) => (r.kind === 'otp' ? s.replace(/\b\d{6}\b/g, '••••••') : s);
    return { ...this.row(r), subject: hide(r.subject), text: hide(r.text), html: hide(r.html) };
  }

  @Post('outbox/:id/resend')
  @HttpCode(200)
  async resend(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    const r = await this.outboxRow(me, id);
    if (r.kind === 'otp') throw new ForbiddenException('Sign-in codes cannot be re-sent. Ask the person to request a new code.');
    if (!this.email.configured) throw new ForbiddenException('No email server is set up (SMTP_HOST in apps/api/.env), so nothing can be sent yet.');
    await this.email.deliver(r.id);
    await this.audit.log(me, 'email.resent', 'EmailOutbox', r.id, { status: r.status }, undefined, ip);
    return this.outboxEmail(me, id);
  }

  // ---------------------------------------------------------------------------
  // Request satisfaction (feeds Client Health and SLA analytics)

  @Get('satisfaction')
  async satisfaction(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string): Promise<ServiceSatisfaction> {
    if (me.type !== 'staff') throw new ForbiddenException();
    let scope: Prisma.RequestWhereInput = { orgId: me.orgId };
    if (!canReadCommand(me)) {
      if (!me.roles.includes('account_manager')) throw new ForbiddenException('Satisfaction is for Account Managers and leadership');
      scope = { orgId: me.orgId, engagement: { amId: me.id } };
    }
    const end = to && !Number.isNaN(Date.parse(to)) ? new Date(to) : new Date();
    const start = from && !Number.isNaN(Date.parse(from)) ? new Date(from) : new Date(end.getTime() - 90 * DAY);
    const [done, rated, reopened] = await Promise.all([
      this.prisma.request.count({ where: { ...scope, status: 'done', resolvedAt: { gte: start, lte: end } } }),
      this.prisma.request.findMany({
        where: { ...scope, rating: { not: null }, ratedAt: { gte: start, lte: end } },
        select: { id: true, rating: true, ratingComment: true, ratedAt: true, engagement: { select: { clientOrg: { select: { id: true, name: true } } } } },
        orderBy: { ratedAt: 'desc' },
      }),
      this.prisma.request.count({ where: { ...scope, reopenedAt: { gte: start, lte: end } } }),
    ]);
    const up = rated.filter((r) => (r.rating ?? 0) > 0).length;
    const down = rated.length - up;
    const byClient = new Map<string, { clientId: string; client: string; up: number; down: number }>();
    for (const r of rated) {
      const c = r.engagement.clientOrg;
      const row = byClient.get(c.id) ?? { clientId: c.id, client: c.name, up: 0, down: 0 };
      if ((r.rating ?? 0) > 0) row.up++;
      else row.down++;
      byClient.set(c.id, row);
    }
    return {
      up,
      down,
      rated: rated.length,
      done,
      happyPct: rated.length ? Math.round((up / rated.length) * 100) : null,
      reopened,
      byClient: [...byClient.values()].sort((a, b) => b.down - a.down || b.up - a.up),
      recent: rated.slice(0, 20).map((r) => ({ requestId: r.id, client: r.engagement.clientOrg.name, value: (r.rating ?? 0) > 0 ? ('up' as const) : ('down' as const), comment: r.ratingComment, at: r.ratedAt!.toISOString() })),
    };
  }

  // ---------------------------------------------------------------------------
  // Client billing

  @Get('client/billing')
  clientBilling(@CurrentUser() me: Me) {
    return this.billing.clientBilling(me);
  }

  @Get('client/invoices/:id/tax-invoice')
  clientTaxInvoice(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.billing.clientTaxInvoice(me, id);
  }

  @Put('client/billing-details')
  saveClientDetails(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.billing.saveClientDetails(me, body, ip);
  }

  // ---------------------------------------------------------------------------
  // Finance

  @Get('finance/invoices/:id/tax-invoice')
  taxInvoice(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.billing.financeTaxInvoice(me, id);
  }

  @Post('finance/invoices/:id/email')
  @HttpCode(200)
  emailInvoice(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.billing.emailInvoice(me, id, ip);
  }

  @Get('finance/clients/:id/billing-details')
  financeDetails(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.billing.financeDetails(me, id);
  }

  @Put('finance/clients/:id/billing-details')
  saveFinanceDetails(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.billing.saveFinanceDetails(me, id, body, ip);
  }

  @Get('finance/collections')
  collections(@CurrentUser() me: Me) {
    return this.dunning.collections(me);
  }

  @Post('finance/invoices/:id/promise')
  @HttpCode(200)
  promise(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.dunning.promise(me, id, body, ip);
  }

  @Post('finance/invoices/:id/remind')
  @HttpCode(200)
  remind(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.dunning.remindNow(me, id, ip);
  }

  @Post('finance/dunning/run')
  @HttpCode(200)
  runDunning(@CurrentUser() me: Me) {
    return this.dunning.runNow(me);
  }

  @Get('finance/billing-run')
  billingRunPreview(@CurrentUser() me: Me, @Query('period') period?: string) {
    return this.runs.preview(me, period);
  }

  @Post('finance/billing-run')
  @HttpCode(200)
  billingRunIssue(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.runs.issue(me, body, ip);
  }

  @Get('finance/billing-runs')
  billingRuns(@CurrentUser() me: Me) {
    return this.runs.runs(me);
  }
}
