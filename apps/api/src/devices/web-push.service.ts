// v44 browser notifications: every in-app notification is also sent to the browsers people turned notifications on
// in (Web Push, signed with the server's VAPID keys). The browser's service worker shows it, so it arrives in another
// tab, with the browser minimised, with the CRM tab closed, and (where the browser keeps running in the background)
// with the browser closed. Quiet hours hold it back like phone pushes; critical ones always go. Only while the sign-in
// it was turned on in is still valid: signing out (here, or by an admin) or the session ending stops it.
import { BadRequestException, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';
import webpush from 'web-push';
import { webPushSubscribeSchema, type Me, type WebPushConfig, type WebPushPayload } from '@bmu/shared';
import { parse } from '../common/zod.js';
import { inQuietHours, onNotificationsCreated, type CreatedNotice } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isServerless } from '../runtime/process-role.js';

/** A day: an alert that can't be delivered by then (browser off for longer) is dropped by the push service. */
const TTL_SECONDS = 24 * 3600;

/** The push services of Chrome / Edge / Opera / Brave (FCM), Firefox, Edge on Windows (WNS) and Safari. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];

function vapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  const owner = process.env.OWNER_EMAIL?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim() || (owner ? `mailto:${owner}` : 'mailto:hello@bmumarketing.in');
  return { publicKey, privateKey, subject };
}

/** Only real browser push services (the server posts to this address, so it must never be an internal one). */
export function allowedPushEndpoint(endpoint: string, env: NodeJS.ProcessEnv = process.env) {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  // Tests and stand-in push services: WEB_PUSH_ALLOW_HOSTS=127.0.0.1,push.example.com
  const extra = (env.WEB_PUSH_ALLOW_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (extra.includes(u.hostname.toLowerCase())) return true;
  return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname.toLowerCase()));
}

@Injectable()
export class WebPushService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WebPush');
  private off?: () => void;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.off = onNotificationsCreated((rows) => {
      const sending = this.deliver(rows).catch((e: Error) => this.log.warn(e.message));
      // On Vercel the function is frozen once the answer is sent; waitUntil keeps it alive until the pushes have gone.
      if (isServerless()) waitUntil(sending);
    });
  }

  onModuleDestroy() {
    this.off?.();
  }

  async config(me: Me): Promise<WebPushConfig> {
    const v = vapid();
    const devices = await this.prisma.webPushSubscription.count({ where: { userId: me.id } });
    return { available: !!v, publicKey: v?.publicKey ?? null, devices };
  }

  /** Turns browser notifications on for this browser (or moves it to whoever is signed in now). */
  async subscribe(me: Me, body: unknown, userAgent?: string): Promise<WebPushConfig> {
    if (!vapid()) throw new BadRequestException('Browser notifications are not set up on the server yet');
    const input = parse(webPushSubscribeSchema, body);
    if (!allowedPushEndpoint(input.endpoint)) throw new BadRequestException("This browser's notification service isn't supported. Try Chrome, Edge, Firefox or Safari.");
    const data = { orgId: me.orgId, userId: me.id, sessionId: me.sessionId ?? null, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null, lastSeenAt: new Date() };
    await this.prisma.webPushSubscription.upsert({ where: { endpoint: input.endpoint }, create: { endpoint: input.endpoint, ...data }, update: data });
    return this.config(me);
  }

  async unsubscribe(me: Me, endpoint: string): Promise<WebPushConfig> {
    await this.prisma.webPushSubscription.deleteMany({ where: { endpoint, userId: me.id } });
    return this.config(me);
  }

  /** A sample alert to every browser this person turned notifications on in. */
  async test(me: Me) {
    if (!vapid()) throw new BadRequestException('Browser notifications are not set up on the server yet');
    const subs = await this.live(await this.prisma.webPushSubscription.findMany({ where: { userId: me.id } }));
    if (!subs.length) throw new BadRequestException('Turn on browser notifications first');
    const home = me.type === 'client' ? '/client' : me.type === 'creator' ? '/creator' : '/team';
    const sent = await this.send(subs, { id: `test-${Date.now()}`, title: 'Browser notifications are on', body: 'BMU Hub alerts will show like this, even when the CRM tab is closed.', link: home, critical: false });
    return { sent };
  }

  /** Sends newly created notifications to their people's browsers. Returns how many were delivered. */
  async deliver(rows: CreatedNotice[], now = new Date()): Promise<number> {
    if (!rows.length || !vapid()) return 0;
    const subs = await this.live(await this.prisma.webPushSubscription.findMany({ where: { userId: { in: [...new Set(rows.map((r) => r.userId))] } } }), now);
    if (!subs.length) return 0;
    const routing = await this.prisma.notificationSetting.findMany({ where: { userId: { in: [...new Set(subs.map((s) => s.userId))] } } });
    let sent = 0;
    for (const r of rows) {
      const quiet = routing.find((x) => x.userId === r.userId);
      if (!r.critical && quiet && inQuietHours(quiet.quietStart, quiet.quietEnd, now)) continue;
      const mine = subs.filter((s) => s.userId === r.userId);
      if (mine.length) sent += await this.send(mine, { id: r.id, title: r.title, body: r.body, link: r.link, critical: r.critical });
    }
    return sent;
  }

  /** Subscriptions whose sign-in is still valid (not signed out, not past its end). */
  private async live<T extends { sessionId: string | null }>(subs: T[], now = new Date()): Promise<T[]> {
    const ids = [...new Set(subs.map((s) => s.sessionId).filter((x): x is string => !!x))];
    if (!ids.length) return subs;
    const ok = new Set((await this.prisma.userSession.findMany({ where: { id: { in: ids }, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, select: { id: true } })).map((x) => x.id));
    return subs.filter((s) => !s.sessionId || ok.has(s.sessionId));
  }

  private async send(subs: { id: string; endpoint: string; p256dh: string; auth: string }[], p: WebPushPayload): Promise<number> {
    const v = vapid();
    if (!v) return 0;
    // Push messages are limited to about 4 KB.
    const payload = JSON.stringify({ ...p, title: p.title.slice(0, 200), body: p.body?.slice(0, 1000) ?? null });
    const gone: string[] = [];
    const results = await Promise.all(
      subs.map(async (s) => {
        try {
          // web-push encrypts the message for this browser and signs it (VAPID); fetch sends it.
          const r = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { vapidDetails: v, TTL: TTL_SECONDS, urgency: p.critical ? 'high' : 'normal' });
          const res = await fetch(r.endpoint, { method: r.method, headers: r.headers as Record<string, string>, body: r.body ? new Uint8Array(r.body) : undefined, signal: AbortSignal.timeout(10_000) });
          if (res.ok) return true;
          // The browser turned notifications off, or the subscription expired: stop sending to it.
          if (res.status === 404 || res.status === 410) gone.push(s.id);
          else this.log.warn(`Browser push not sent: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
        } catch (e) {
          this.log.warn(`Browser push not sent: ${(e as Error).message}`);
        }
        return false;
      }),
    );
    if (gone.length) await this.prisma.webPushSubscription.deleteMany({ where: { id: { in: gone } } });
    return results.filter(Boolean).length;
  }
}
