import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { HR_ISSUE_CATEGORIES, HR_ISSUE_STATUSES, type HrIssueCategory, type HrIssueInput, type HrIssueRaisedTo, type HrIssueSetup, type HrIssueStatus, type HrIssueUpdate, type HrIssueView, type Me } from '@bmu/shared';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Row = { id: string; userId: string; raisedTo: string; category: string; subject: string; details: string; status: string; response: string | null; handledById: string | null; createdAt: Date; updatedAt: Date; resolvedAt: Date | null };

const isHr = (me: Me) => me.type === 'staff' && me.roles.includes('hr_ops');
/** v52: the Branch Manager and the Founder answer issues raised by HR people. */
const LEADERSHIP = ['admin', 'founder'];
const isLeadership = (me: Me) => me.type === 'staff' && me.roles.some((r) => LEADERSHIP.includes(r));
/** Who answers each kind of issue. */
const handles = (me: Me, to: string) => (to === 'leadership' ? isLeadership(me) : isHr(me));
const LINK = '/team/hr-issues';

/**
 * v50 Raise an issue with HR. Any team member raises a concern; every HR person is told and can reply and resolve it.
 * Confidential: only the person who raised it and HR see it. Not their manager, Department Head or leadership, and it
 * is kept out of the Audit Log (which leadership reads). HR never handle an issue they raised themselves.
 * v52: HR people (HR / Ops role or the HR department) raise theirs with the Branch Manager and the Founder instead, who
 * see only those issues, never the ones raised with HR.
 */
@Injectable()
export class HrIssuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The people who answer issues raised with HR, or (leadership) with the Branch Manager and Founder. */
  private async handlers(orgId: string, to: HrIssueRaisedTo, except: string) {
    const roles = to === 'leadership' ? LEADERSHIP : ['hr_ops'];
    const rows = await this.prisma.user.findMany({
      where: { orgId, type: 'staff', status: 'active', deletedAt: null, id: { not: except }, roles: { some: { role: { baseRole: { in: roles } } } } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** HR people (HR / Ops role, or in the HR department) raise their issues with leadership; everyone else with HR. */
  private async raisesTo(me: Me): Promise<HrIssueRaisedTo> {
    if (isHr(me)) return 'leadership';
    const u = await this.prisma.user.findUnique({ where: { id: me.id }, select: { department: { select: { name: true, deletedAt: true } } } });
    const dept = u?.department && !u.department.deletedAt ? u.department.name : '';
    return /^hr\b/i.test(dept.trim()) ? 'leadership' : 'hr';
  }

  async setup(me: Me): Promise<HrIssueSetup> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    return { raisesTo: await this.raisesTo(me), handlesHr: isHr(me), handlesLeadership: isLeadership(me) };
  }

  private async views(rows: Row[], withFrom: boolean): Promise<HrIssueView[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.handledById, withFrom ? r.userId : null]).filter((x): x is string => !!x))];
    const people = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, department: { select: { name: true } } } }) : [];
    const byId = new Map(people.map((p) => [p.id, p]));
    return rows.map((r) => ({
      id: r.id,
      raisedTo: (r.raisedTo === 'leadership' ? 'leadership' : 'hr') as HrIssueRaisedTo,
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
    const raisedTo = await this.raisesTo(me);
    const to = await this.handlers(me.orgId, raisedTo, me.id);
    if (!to.length)
      throw new BadRequestException(raisedTo === 'leadership' ? 'No Branch Manager or Founder is set up in BMU Hub yet.' : 'No one in HR is set up in BMU Hub yet. Please speak to your manager.');
    const row = await this.prisma.hrIssue.create({ data: { orgId: me.orgId, userId: me.id, raisedTo, ...input } });
    await this.notifications.notify(me.orgId, to, {
      kind: 'hr_issue',
      title: raisedTo === 'leadership' ? `Issue raised by HR: ${input.subject}` : `New issue for HR: ${input.subject}`,
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

  /** The issues this person answers: HR the ones raised with HR, the Branch Manager and Founder the ones raised by HR. Default: still open. */
  async inbox(me: Me, status?: string): Promise<HrIssueView[]> {
    const answers = [...(isHr(me) ? ['hr'] : []), ...(isLeadership(me) ? ['leadership'] : [])];
    if (!answers.length) throw new ForbiddenException('Only HR, the Branch Manager or the Founder can see raised issues');
    const where =
      status === 'all' ? {} : status && status in HR_ISSUE_STATUSES ? { status } : { status: { in: ['open', 'in_progress'] } };
    const rows = await this.prisma.hrIssue.findMany({ where: { orgId: me.orgId, userId: { not: me.id }, raisedTo: { in: answers }, ...where }, orderBy: { createdAt: 'desc' }, take: 200 });
    return this.views(rows, true);
  }

  async update(me: Me, id: string, input: HrIssueUpdate): Promise<HrIssueView> {
    const row = await this.prisma.hrIssue.findFirst({ where: { id, orgId: me.orgId } });
    // Someone who doesn't answer this kind of issue can't tell it exists.
    if (!row || !handles(me, row.raisedTo)) throw new NotFoundException('Issue not found');
    if (row.userId === me.id) throw new ForbiddenException('Someone else handles an issue you raised');
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
    const who = row.raisedTo === 'leadership' ? me.name : 'HR';
    const title = replied
      ? `${who} replied to your issue: ${row.subject}`
      : status !== row.status
        ? status === 'resolved'
          ? `Your issue was resolved: ${row.subject}`
          : `${HR_ISSUE_STATUSES[status as HrIssueStatus]}: ${row.subject}`
        : null;
    if (title) await this.notifications.notify(me.orgId, [row.userId], { kind: 'hr_issue_update', title, body: replied ? (input.response ?? '').slice(0, 140) : undefined, link: LINK });
    return (await this.views([saved], true))[0];
  }
}
