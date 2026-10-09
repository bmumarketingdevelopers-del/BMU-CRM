// v19 auto-publishing. Every minute, approved posts whose time has come go out to the client's connected account for
// that channel (Instagram, Facebook page, LinkedIn page or YouTube). Posts without a connected account keep the v16
// flow (the AM is told it is due and marks it published by hand). Failures retry after 5, 15 and 60 minutes, then
// stop and tell the AM and leadership. Never publishes without an approved version on record.
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CHANNEL_PROVIDER, PROVIDER_INFO, type IntegrationProvider, type Me, type PublicationView } from '@bmu/shared';
import { resolve } from 'node:path';
import type { IntegrationAccount, PostPublication } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { hasRole } from '../creative/scope.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { storageRoot } from '../production/production.controller.js';
import { signToken } from './crypto.js';
import { apiPublicUrl, IntegrationsService } from './integrations.service.js';
import { connectorFor, type PostMedia, type PublishResult } from './providers/index.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const RETRY_MIN = [5, 15, 60];
const MAX_ATTEMPTS = 3;
const SCHEDULERS = ['founder', 'admin', 'am_lead', 'account_manager', 'strategist', 'department_head'];

@Injectable()
export class PublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Publisher');
  private job?: JobHandle;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly hub: IntegrationsService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'integrations.publisher', hint: 'Publishes scheduled social posts', everyMs: 60_000, run: () => this.tick() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  /** The connected account that publishes a client's posts on a channel (live accounts before test ones). */
  async accountFor(orgId: string, clientOrgId: string, channel: string | null): Promise<IntegrationAccount | null> {
    const provider = channel ? CHANNEL_PROVIDER[channel] : undefined;
    if (!provider) return null;
    const rows = await this.prisma.integrationAccount.findMany({ where: { orgId, clientOrgId, provider, status: { in: ['connected', 'error'] } }, orderBy: { createdAt: 'desc' } });
    return rows.find((r) => r.mode === 'live') ?? rows[0] ?? null;
  }

  async tick(now = new Date()) {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      const due = await this.prisma.deliverable.findMany({
        where: { status: 'scheduled', scheduledAt: { lte: now }, approvedVersionId: { not: null }, archivedAt: null, channel: { in: Object.keys(CHANNEL_PROVIDER) } },
        select: { id: true, orgId: true, channel: true, cycle: { select: { engagement: { select: { clientOrgId: true } } } } },
        take: 50,
        orderBy: { scheduledAt: 'asc' },
      });
      if (!due.length) return 0;
      const pubs = new Map((await this.prisma.postPublication.findMany({ where: { deliverableId: { in: due.map((d) => d.id) } } })).map((p) => [p.deliverableId, p]));
      for (const d of due) {
        const p = pubs.get(d.id);
        if (p && (p.status === 'published' || p.status === 'failed' || (p.status === 'publishing' && p.updatedAt.getTime() > now.getTime() - 10 * 60_000) || (p.nextAttemptAt && p.nextAttemptAt > now))) continue;
        const account = await this.accountFor(d.orgId, d.cycle.engagement.clientOrgId, d.channel);
        if (!account) continue;
        const r = await this.publishOne(d.id, account, now);
        if (r?.status === 'published') sent++;
      }
    } finally {
      this.running = false;
    }
    return sent;
  }

  /** Builds the media a provider needs: a signed public link (Instagram and Facebook fetch it) and the file on disk. */
  private async media(deliverableId: string): Promise<PostMedia> {
    const d = await this.prisma.deliverable.findUniqueOrThrow({ where: { id: deliverableId }, select: { approvedVersionId: true } });
    const v = d.approvedVersionId ? await this.prisma.version.findUnique({ where: { id: d.approvedVersionId }, include: { file: true } }) : null;
    if (!v) return { kind: 'none', url: null, mimeType: null, localPath: null };
    if (v.file.kind === 'link') return { kind: 'link', url: v.file.path, mimeType: null, localPath: null };
    const mime = v.file.mimeType ?? '';
    const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'none';
    const root = storageRoot();
    const abs = resolve(root, v.file.path);
    return { kind, mimeType: mime || null, localPath: abs.startsWith(root) ? abs : null, url: `${apiPublicUrl()}/public/media/${signToken({ f: v.file.id }, 6 * 3600)}` };
  }

  /** Sends one post. Safe to call twice: a publication already publishing or published is left alone. */
  async publishOne(deliverableId: string, account: IntegrationAccount, now = new Date()): Promise<PostPublication | null> {
    const existing = await this.prisma.postPublication.findUnique({ where: { deliverableId } });
    if (existing?.status === 'published') return existing;
    // Claim it so two timers (or a timer and a "Publish now" press) never send the same post twice.
    const claim = existing
      ? await this.prisma.postPublication.updateMany({ where: { id: existing.id, status: { in: ['queued', 'failed'] } }, data: { status: 'publishing', accountId: account.id, attempts: { increment: 1 } } })
      : { count: (await this.prisma.postPublication.create({ data: { orgId: account.orgId, deliverableId, accountId: account.id, status: 'publishing', attempts: 1 } }).catch(() => null)) ? 1 : 0 };
    if (!claim.count) return existing;
    const pub = await this.prisma.postPublication.findUniqueOrThrow({ where: { deliverableId } });
    const d = await this.prisma.deliverable.findUniqueOrThrow({ where: { id: deliverableId }, select: { id: true, orgId: true, title: true, caption: true, status: true, approvedVersionId: true, cycle: { select: { engagement: { select: { clientOrgId: true, amId: true, clientOrg: { select: { name: true } } } } } } } });
    if (!d.approvedVersionId) {
      return this.prisma.postPublication.update({ where: { id: pub.id }, data: { status: 'failed', error: 'This post has no approval on record, so it was not published' } });
    }
    const media = await this.media(deliverableId);
    const label = PROVIDER_INFO[account.provider as IntegrationProvider]?.label ?? account.provider;
    const run = await this.hub.runJob<PublishResult>(account, 'publish', async (ctx) => {
      const c = connectorFor(account.provider as IntegrationProvider, account.mode);
      if (!c.publish) throw new Error(`${label} accounts cannot publish`);
      return { items: 1, result: await c.publish(ctx, { deliverableId, title: d.title, caption: d.caption ?? '', media }) };
    });
    if (run.result) {
      const at = new Date();
      const liveUrl = run.result.url ?? `${apiPublicUrl()}/public/test-posts/${encodeURIComponent(run.result.externalId)}`;
      const done = await this.prisma.postPublication.update({ where: { id: pub.id }, data: { status: 'published', externalId: run.result.externalId, url: liveUrl, error: null, publishedAt: at, nextAttemptAt: null } });
      if (d.status === 'scheduled') {
        await this.prisma.deliverable.update({ where: { id: d.id }, data: { status: 'published', publishedAt: at, liveUrl } });
        await this.audit.logSystem(d.orgId, 'deliverable.published', 'Deliverable', d.id, { liveUrl, publishedAt: at.toISOString(), auto: true, provider: account.provider, account: account.name, mode: account.mode });
        await this.notifications.notify(d.orgId, await this.notifications.clientDeciders(d.cycle.engagement.clientOrgId), { kind: 'post_published', title: `${d.title} is live`, body: liveUrl, link: '/client/calendar' });
      }
      return done;
    }
    const attempts = pub.attempts;
    const final = attempts >= MAX_ATTEMPTS;
    const failed = await this.prisma.postPublication.update({
      where: { id: pub.id },
      data: { status: final ? 'failed' : 'queued', error: run.error, nextAttemptAt: final ? null : new Date(now.getTime() + RETRY_MIN[Math.min(attempts - 1, RETRY_MIN.length - 1)] * 60_000) },
    });
    if (final) {
      await this.audit.logSystem(d.orgId, 'post.publish_failed', 'Deliverable', d.id, { provider: account.provider, account: account.name, error: run.error, attempts });
      await this.hub.alert({ orgId: d.orgId, clientOrgId: d.cycle.engagement.clientOrgId }, `${d.title} could not be published to ${label}`, `${run.error ?? 'Unknown error'}. Fix it and press Retry on Integrations, or post it by hand and mark it published.`);
    }
    return failed;
  }

  private canPublish(me: Me) {
    if (me.type !== 'staff' || !hasRole(me, ...SCHEDULERS)) throw new ForbiddenException('Only Account Managers, strategists and leadership can publish posts');
  }

  async publishNow(me: Me, deliverableId: string, ip?: string): Promise<PublicationView> {
    this.canPublish(me);
    const d = await this.prisma.deliverable.findFirst({ where: { id: deliverableId, orgId: me.orgId }, select: { id: true, status: true, channel: true, approvedVersionId: true, cycle: { select: { engagement: { select: { clientOrgId: true } } } } } });
    if (!d) throw new NotFoundException('Post not found');
    if (d.status !== 'scheduled') throw new BadRequestException('Schedule the post (date and channel) first');
    if (!d.approvedVersionId) throw new BadRequestException('This post has no approval on record, so it cannot be published');
    const account = await this.accountFor(me.orgId, d.cycle.engagement.clientOrgId, d.channel);
    if (!account) throw new BadRequestException(`No ${d.channel ?? ''} account is connected for this client. Connect one on Integrations, or post it by hand and mark it published.`.replace('  ', ' '));
    await this.prisma.postPublication.updateMany({ where: { deliverableId, status: 'failed' }, data: { status: 'queued', attempts: 0, nextAttemptAt: null } });
    await this.audit.log(me, 'post.publish_requested', 'Deliverable', deliverableId, undefined, { accountId: account.id }, ip);
    const p = await this.publishOne(deliverableId, account);
    return (await this.hub.publicationViews(p ? [p] : []))[0];
  }

  async retry(me: Me, id: string, ip?: string): Promise<PublicationView> {
    this.canPublish(me);
    const p = await this.prisma.postPublication.findFirst({ where: { id, orgId: me.orgId } });
    if (!p) throw new NotFoundException('Publication not found');
    if (p.status !== 'failed' && p.status !== 'queued') throw new BadRequestException('Only a failed post can be retried');
    return this.publishNow(me, p.deliverableId, ip);
  }

  async byPost(me: Me, deliverableId: string): Promise<PublicationView | null> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const p = await this.prisma.postPublication.findFirst({ where: { deliverableId, orgId: me.orgId } });
    return p ? (await this.hub.publicationViews([p]))[0] : null;
  }
}
