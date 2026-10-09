import { Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Logger, Post } from '@nestjs/common';
import { z } from 'zod';
import { SERVICE_ALWAYS_IN_APP, serviceNoticeGroup, type Me, type NotificationView } from '@bmu/shared';
import { CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { appUrl, EmailService, type EmailInput } from '../service/email.service.js';
import { WhatsAppSender } from '../comms/whatsapp.sender.js';

/** email: override the email built from the notice (e.g. an invoice email with the tax invoice inside). */
export type Notice = {
  kind: string;
  title: string;
  body?: string;
  link?: string;
  critical?: boolean;
  email?: Partial<Pick<EmailInput, 'subject' | 'heading' | 'paragraphs' | 'htmlBlock' | 'textBlock' | 'button' | 'entity' | 'entityId'>>;
  /** Force an email even when the template has email off (the person's own email switch still applies). */
  forceEmail?: boolean;
  /** Never email this notice (in-app only). */
  noEmail?: boolean;
  /** v20: the record a phone quick action works on (e.g. the approval id for Approve / Reject). */
  ref?: string;
};

export type CreatedNotice = { id: string; orgId: string; userId: string; kind: string; title: string; body: string | null; link: string | null; critical: boolean; ref?: string };
const createdListeners = new Set<(rows: CreatedNotice[]) => void>();
/** v20: in-app notifications just created (the push sender listens here). */
export function onNotificationsCreated(fn: (rows: CreatedNotice[]) => void) {
  createdListeners.add(fn);
  return () => {
    createdListeners.delete(fn);
  };
}
export function emitNotificationsCreated(rows: CreatedNotice[]) {
  for (const fn of createdListeners) {
    try {
      fn(rows);
    } catch {
      // A listener failing never stops the notice itself.
    }
  }
}

const fillTemplate = (tpl: string, n: Notice) => tpl.replace(/\{(title|body|link)\}/g, (_, k: 'title' | 'body' | 'link') => n[k] ?? '');

type Template = { inApp?: boolean; email?: boolean; whatsapp?: boolean; text?: string };

/** v17: money and approval alerts are never held back by quiet hours or the digest. */
export const NOTICE_NEVER_HELD = ['invoice_issued', 'invoice_reminder', 'request_quote', 'payment_received', 'addon_paid', 'quote_decision'];
const DEDUPE_MS = 10 * 60_000;
const IST = 330 * 60_000;
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minutes past IST midnight. */
export const istMinutes = (d: Date) => Math.floor(((d.getTime() + IST) % 86_400_000) / 60_000);

/** Is `now` inside quiet hours (which may run past midnight, e.g. 21:00 to 08:00)? */
export function inQuietHours(start: string | null, end: string | null, now: Date) {
  if (!start || !end || start === end) return false;
  const m = istMinutes(now);
  const a = toMin(start);
  const b = toMin(end);
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** The next moment the clock reads `hhmm` (or `hour`:00) in IST, after `now`. */
export function nextIst(now: Date, hhmm: string) {
  const midnight = Math.floor((now.getTime() + IST) / 86_400_000) * 86_400_000 - IST;
  let at = midnight + toMin(hhmm) * 60_000;
  if (at <= now.getTime()) at += 86_400_000;
  return new Date(at);
}

/**
 * Command Centre → Notification Templates: an alert switched off for in-app is not stored,
 * and custom text replaces the standard wording of the message body. Returns null when the alert is off.
 */
export async function applyNotificationTemplate(prisma: PrismaService, orgId: string, n: Notice): Promise<(Notice & { channels: string[] }) | null> {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { settings: true } });
  const t = ((org?.settings as { v8?: { notificationTemplates?: Record<string, Template> } } | null)?.v8?.notificationTemplates ?? {})[n.kind];
  if (!t) return { ...n, channels: ['inApp'] };
  const channels = [t.inApp !== false ? 'inApp' : null, t.email ? 'email' : null, t.whatsapp ? 'whatsapp' : null].filter((c): c is string => !!c);
  if (t.inApp === false && !n.critical) return channels.length ? { ...n, channels } : null;
  return { ...n, body: t.text?.trim() ? t.text.trim() : n.body, channels: channels.includes('inApp') ? channels : ['inApp', ...channels] };
}

/**
 * In-app notifications, plus the hook for push / email / WhatsApp templates (communication.notifications).
 * External channels only log in development; every message deep-links to the exact screen.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger('Notify');
  private readonly whatsapp: WhatsAppSender;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly email: EmailService,
  ) {
    this.whatsapp = new WhatsAppSender(prisma);
  }

  /**
   * Sends a notice to people, respecting Command Centre → Notification Templates (in-app / email per kind)
   * and each person's own choices (Profile → Notifications). Critical notices always show in the app.
   */
  async notify(orgId: string, userIds: (string | null | undefined)[], n: Notice) {
    const ids = [...new Set(userIds.filter((x): x is string => !!x))];
    if (!ids.length) return;
    const group = serviceNoticeGroup(n.kind);
    const [templates, prefs, users, routing] = await Promise.all([
      this.settings.get(orgId, 'notificationTemplates'),
      this.prisma.notificationPreference.findMany({ where: { userId: { in: ids }, kind: group } }),
      this.prisma.user.findMany({ where: { id: { in: ids }, deletedAt: null, status: { not: 'suspended' } }, select: { id: true, name: true, email: true, phone: true } }),
      this.prisma.notificationSetting.findMany({ where: { userId: { in: ids } } }),
    ]);
    const tpl = templates[group] ?? { inApp: true, email: false, whatsapp: false, text: '' };
    const always = !!n.critical || SERVICE_ALWAYS_IN_APP.includes(group);
    const pref = (id: string) => prefs.find((p) => p.userId === id);
    let inApp = users.filter((u) => always || (tpl.inApp && pref(u.id)?.inApp !== false));
    // v17: the same unread alert in the last 10 minutes is not repeated (e.g. three quick messages in one thread).
    if (inApp.length && !n.critical) {
      const recent = await this.prisma.notification.findMany({
        where: { userId: { in: inApp.map((u) => u.id) }, kind: n.kind, title: n.title, body: n.body ?? null, link: n.link ?? null, readAt: null, createdAt: { gte: new Date(Date.now() - DEDUPE_MS) } },
        select: { userId: true },
      });
      const dup = new Set(recent.map((r) => r.userId));
      inApp = inApp.filter((u) => !dup.has(u.id));
    }
    if (inApp.length) {
      const rows = await this.prisma.notification.createManyAndReturn({
        data: inApp.map((u) => ({ orgId, userId: u.id, kind: n.kind, title: n.title, body: n.body, link: n.link, critical: n.critical ?? false, ref: n.ref ?? null })),
      });
      emitNotificationsCreated(rows.map((r) => ({ id: r.id, orgId: r.orgId, userId: r.userId, kind: r.kind, title: r.title, body: r.body, link: r.link, critical: r.critical, ref: r.ref ?? undefined })));
    }
    for (const u of inApp) this.log.log(`→ ${u.id}: ${n.title}${n.link ? ` (${n.link})` : ''}`);
    if (n.noEmail) return;
    const now = new Date();
    const urgent = !!n.critical || !!n.forceEmail || !!n.email || NOTICE_NEVER_HELD.includes(group) || NOTICE_NEVER_HELD.includes(n.kind);
    /** Where an email or WhatsApp alert goes: now, after quiet hours, or into the daily digest. */
    const hold = (userId: string, channel: 'email' | 'whatsapp'): { reason: 'quiet' | 'digest'; sendAfter: Date } | null => {
      if (urgent) return null;
      const r = routing.find((x) => x.userId === userId);
      if (!r) return null;
      if (channel === 'email' && r.digest === 'daily') return { reason: 'digest', sendAfter: nextIst(now, `${String(r.digestHour).padStart(2, '0')}:00`) };
      if (inQuietHours(r.quietStart, r.quietEnd, now)) return { reason: 'quiet', sendAfter: nextIst(now, r.quietEnd!) };
      return null;
    };
    const held: { orgId: string; userId: string; channel: string; kind: string; title: string; body: string | null; link: string | null; reason: string; sendAfter: Date }[] = [];

    // WhatsApp copy for people who switched it on and have a phone number.
    for (const u of users) {
      if (!u.phone || !pref(u.id)?.whatsapp) continue;
      const h = hold(u.id, 'whatsapp');
      if (h) held.push({ orgId, userId: u.id, channel: 'whatsapp', kind: group, title: n.title, body: n.body ?? null, link: n.link ?? null, ...h });
      else await this.sendWhatsApp(orgId, u, n.title, n.body ?? null, n.link ?? null);
    }

    const emailOn = tpl.email || !!n.forceEmail;
    if (emailOn) {
      const intro = tpl.text?.trim() ? fillTemplate(tpl.text.trim(), n) : null;
      for (const u of users) {
        if (!u.email || pref(u.id)?.email === false) continue;
        const h = hold(u.id, 'email');
        if (h) {
          held.push({ orgId, userId: u.id, channel: 'email', kind: group, title: n.title, body: [intro, n.body].filter(Boolean).join('\n') || null, link: n.link ?? null, ...h });
          continue;
        }
        await this.email.send({
          orgId,
          to: u.email,
          toName: u.name,
          toUserId: u.id,
          kind: group,
          subject: n.email?.subject ?? n.title,
          heading: n.email?.heading,
          paragraphs: n.email?.paragraphs ?? [`Hi ${u.name.split(' ')[0]},`, ...(intro ? [intro] : []), ...(n.body ? [n.body] : [])],
          htmlBlock: n.email?.htmlBlock,
          textBlock: n.email?.textBlock,
          button: n.email?.button ?? (n.link ? { label: 'Open in BMU Hub', url: n.link } : undefined),
          entity: n.email?.entity,
          entityId: n.email?.entityId,
        });
      }
    }
    if (held.length) await this.prisma.notificationDelivery.createMany({ data: held });
  }

  private async sendWhatsApp(orgId: string, u: { id: string; name: string; phone: string | null }, title: string, body: string | null, link: string | null) {
    if (!u.phone) return;
    const text = [`*${title}*`, body, link ? appUrl(link) : null, '— BMU Hub'].filter(Boolean).join('\n');
    await this.whatsapp.send({ orgId, toPhone: u.phone, toName: u.name, body: text.slice(0, 1500), entity: 'User', entityId: u.id, source: 'notification' });
  }

  /** v17: sends alerts held for quiet hours, and the daily digest emails. Called every minute by the router timer. */
  async flushDue(now = new Date()) {
    const due = await this.prisma.notificationDelivery.findMany({ where: { sentAt: null, sendAfter: { lte: now } }, orderBy: { createdAt: 'asc' }, take: 500 });
    if (!due.length) return { sent: 0, digests: 0 };
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(due.map((d) => d.userId))] } }, select: { id: true, name: true, email: true, phone: true, deletedAt: true } });
    let sent = 0;
    let digests = 0;
    for (const u of users) {
      const mine = due.filter((d) => d.userId === u.id);
      // Claim them first so two servers (or two ticks) never send twice.
      const claimed = await this.prisma.notificationDelivery.updateMany({ where: { id: { in: mine.map((d) => d.id) }, sentAt: null }, data: { sentAt: now } });
      if (!claimed.count || u.deletedAt) continue;
      for (const d of mine.filter((x) => x.reason === 'quiet')) {
        if (d.channel === 'whatsapp') await this.sendWhatsApp(d.orgId, u, d.title, d.body, d.link);
        else if (u.email)
          await this.email.send({ orgId: d.orgId, to: u.email, toName: u.name, toUserId: u.id, kind: d.kind, subject: d.title, paragraphs: [`Hi ${u.name.split(' ')[0]},`, ...(d.body ? [d.body] : [])], button: d.link ? { label: 'Open in BMU Hub', url: d.link } : undefined });
        sent++;
      }
      const digest = mine.filter((x) => x.reason === 'digest');
      if (digest.length && u.email) {
        await this.email.send({
          orgId: digest[0].orgId,
          to: u.email,
          toName: u.name,
          toUserId: u.id,
          kind: 'digest',
          subject: `Your BMU Hub digest: ${digest.length} update${digest.length === 1 ? '' : 's'}`,
          heading: 'Your daily digest',
          paragraphs: [`Hi ${u.name.split(' ')[0]}, here is what happened since your last digest.`, ...digest.slice(0, 40).map((d) => `• ${d.title}${d.body ? `: ${d.body.slice(0, 160)}` : ''}`), ...(digest.length > 40 ? [`…and ${digest.length - 40} more in the app.`] : [])],
          button: { label: 'Open BMU Hub', url: '/' },
        });
        await this.prisma.notificationSetting.updateMany({ where: { userId: u.id }, data: { lastDigestAt: now } });
        digests++;
      }
    }
    return { sent, digests };
  }

  /** Client people who decide on work: owners and approvers of a client account. */
  async clientDeciders(clientOrgId: string) {
    const rows = await this.prisma.clientUser.findMany({ where: { clientOrgId, clientRole: { in: ['client_owner', 'client_approver'] } }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }

  async clientBilling(clientOrgId: string) {
    const rows = await this.prisma.clientUser.findMany({ where: { clientOrgId, clientRole: { in: ['client_owner', 'client_finance'] } }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }

  async list(me: Me): Promise<{ unread: number; items: NotificationView[] }> {
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({ where: { userId: me.id, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.notification.count({ where: { userId: me.id, readAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] } }),
    ]);
    return {
      unread,
      items: items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, critical: n.critical, read: !!n.readAt, at: n.createdAt.toISOString() })),
    };
  }

  async markRead(me: Me, ids: string[] | 'all') {
    await this.prisma.notification.updateMany({
      where: { userId: me.id, readAt: null, ...(ids === 'all' ? {} : { id: { in: ids } }) },
      data: { readAt: new Date() },
    });
    return this.list(me);
  }
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() me: Me) {
    if (!me) throw new ForbiddenException();
    return this.notifications.list(me);
  }

  @Post('read')
  @HttpCode(200)
  read(@CurrentUser() me: Me, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: z.union([z.array(z.string()), z.literal('all')]) }), body);
    return this.notifications.markRead(me, ids);
  }
}
