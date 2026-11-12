import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { HR_ISSUE_CATEGORIES, HR_ISSUE_STATUSES, type HrIssueCategory, type HrIssueInput, type HrIssueStatus, type HrIssueUpdate, type HrIssueView, type Me } from '@bmu/shared';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Row = { id: string; userId: string; category: string; subject: string; details: string; status: string; response: string | null; handledById: string | null; createdAt: Date; updatedAt: Date; resolvedAt: Date | null };

const isHr = (me: Me) => me.type === 'staff' && me.roles.includes('hr_ops');
const LINK = '/team/hr-issues';

/**
 * v50 Raise an issue with HR. Any team member raises a concern; every HR person is told and can reply and resolve it.
 * Confidential: only the person who raised it and HR see it. Not their manager, Department Head or leadership, and it
 * is kept out of the Audit Log (which leadership reads). HR never handle an issue they raised themselves.
 */
@Injectable()
export class HrIssuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private async hrPeople(orgId: string, except: string) {
    const rows = await this.prisma.user.findMany({
      where: { orgId, type: 'staff', status: 'active', deletedAt: null, id: { not: except }, roles: { some: { role: { baseRole: 'hr_ops' } } } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async views(rows: Row[], withFrom: boolean): Promise<HrIssueView[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.handledById, withFrom ? r.userId : null]).filter((x): x is string => !!x))];
    const people = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, department: { select: { name: true } } } }) : [];
    const byId = new Map(people.map((p) => [p.id, p]));
    return rows.map((r) => ({
      id: r.id,
      category: r.category as HrIssueCategory,
      subject: r.subject,
      details: r.details,
      status: r.status as HrIssueStatus,
      response: r.response,
      handledBy: r.handledById ? (byId.get(r.handledById)?.name ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      ...(withFrom ? { from: { id: r.userId, name: byId.get(r.userId)?.name ?? 'Former team member', department: byId.get(r.userId)?.department?.name ?? null } } : {}),
    }));
  }

  async raise(me: Me, input: HrIssueInput): Promise<HrIssueView> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const hr = await this.hrPeople(me.orgId, me.id);
    if (!hr.length) throw new BadRequestException('No one in HR is set up in BMU Hub yet. Please speak to your manager.');
    const row = await this.prisma.hrIssue.create({ data: { orgId: me.orgId, userId: me.id, ...input } });
    await this.notifications.notify(me.orgId, hr, {
      kind: 'hr_issue',
      title: `New issue for HR: ${input.subject}`,
      body: `${me.name} · ${HR_ISSUE_CATEGORIES[input.category]}`,
      link: LINK,
    });
    return (await this.views([row], false))[0];
  }

  async mine(me: Me): Promise<HrIssueView[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const rows = await this.prisma.hrIssue.findMany({ where: { orgId: me.orgId, userId: me.id }, orderBy: { createdAt: 'desc' }, take: 100 });
    return this.views(rows, false);
  }

  /** HR's list. Default: still open (open + in progress). */
  async inbox(me: Me, status?: string): Promise<HrIssueView[]> {
    if (!isHr(me)) throw new ForbiddenException('Only HR can see issues raised with HR');
    const where =
      status === 'all' ? {} : status && status in HR_ISSUE_STATUSES ? { status } : { status: { in: ['open', 'in_progress'] } };
    const rows = await this.prisma.hrIssue.findMany({ where: { orgId: me.orgId, userId: { not: me.id }, ...where }, orderBy: { createdAt: 'desc' }, take: 200 });
    return this.views(rows, true);
  }

  async update(me: Me, id: string, input: HrIssueUpdate): Promise<HrIssueView> {
    if (!isHr(me)) throw new ForbiddenException('Only HR can reply to issues raised with HR');
    const row = await this.prisma.hrIssue.findFirst({ where: { id, orgId: me.orgId } });
    if (!row) throw new NotFoundException('Issue not found');
    if (row.userId === me.id) throw new ForbiddenException('Another HR person handles an issue you raised');
    const replied = input.response !== undefined && input.response !== (row.response ?? '');
    const status = input.status ?? (replied && row.status === 'open' ? 'in_progress' : row.status);
    const saved = await this.prisma.hrIssue.update({
      where: { id },
      data: {
        status,
        ...(input.response !== undefined ? { response: input.response || null } : {}),
        handledById: me.id,
        resolvedAt: status === 'resolved' ? (row.resolvedAt ?? new Date()) : null,
      },
    });
    // The person hears about a reply or a change of status, never who else in HR saw it.
    const title = replied
      ? `HR replied to your issue: ${row.subject}`
      : status !== row.status
        ? status === 'resolved'
          ? `Your issue was resolved: ${row.subject}`
          : `${HR_ISSUE_STATUSES[status as HrIssueStatus]}: ${row.subject}`
        : null;
    if (title) await this.notifications.notify(me.orgId, [row.userId], { kind: 'hr_issue_update', title, body: replied ? (input.response ?? '').slice(0, 140) : undefined, link: LINK });
    return (await this.views([saved], true))[0];
  }
}
