import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  orgChartDescendants,
  personRoleTitle,
  type Me,
  type OrgChartAdd,
  type OrgChartInput,
  type OrgChartList,
  type OrgChartMemberUpdate,
  type OrgChartUpdate,
  type OrgChartView,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertPeopleReader, peopleCan } from '../people-actions/people-access.js';

/**
 * v51 Custom charts: extra org charts built from existing team members, apart from the real hierarchy. Anyone who can
 * open the Hierarchy Tree can look at them; the Founder and Branch Managers build and change them. Chart only: nothing
 * here touches a person's manager, department, team, approvals, daily reports, alerts or access.
 */
@Injectable()
export class OrgChartsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private canEdit(me: Me) {
    return peopleCan(me).addUnit;
  }

  private assertEditor(me: Me) {
    assertPeopleReader(me);
    if (!this.canEdit(me)) throw new ForbiddenException('Only the Founder or a Branch Manager can change custom charts');
  }

  private async find(me: Me, id: string) {
    const chart = await this.prisma.orgChart.findFirst({ where: { id, orgId: me.orgId }, include: { members: { orderBy: { createdAt: 'asc' } } } });
    if (!chart) throw new NotFoundException('Chart not found');
    return chart;
  }

  private async nameFree(me: Me, name: string, except?: string) {
    const clash = await this.prisma.orgChart.findFirst({ where: { orgId: me.orgId, name: { equals: name, mode: 'insensitive' }, ...(except ? { id: { not: except } } : {}) }, select: { id: true } });
    if (clash) throw new ConflictException('A chart with that name already exists');
  }

  /** Active team members of this organisation (the only people who can be added). */
  private async activeStaff(orgId: string, ids?: string[]) {
    return this.prisma.user.findMany({
      where: { orgId, type: 'staff', deletedAt: null, leftAt: null, status: { not: 'suspended' }, ...(ids ? { id: { in: ids } } : {}) },
      select: { id: true, managerId: true },
    });
  }

  private async touch(id: string) {
    await this.prisma.orgChart.update({ where: { id }, data: { updatedAt: new Date() } });
  }

  async list(me: Me): Promise<OrgChartList> {
    assertPeopleReader(me);
    const charts = await this.prisma.orgChart.findMany({ where: { orgId: me.orgId }, orderBy: { name: 'asc' }, include: { members: { select: { userId: true, parentUserId: true } } } });
    const ids = [...new Set(charts.flatMap((c) => [...c.members.filter((m) => !m.parentUserId).map((m) => m.userId), c.createdById ?? '']).filter(Boolean))];
    const names = new Map((ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
    return {
      canEdit: this.canEdit(me),
      charts: charts.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        memberCount: c.members.length,
        top: c.members.filter((m) => !m.parentUserId).map((m) => names.get(m.userId) ?? 'Former team member'),
        createdBy: c.createdById ? (names.get(c.createdById) ?? null) : null,
        updatedAt: c.updatedAt.toISOString(),
      })),
    };
  }

  async view(me: Me, id: string): Promise<OrgChartView> {
    assertPeopleReader(me);
    const chart = await this.find(me, id);
    const people = await this.prisma.user.findMany({
      where: { id: { in: [...chart.members.map((m) => m.userId), ...(chart.createdById ? [chart.createdById] : [])] } },
      select: { id: true, name: true, photoUrl: true, specialty: true, deletedAt: true, leftAt: true, status: true, department: { select: { name: true } }, roles: { select: { role: { select: { name: true, baseRole: true } } } } },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    return {
      id: chart.id,
      name: chart.name,
      description: chart.description,
      createdBy: chart.createdById ? (byId.get(chart.createdById)?.name ?? null) : null,
      updatedAt: chart.updatedAt.toISOString(),
      canEdit: this.canEdit(me),
      members: chart.members.map((m) => {
        const p = byId.get(m.userId);
        return {
          userId: m.userId,
          name: p?.name ?? 'Former team member',
          photoUrl: p?.photoUrl ?? null,
          title: p ? personRoleTitle(p.roles.map((r) => r.role), { specialty: p.specialty, department: p.department?.name }) : '',
          department: p?.department?.name ?? null,
          parentUserId: m.parentUserId,
          label: m.label,
          former: !p || !!p.deletedAt || !!p.leftAt || p.status === 'suspended',
        };
      }),
    };
  }

  async create(me: Me, input: OrgChartInput & { startFrom: 'empty' | 'reporting' }, ip?: string): Promise<OrgChartView> {
    this.assertEditor(me);
    await this.nameFree(me, input.name);
    const staff = input.startFrom === 'reporting' ? await this.activeStaff(me.orgId) : [];
    const inChart = new Set(staff.map((s) => s.id));
    const chart = await this.prisma.orgChart.create({
      data: {
        orgId: me.orgId,
        name: input.name,
        description: input.description || null,
        createdById: me.id,
        // A copy of today's reporting lines; someone whose manager has left goes to the top.
        members: { create: staff.map((s) => ({ userId: s.id, parentUserId: s.managerId && inChart.has(s.managerId) && s.managerId !== s.id ? s.managerId : null })) },
      },
    });
    if (input.startFrom === 'reporting') await this.breakLoops(chart.id);
    await this.audit.log(me, 'org_chart.created', 'OrgChart', chart.id, null, { name: input.name, startFrom: input.startFrom, people: staff.length }, ip);
    return this.view(me, chart.id);
  }

  /** Reporting lines copied in could (in bad data) loop; anyone caught in a loop goes to the top. */
  private async breakLoops(chartId: string) {
    const members = await this.prisma.orgChartMember.findMany({ where: { chartId }, select: { userId: true, parentUserId: true } });
    const parent = new Map(members.map((m) => [m.userId, m.parentUserId]));
    const loose: string[] = [];
    for (const m of members) {
      const seen = new Set<string>([m.userId]);
      for (let p = parent.get(m.userId); p; p = parent.get(p)) {
        if (seen.has(p)) {
          loose.push(m.userId);
          parent.set(m.userId, null);
          break;
        }
        seen.add(p);
      }
    }
    if (loose.length) await this.prisma.orgChartMember.updateMany({ where: { chartId, userId: { in: loose } }, data: { parentUserId: null } });
  }

  async update(me: Me, id: string, input: OrgChartUpdate, ip?: string): Promise<OrgChartView> {
    this.assertEditor(me);
    const chart = await this.find(me, id);
    if (input.name !== undefined) await this.nameFree(me, input.name, id);
    await this.prisma.orgChart.update({ where: { id }, data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description || null } : {}) } });
    await this.audit.log(me, 'org_chart.updated', 'OrgChart', id, { name: chart.name, description: chart.description }, input, ip);
    return this.view(me, id);
  }

  async remove(me: Me, id: string, ip?: string): Promise<{ ok: true }> {
    this.assertEditor(me);
    const chart = await this.find(me, id);
    await this.prisma.orgChart.delete({ where: { id } });
    await this.audit.log(me, 'org_chart.deleted', 'OrgChart', id, { name: chart.name, people: chart.members.length }, null, ip);
    return { ok: true };
  }

  async addMember(me: Me, id: string, input: { userId: string; parentUserId: string | null; label?: string | null }, ip?: string): Promise<OrgChartView> {
    this.assertEditor(me);
    const chart = await this.find(me, id);
    if (chart.members.some((m) => m.userId === input.userId)) throw new ConflictException('They are already in this chart');
    if (!(await this.activeStaff(me.orgId, [input.userId])).length) throw new BadRequestException('Pick a current team member');
    if (input.parentUserId && !chart.members.some((m) => m.userId === input.parentUserId)) throw new BadRequestException('The person above them must be in this chart');
    await this.prisma.orgChartMember.create({ data: { chartId: id, userId: input.userId, parentUserId: input.parentUserId, label: input.label || null } });
    await this.touch(id);
    await this.audit.log(me, 'org_chart.person_added', 'OrgChart', id, null, { userId: input.userId, parentUserId: input.parentUserId, label: input.label ?? null }, ip);
    return this.view(me, id);
  }

  async updateMember(me: Me, id: string, userId: string, input: OrgChartMemberUpdate, ip?: string): Promise<OrgChartView> {
    this.assertEditor(me);
    const chart = await this.find(me, id);
    const member = chart.members.find((m) => m.userId === userId);
    if (!member) throw new NotFoundException('They are not in this chart');
    if (input.parentUserId !== undefined && input.parentUserId !== null) {
      if (input.parentUserId === userId) throw new BadRequestException('Someone cannot sit under themselves');
      if (!chart.members.some((m) => m.userId === input.parentUserId)) throw new BadRequestException('The person above them must be in this chart');
      if (orgChartDescendants(chart.members, userId).has(input.parentUserId)) throw new BadRequestException('They cannot sit under someone who is below them');
    }
    await this.prisma.orgChartMember.update({
      where: { id: member.id },
      data: { ...(input.parentUserId !== undefined ? { parentUserId: input.parentUserId } : {}), ...(input.label !== undefined ? { label: input.label || null } : {}) },
    });
    await this.touch(id);
    await this.audit.log(me, 'org_chart.person_changed', 'OrgChart', id, { userId, parentUserId: member.parentUserId, label: member.label }, { userId, ...input }, ip);
    return this.view(me, id);
  }

  /** Take someone out of a chart; the people under them move up to the person they were under. */
  async removeMember(me: Me, id: string, userId: string, ip?: string): Promise<OrgChartView> {
    this.assertEditor(me);
    const chart = await this.find(me, id);
    const member = chart.members.find((m) => m.userId === userId);
    if (!member) throw new NotFoundException('They are not in this chart');
    await this.prisma.$transaction([
      this.prisma.orgChartMember.updateMany({ where: { chartId: id, parentUserId: userId }, data: { parentUserId: member.parentUserId } }),
      this.prisma.orgChartMember.delete({ where: { id: member.id } }),
    ]);
    await this.touch(id);
    await this.audit.log(me, 'org_chart.person_removed', 'OrgChart', id, { userId, parentUserId: member.parentUserId }, null, ip);
    return this.view(me, id);
  }
}
