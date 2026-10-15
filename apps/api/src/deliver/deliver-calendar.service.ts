// v10 deliver: content calendar. Approved social deliverables get a date/time and channel, then go
// scheduled → published (with the live link). Team and client both see what goes out when.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DELIVER_SOCIAL_TYPES, type DeliverCalendarItem, type DeliverCalendarView, type DeliverChannel, type Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { visibleEngagementWhere } from '../engagements/engagement-access.js';

const SCHEDULERS = ['founder', 'admin', 'am_lead', 'account_manager', 'strategist', 'department_head'];
const include = {
  cycle: { select: { engagementId: true, engagement: { select: { amId: true, clientOrg: { select: { id: true, name: true, publishNeedsApproval: true } }, service: { select: { name: true } } } } } },
  versions: { include: { file: true } },
} satisfies Prisma.DeliverableInclude;
type Row = Prisma.DeliverableGetPayload<{ include: typeof include }>;

@Injectable()
export class DeliverCalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** v16: latest results per post. */
  private async metricsFor(ids: string[]) {
    const rows = ids.length ? await this.prisma.postMetric.findMany({ where: { deliverableId: { in: ids } }, orderBy: { createdAt: 'desc' } }) : [];
    const out = new Map<string, NonNullable<DeliverCalendarItem['metrics']>>();
    for (const m of rows) if (!out.has(m.deliverableId)) out.set(m.deliverableId, { reach: m.reach, impressions: m.impressions, engagement: m.engagement, clicks: m.clicks, spendPaise: m.spendPaise, at: m.createdAt.toISOString() });
    return out;
  }

  async item(id: string, client = false): Promise<DeliverCalendarItem> {
    const d = await this.prisma.deliverable.findUniqueOrThrow({ where: { id }, include });
    return this.toItem(d, client, await this.metricsFor([id]));
  }

  private toItem(d: Row, client: boolean, metrics?: Map<string, NonNullable<DeliverCalendarItem['metrics']>>): DeliverCalendarItem {
    const v = d.versions.find((x) => x.id === d.approvedVersionId) ?? null;
    const now = Date.now();
    return {
      deliverableId: d.id,
      title: d.title,
      type: d.type,
      status: d.status,
      client: d.cycle.engagement.clientOrg,
      engagementId: d.cycle.engagementId,
      serviceName: d.cycle.engagement.service.name,
      scheduledAt: d.scheduledAt?.toISOString() ?? null,
      channel: (d.channel as DeliverChannel | null) ?? null,
      publishedAt: d.publishedAt?.toISOString() ?? null,
      liveUrl: d.liveUrl,
      preview: v && (!client || v.sentToClientAt) ? { kind: v.file.kind, url: v.file.kind === 'link' ? v.file.path : `/api/files/${v.file.id}` } : null,
      caption: d.caption,
      approved: !!d.approvedVersionId,
      dueToPublish: d.status === 'scheduled' && !!d.scheduledAt && d.scheduledAt.getTime() <= now,
      metrics: metrics?.get(d.id) ?? null,
    };
  }

  private range(from?: string, to?: string) {
    const f = from ? new Date(from) : new Date(Date.now() - 31 * 86_400_000);
    const t = to ? new Date(to) : new Date(Date.now() + 62 * 86_400_000);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t <= f) throw new BadRequestException('Pick a valid date range');
    if (t.getTime() - f.getTime() > 400 * 86_400_000) throw new BadRequestException('Pick at most a year');
    return { f, t };
  }

  canSchedule(me: Me) {
    return me.type === 'staff' && me.roles.some((r) => SCHEDULERS.includes(r));
  }

  async team(me: Me, from?: string, to?: string): Promise<DeliverCalendarView> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const { f, t } = this.range(from, to);
    const scope: Prisma.DeliverableWhereInput = { orgId: me.orgId, cycle: { engagement: await visibleEngagementWhere(this.prisma, me) } };
    const [items, unscheduled] = await Promise.all([
      this.prisma.deliverable.findMany({
        where: { AND: [scope, { OR: [{ scheduledAt: { gte: f, lt: t } }, { scheduledAt: null, publishedAt: { gte: f, lt: t } }] }] },
        include,
        orderBy: { scheduledAt: 'asc' },
      }),
      this.prisma.deliverable.findMany({
        // Approved social work without a date: recent or undated first; work due more than 60 days ago is left out.
        where: {
          AND: [scope, { status: 'approved', scheduledAt: null, approvedVersionId: { not: null }, type: { in: [...DELIVER_SOCIAL_TYPES] } }, { OR: [{ dueAt: null }, { dueAt: { gte: new Date(Date.now() - 60 * 86_400_000) } }] }],
        },
        include,
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
        take: 150,
      }),
    ]);
    // v16: posts whose time has come but are not marked published yet (any date).
    const due = await this.prisma.deliverable.findMany({ where: { AND: [scope, { status: 'scheduled', scheduledAt: { lte: new Date() } }] }, include, orderBy: { scheduledAt: 'asc' }, take: 50 });
    const metrics = await this.metricsFor(items.map((d) => d.id));
    return {
      from: f.toISOString(),
      to: t.toISOString(),
      items: items.map((d) => this.toItem(d, false, metrics)),
      unscheduled: unscheduled.map((d) => this.toItem(d, false)),
      canSchedule: this.canSchedule(me),
      dueToPublish: due.map((d) => this.toItem(d, false)),
    };
  }

  async client(me: Me, from?: string, to?: string): Promise<DeliverCalendarView> {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    const { f, t } = this.range(from, to);
    const items = await this.prisma.deliverable.findMany({
      where: {
        cycle: { engagement: { clientOrgId: me.clientOrg.id, deletedAt: null } },
        status: { in: ['scheduled', 'published'] },
        OR: [{ scheduledAt: { gte: f, lt: t } }, { scheduledAt: null, publishedAt: { gte: f, lt: t } }],
      },
      include,
      orderBy: { scheduledAt: 'asc' },
    });
    const metrics = await this.metricsFor(items.map((d) => d.id));
    return { from: f.toISOString(), to: t.toISOString(), items: items.map((d) => this.toItem(d, true, metrics)), unscheduled: [], canSchedule: false };
  }

  private async loadForTeam(me: Me, id: string) {
    if (!this.canSchedule(me)) throw new ForbiddenException('Only client managers, strategists, department heads and leadership manage the content calendar');
    const d = await this.prisma.deliverable.findFirst({ where: { id, orgId: me.orgId, cycle: { engagement: await visibleEngagementWhere(this.prisma, me) } }, include });
    if (!d) throw new NotFoundException('Deliverable not found');
    return d;
  }

  async schedule(me: Me, id: string, input: { scheduledAt: string; channel: DeliverChannel }, ip?: string) {
    const d = await this.loadForTeam(me, id);
    if (!(DELIVER_SOCIAL_TYPES as readonly string[]).includes(d.type)) throw new BadRequestException('Only social posts, reels, stories and ads go on the content calendar');
    if (d.status === 'published') throw new BadRequestException('This post is already published');
    if (!['approved', 'scheduled'].includes(d.status) || !d.approvedVersionId) throw new BadRequestException(d.cycle.engagement.clientOrg.publishNeedsApproval ? 'Only work the client has approved can be scheduled' : 'Approve it first (the client, or BMU for this client) before it goes on the calendar');
    const at = new Date(input.scheduledAt);
    const updated = await this.prisma.deliverable.update({ where: { id }, data: { scheduledAt: at, channel: input.channel, status: 'scheduled', publishDueNotifiedAt: null }, include });
    await this.audit.log(me, d.scheduledAt ? 'deliverable.rescheduled' : 'deliverable.scheduled', 'Deliverable', id, { scheduledAt: d.scheduledAt, channel: d.channel }, { scheduledAt: at.toISOString(), channel: input.channel }, ip);
    return this.toItem(updated, false, await this.metricsFor([id]));
  }

  async unschedule(me: Me, id: string, ip?: string) {
    const d = await this.loadForTeam(me, id);
    if (d.status !== 'scheduled') throw new BadRequestException('Only scheduled posts can be taken off the calendar');
    const updated = await this.prisma.deliverable.update({ where: { id }, data: { scheduledAt: null, channel: null, status: 'approved' }, include });
    await this.audit.log(me, 'deliverable.unscheduled', 'Deliverable', id, { scheduledAt: d.scheduledAt }, undefined, ip);
    return this.toItem(updated, false);
  }

  async publish(me: Me, id: string, liveUrl: string, ip?: string) {
    const d = await this.loadForTeam(me, id);
    if (d.status !== 'scheduled') throw new BadRequestException('Schedule the post first, then mark it published');
    // v16: never published without an approved version on record.
    if (!d.approvedVersionId) throw new BadRequestException('This post has no approval on record, so it cannot be published');
    const now = new Date();
    const updated = await this.prisma.deliverable.update({ where: { id }, data: { status: 'published', publishedAt: now, liveUrl }, include });
    await this.audit.log(me, 'deliverable.published', 'Deliverable', id, { status: 'scheduled' }, { liveUrl, publishedAt: now.toISOString() }, ip);
    const clientOrgId = d.cycle.engagement.clientOrg.id;
    await this.notifications.notify(me.orgId, await this.notifications.clientDeciders(clientOrgId), {
      kind: 'post_published',
      title: `${d.title} is live`,
      body: liveUrl,
      link: '/client/calendar',
    });
    return this.toItem(updated, false);
  }
}
