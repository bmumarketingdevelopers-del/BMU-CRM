// v16 creative studio: brand kits overview, the client's own brand kit, content channels per client, the publishing
// rule (client approval, or BMU approval for clients who allow it), captions, post results, and two timers: posts due
// to go out and usage rights ending.
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  contentChannelInputSchema,
  DELIVER_SOCIAL_TYPES,
  postCaptionSchema,
  postMetricInputSchema,
  publishRuleSchema,
  type BrandKitListItem,
  type ContentChannelView,
  type CreativeSettingsView,
  type DeliverChannel,
  type Me,
  type PostResultsSummary,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { CraftService } from '../craft/craft.service.js';
import { DeliverCalendarService } from '../deliver/deliver-calendar.service.js';
import { visibleEngagementWhere } from '../engagements/engagement-access.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductionService } from '../production/production.service.js';
import { AssetsService } from './assets.service.js';
import { ProofingService } from './proofing.service.js';
import { amOf, clientScope, hasRole, isLeadership } from './scope.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const DAY = 86_400_000;
const TICK_MS = 5 * 60_000;
const SCHEDULERS = ['founder', 'admin', 'am_lead', 'account_manager', 'strategist', 'department_head'];
const day = (d: Date) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(d);

@Injectable()
export class CreativeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Creative');
  private job?: JobHandle;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly proofing: ProofingService,
    private readonly ref: ModuleRef,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'creative.timers', hint: 'Proofing reminders and creative calendar rules', everyMs: TICK_MS, run: () => this.tick() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  private calendar() {
    return this.ref.get(DeliverCalendarService, { strict: false });
  }

  private canSchedule(me: Me) {
    return me.type === 'staff' && me.roles.some((r) => SCHEDULERS.includes(r));
  }

  // ------------------------------------------------------------------------------------------------ brand kits

  async brandKits(me: Me): Promise<BrandKitListItem[]> {
    const scope = await clientScope(this.prisma, me);
    const clients = await this.prisma.clientOrg.findMany({ where: { orgId: me.orgId, deletedAt: null, archivedAt: null, ...(scope === 'all' ? {} : { id: { in: scope } }) }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    const ids = clients.map((c) => c.id);
    const [kits, files] = await Promise.all([
      this.prisma.craftBrandKit.findMany({ where: { clientOrgId: { in: ids } } }),
      this.prisma.file.groupBy({ by: ['clientOrgId'], where: { clientOrgId: { in: ids }, tags: { has: 'brand' }, archivedAt: null }, _count: { _all: true } }),
    ]);
    return clients.map((c) => {
      const k = kits.find((x) => x.clientOrgId === c.id);
      const n = files.find((f) => f.clientOrgId === c.id)?._count._all ?? 0;
      // How complete the kit is: colours, fonts, tone, do's, don'ts, logo/brand files.
      const parts = [!!k?.colours.length, !!k?.fonts.length, !!k?.tone, !!k?.dos.length, !!k?.donts.length, n > 0];
      return { clientId: c.id, client: c.name, colours: k?.colours ?? [], fonts: k?.fonts ?? [], files: n, complete: Math.round((parts.filter(Boolean).length / parts.length) * 100), updatedAt: k?.updatedAt.toISOString() ?? null };
    });
  }

  async clientBrandKit(me: Me) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    return this.ref.get(CraftService, { strict: false }).brandKitView(me.clientOrg.id);
  }

  // ------------------------------------------------------------------------------------------------ channels and the publishing rule

  async settings(me: Me): Promise<CreativeSettingsView> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const scope = await clientScope(this.prisma, me);
    const clientWhere: Prisma.ClientOrgWhereInput = { orgId: me.orgId, deletedAt: null, archivedAt: null, ...(scope === 'all' ? {} : { id: { in: scope } }) };
    const [clients, channels] = await Promise.all([
      this.prisma.clientOrg.findMany({ where: clientWhere, select: { id: true, name: true, publishNeedsApproval: true }, orderBy: { name: 'asc' } }),
      this.prisma.contentChannel.findMany({ where: { orgId: me.orgId, ...(scope === 'all' ? {} : { clientOrgId: { in: scope } }) }, orderBy: [{ clientOrgId: 'asc' }, { platform: 'asc' }] }),
    ]);
    const names = new Map(clients.map((c) => [c.id, c.name]));
    return {
      channels: channels.filter((c) => names.has(c.clientOrgId)).map((c): ContentChannelView => ({ id: c.id, clientId: c.clientOrgId, client: names.get(c.clientOrgId) ?? 'Client', platform: c.platform as DeliverChannel, handle: c.handle, url: c.url })),
      rules: clients.map((c) => ({ clientId: c.id, client: c.name, publishNeedsApproval: c.publishNeedsApproval })),
      canEdit: this.canSchedule(me),
    };
  }

  private async assertClientManager(me: Me, clientOrgId: string) {
    if (!this.canSchedule(me)) throw new ForbiddenException('Only client managers, strategists, department heads and leadership manage channels');
    const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId, deletedAt: null } });
    if (!c) throw new NotFoundException('Client not found');
    const scope = await clientScope(this.prisma, me);
    if (scope !== 'all' && !scope.includes(c.id)) throw new ForbiddenException('You can only manage clients you work on');
    return c;
  }

  async addChannel(me: Me, body: unknown, ip?: string) {
    const input = parse(contentChannelInputSchema, body);
    await this.assertClientManager(me, input.clientOrgId);
    const handle = input.handle.trim();
    const dup = await this.prisma.contentChannel.findFirst({ where: { clientOrgId: input.clientOrgId, platform: input.platform, handle } });
    if (dup) throw new BadRequestException('That account is already added');
    const c = await this.prisma.contentChannel.create({ data: { orgId: me.orgId, clientOrgId: input.clientOrgId, platform: input.platform, handle, url: input.url ?? null, createdById: me.id } });
    await this.audit.log(me, 'content_channel.added', 'ClientOrg', input.clientOrgId, undefined, { id: c.id, platform: c.platform, handle }, ip);
    return this.settings(me);
  }

  async removeChannel(me: Me, id: string, ip?: string) {
    const c = await this.prisma.contentChannel.findFirst({ where: { id, orgId: me.orgId } });
    if (!c) throw new NotFoundException('Channel not found');
    await this.assertClientManager(me, c.clientOrgId);
    await this.prisma.contentChannel.delete({ where: { id } });
    await this.audit.log(me, 'content_channel.removed', 'ClientOrg', c.clientOrgId, { platform: c.platform, handle: c.handle }, undefined, ip);
    return this.settings(me);
  }

  /** Founder, Branch Manager, CM Lead or the client's CM decide whether BMU may approve posts for this client. */
  async setPublishRule(me: Me, clientOrgId: string, body: unknown, ip?: string) {
    const input = parse(publishRuleSchema, body);
    const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId, deletedAt: null } });
    if (!c) throw new NotFoundException('Client not found');
    if (!isLeadership(me) && c.amUserId !== me.id) throw new ForbiddenException("Only leadership or the client's Client Manager can change who approves posts");
    await this.prisma.clientOrg.update({ where: { id: clientOrgId }, data: { publishNeedsApproval: input.publishNeedsApproval } });
    await this.audit.log(me, 'client.publish_rule_changed', 'ClientOrg', clientOrgId, { publishNeedsApproval: c.publishNeedsApproval }, input, ip);
    return this.settings(me);
  }

  // ------------------------------------------------------------------------------------------------ posts

  private async post(me: Me, id: string, manage = true) {
    if (manage && !this.canSchedule(me)) throw new ForbiddenException('Only client managers, strategists, department heads and leadership manage posts');
    const d = await this.prisma.deliverable.findFirst({
      where: { id, orgId: me.orgId, cycle: { engagement: await visibleEngagementWhere(this.prisma, me) } },
      include: { cycle: { select: { engagementId: true, engagement: { select: { amId: true, clientOrgId: true, clientOrg: { select: { name: true, publishNeedsApproval: true } } } } } }, versions: { orderBy: { number: 'asc' } } },
    });
    if (!d) throw new NotFoundException('Post not found');
    return d;
  }

  async setCaption(me: Me, id: string, body: unknown, ip?: string) {
    const { caption } = parse(postCaptionSchema, body);
    const d = await this.post(me, id);
    if (d.status === 'published') throw new BadRequestException('This post is already published');
    await this.prisma.deliverable.update({ where: { id }, data: { caption: caption || null } });
    await this.audit.log(me, 'post.caption_saved', 'Deliverable', id, { caption: d.caption }, { caption }, ip);
    return this.calendar().item(id);
  }

  async recordResults(me: Me, id: string, body: unknown, ip?: string) {
    const input = parse(postMetricInputSchema, body);
    const d = await this.post(me, id);
    if (d.status !== 'published') throw new BadRequestException('Results can be added once the post is published');
    await this.prisma.postMetric.create({ data: { orgId: me.orgId, deliverableId: id, reach: input.reach, impressions: input.impressions, engagement: input.engagement, clicks: input.clicks, spendPaise: Math.round(input.spendRupees * 100), recordedById: me.id } });
    await this.audit.log(me, 'post.results_recorded', 'Deliverable', id, undefined, input, ip);
    return this.calendar().item(id);
  }

  /**
   * For clients who let BMU approve posts (publishing rule off): the CM or leadership approves a QC-passed post.
   * Recorded as an approval "via BMU" with a certificate, exactly like a client approval.
   */
  async approveInternally(me: Me, id: string, ip?: string) {
    const d = await this.post(me, id, false);
    if (d.cycle.engagement.clientOrg.publishNeedsApproval) throw new ForbiddenException(`${d.cycle.engagement.clientOrg.name} approves their own posts. Send it to them for review.`);
    if (!isLeadership(me) && d.cycle.engagement.amId !== me.id && (await amOf(this.prisma, d.cycle.engagement.clientOrgId)) !== me.id) throw new ForbiddenException("Only leadership or the client's Client Manager can approve on BMU's side");
    if (!(DELIVER_SOCIAL_TYPES as readonly string[]).includes(d.type)) throw new BadRequestException('Only social posts, reels, stories and ads can be approved this way');
    const v = d.versions.at(-1);
    if (!v || !['qc_passed', 'ready_for_client'].includes(d.status)) throw new BadRequestException('Only a version that passed QC can be approved');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.approval.create({ data: { orgId: d.orgId, targetType: 'deliverable', targetId: d.id, gate: 'G4', userId: me.id, at: now, versionId: v.id, via: 'bmu', ip: ip ?? null } }),
      this.prisma.deliverable.update({ where: { id: d.id }, data: { status: 'approved', approvedVersionId: v.id } }),
      this.prisma.task.updateMany({ where: { deliverableId: d.id, status: { in: ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] } }, data: { status: 'done', completedAt: now } }),
    ]);
    await this.audit.log(me, 'deliverable.approved', 'Deliverable', d.id, undefined, { versionId: v.id, number: v.number, via: 'bmu' }, ip);
    await this.proofing.issueCertificate(d.id, v.id);
    await this.ref.get(AssetsService, { strict: false }).fromApprovedDeliverable(d.id);
    await this.ref.get(ProductionService, { strict: false }).afterClientDecision(d.cycleId, d.cycle.engagementId, d.orgId);
    return this.calendar().item(id);
  }

  async results(me: Me, from?: string, to?: string, clientOrgId?: string): Promise<PostResultsSummary> {
    const f = from ? new Date(from) : new Date(Date.now() - 30 * DAY);
    const t = to ? new Date(to) : new Date();
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t <= f) throw new BadRequestException('Pick a valid date range');
    const where: Prisma.DeliverableWhereInput = clientOrgId
      ? { orgId: me.orgId, status: 'published', publishedAt: { gte: f, lt: t }, cycle: { engagement: { clientOrgId } } }
      : { orgId: me.orgId, status: 'published', publishedAt: { gte: f, lt: t }, cycle: { engagement: await visibleEngagementWhere(this.prisma, me) } };
    const posts = await this.prisma.deliverable.findMany({ where, select: { id: true, title: true, channel: true, liveUrl: true, cycle: { select: { engagement: { select: { clientOrg: { select: { id: true, name: true } } } } } } }, take: 2000 });
    const metrics = posts.length ? await this.prisma.postMetric.findMany({ where: { deliverableId: { in: posts.map((p) => p.id) } }, orderBy: { createdAt: 'desc' } }) : [];
    const latest = new Map<string, (typeof metrics)[number]>();
    for (const m of metrics) if (!latest.has(m.deliverableId)) latest.set(m.deliverableId, m);
    const totals = { reach: 0, impressions: 0, engagement: 0, clicks: 0, spendPaise: 0 };
    const byClient = new Map<string, PostResultsSummary['byClient'][number]>();
    for (const p of posts) {
      const c = p.cycle.engagement.clientOrg;
      const row = byClient.get(c.id) ?? { clientId: c.id, client: c.name, posts: 0, reach: 0, engagement: 0, clicks: 0, spendPaise: 0 };
      row.posts++;
      const m = latest.get(p.id);
      if (m) {
        totals.reach += m.reach;
        totals.impressions += m.impressions;
        totals.engagement += m.engagement;
        totals.clicks += m.clicks;
        totals.spendPaise += m.spendPaise;
        row.reach += m.reach;
        row.engagement += m.engagement;
        row.clicks += m.clicks;
        row.spendPaise += m.spendPaise;
      }
      byClient.set(c.id, row);
    }
    const top = posts
      .filter((p) => latest.has(p.id))
      .map((p) => ({ deliverableId: p.id, title: p.title, client: p.cycle.engagement.clientOrg.name, channel: p.channel, reach: latest.get(p.id)!.reach, engagement: latest.get(p.id)!.engagement, liveUrl: p.liveUrl }))
      .sort((a, b) => b.engagement - a.engagement || b.reach - a.reach)
      .slice(0, 5);
    return { from: f.toISOString(), to: t.toISOString(), posts: posts.length, withResults: latest.size, totals, byClient: [...byClient.values()].sort((a, b) => b.reach - a.reach), top };
  }

  async clientResults(me: Me, from?: string, to?: string) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    return this.results(me, from, to, me.clientOrg.id);
  }

  // ------------------------------------------------------------------------------------------------ timers

  /** Posts due to go out tell the CM once; usage rights ending within 7 days warn the asset owner and the CM once. */
  async tick(now = new Date(), orgId?: string) {
    const org = orgId ? { orgId } : {};
    const due = await this.prisma.deliverable.findMany({
      where: { ...org, status: 'scheduled', scheduledAt: { lte: now }, publishDueNotifiedAt: null },
      select: { id: true, orgId: true, title: true, channel: true, cycle: { select: { engagement: { select: { amId: true, clientOrg: { select: { name: true } } } } } } },
      take: 100,
    });
    for (const d of due) {
      await this.prisma.deliverable.update({ where: { id: d.id }, data: { publishDueNotifiedAt: now } });
      await this.notifications.notify(d.orgId, [d.cycle.engagement.amId], {
        kind: 'post_due',
        title: `Time to post: ${d.title} (${d.cycle.engagement.clientOrg.name})`,
        body: `Scheduled for ${d.channel ?? 'social'}. Post it, then mark it published with the live link.`,
        link: '/team/content-calendar',
      });
    }
    const ending = await this.prisma.asset.findMany({
      where: { ...org, archivedAt: null, rightsWarnedAt: null, rightsExpireAt: { gte: now, lte: new Date(now.getTime() + 7 * DAY) } },
      select: { id: true, orgId: true, title: true, clientOrgId: true, createdById: true, rightsExpireAt: true },
      take: 100,
    });
    for (const a of ending) {
      await this.prisma.asset.update({ where: { id: a.id }, data: { rightsWarnedAt: now } });
      await this.notifications.notify(a.orgId, [a.createdById, await amOf(this.prisma, a.clientOrgId)], {
        kind: 'asset_rights',
        title: `Usage rights end ${day(a.rightsExpireAt!)}: ${a.title}`,
        body: 'Stop using it after that date, or renew the licence and update the asset.',
        link: `/team/assets/${a.id}`,
      });
    }
    return { due: due.length, rights: ending.length };
  }

  async runTimers(me: Me) {
    if (!hasRole(me, 'founder', 'admin')) throw new ForbiddenException('Founder and Branch Managers only');
    return this.tick(new Date(), me.orgId);
  }
}
