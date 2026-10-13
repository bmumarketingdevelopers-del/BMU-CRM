import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { sopInputSchema, type Me, type SopMeta, type SopView } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApprovalsService } from '../actions/approvals.service.js';
import { assertOperations, assertStaff, canEditOperations, isFounderOrAdmin } from './access.js';

type SopRow = Prisma.SOPGetPayload<{ include: { department: { select: { id: true; name: true } } } }>;

/** SOP library. Every team member can read; Founder/Admin edit all, department heads edit their department's. */
@Controller('admin-platform/sops')
export class SopsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  /** v11 ops: department heads write drafts; publishing goes to a Branch Manager for approval (approval handler in ops-admin). */
  private async askToPublish(me: Me, sopId: string, content: { title: string; body: string; departmentId: string }, ip?: string) {
    await this.approvals.create(me, { action: 'sop.publish', targetType: 'sop', targetId: sopId, summary: `Publish SOP "${content.title}"`, payload: content, reason: 'Department draft ready to publish', approverId: null, approverRoles: ['admin'] }, ip);
    return 'Sent to a Branch Manager to publish';
  }

  /** Department ids this user may write SOPs in; null = all. */
  private async editable(me: Me): Promise<string[] | null> {
    if (!canEditOperations(me)) return [];
    if (isFounderOrAdmin(me)) return null;
    const [user, headed] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } }),
      this.prisma.department.findMany({ where: { orgId: me.orgId, headUserId: me.id, deletedAt: null }, select: { id: true } }),
    ]);
    return [...new Set([...(user?.departmentId ? [user.departmentId] : []), ...headed.map((d) => d.id)])];
  }

  private view(s: SopRow, editable: string[] | null, acks?: Map<string, number>): SopView {
    return {
      id: s.id,
      title: s.title,
      body: s.body,
      version: s.version,
      department: s.department,
      canEdit: editable === null || editable.includes(s.departmentId),
      status: s.status === 'draft' ? 'draft' : 'published',
      acknowledged: acks?.get(`${s.id}|${s.version}`) ?? 0,
    };
  }

  private async acks(ids: string[]) {
    const rows = ids.length ? await this.prisma.sopAcknowledgement.groupBy({ by: ['sopId', 'version'], where: { sopId: { in: ids } }, _count: true }) : [];
    return new Map(rows.map((r) => [`${r.sopId}|${r.version}`, r._count]));
  }

  /** Drafts are visible only to people who may edit them. */
  private visible(s: { status: string; departmentId: string }, editable: string[] | null) {
    return s.status !== 'draft' || editable === null || editable.includes(s.departmentId);
  }

  private async assertDepartment(me: Me, departmentId: string, editable: string[] | null) {
    const dept = await this.prisma.department.findFirst({ where: { id: departmentId, orgId: me.orgId, deletedAt: null } });
    if (!dept) throw new NotFoundException('Department not found');
    if (editable !== null && !editable.includes(departmentId)) throw new ForbiddenException('Department heads can only edit SOPs for their own department');
  }

  @Get()
  async list(@CurrentUser() me: Me, @Query('q') q?: string, @Query('departmentId') departmentId?: string): Promise<SopView[]> {
    assertStaff(me);
    const term = q?.trim();
    const rows = await this.prisma.sOP.findMany({
      where: {
        orgId: me.orgId,
        ...(departmentId ? { departmentId } : {}),
        ...(term ? { OR: [{ title: { contains: term, mode: 'insensitive' } }, { body: { contains: term, mode: 'insensitive' } }] } : {}),
      },
      include: { department: { select: { id: true, name: true } } },
      orderBy: [{ department: { name: 'asc' } }, { title: 'asc' }],
    });
    const editable = await this.editable(me);
    const shown = rows.filter((s) => this.visible(s, editable));
    const acks = await this.acks(shown.map((s) => s.id));
    return shown.map((s) => this.view(s, editable, acks));
  }

  @Get('meta')
  async meta(@CurrentUser() me: Me): Promise<SopMeta> {
    assertStaff(me);
    const [depts, counts, editable] = await Promise.all([
      this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.sOP.groupBy({ by: ['departmentId'], where: { orgId: me.orgId }, _count: true }),
      this.editable(me),
    ]);
    const editableIds = editable ?? depts.map((d) => d.id);
    return {
      departments: depts.map((d) => ({ ...d, count: counts.find((c) => c.departmentId === d.id)?._count ?? 0 })),
      canCreate: editableIds.length > 0,
      editableDepartmentIds: editableIds,
    };
  }

  @Get(':id')
  async get(@CurrentUser() me: Me, @Param('id') id: string): Promise<SopView> {
    assertStaff(me);
    const s = await this.prisma.sOP.findFirst({ where: { id, orgId: me.orgId }, include: { department: { select: { id: true, name: true } } } });
    const editable = await this.editable(me);
    if (!s || !this.visible(s, editable)) throw new NotFoundException('SOP not found');
    return this.view(s, editable, await this.acks([s.id]));
  }

  @Post()
  async create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string): Promise<SopView & { notice?: string }> {
    assertOperations(me);
    const input = parse(sopInputSchema, body);
    const editable = await this.editable(me);
    await this.assertDepartment(me, input.departmentId, editable);
    const head = !isFounderOrAdmin(me);
    const status = head ? 'draft' : (input.status ?? 'published');
    const s = await this.prisma.sOP.create({
      data: { orgId: me.orgId, title: input.title, body: input.body, departmentId: input.departmentId, status, publishedAt: status === 'published' ? new Date() : null },
      include: { department: { select: { id: true, name: true } } },
    });
    await this.audit.log(me, 'sop.created', 'SOP', s.id, null, { title: s.title, departmentId: s.departmentId, version: 1, body: s.body, status }, ip);
    if (head && (input.status ?? 'published') === 'published') return { ...this.view(s, editable), notice: await this.askToPublish(me, s.id, input, ip) };
    return this.view(s, editable);
  }

  /** Every save is a new version: body replaced, version + 1, before/after kept in the audit log. */
  @Put(':id')
  async update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string): Promise<SopView & { notice?: string }> {
    assertOperations(me);
    const input = parse(sopInputSchema, body);
    const before = await this.prisma.sOP.findFirst({ where: { id, orgId: me.orgId } });
    if (!before) throw new NotFoundException('SOP not found');
    const editable = await this.editable(me);
    await this.assertDepartment(me, before.departmentId, editable);
    if (input.departmentId !== before.departmentId) await this.assertDepartment(me, input.departmentId, editable);
    if (!isFounderOrAdmin(me) && (before.status === 'published' || input.status === 'published')) {
      // A live SOP stays as it is until a Branch Manager approves the department head's change.
      if (before.status !== 'published') await this.prisma.sOP.update({ where: { id }, data: { title: input.title, body: input.body, departmentId: input.departmentId } });
      const notice = await this.askToPublish(me, id, { title: input.title, body: input.body, departmentId: input.departmentId }, ip);
      const cur = await this.prisma.sOP.findUniqueOrThrow({ where: { id }, include: { department: { select: { id: true, name: true } } } });
      return { ...this.view(cur, editable), notice };
    }
    const s = await this.prisma.sOP.update({
      where: { id },
      data: {
        title: input.title,
        body: input.body,
        departmentId: input.departmentId,
        version: { increment: 1 },
        ...(input.status ? { status: input.status, ...(input.status === 'published' && before.status !== 'published' ? { publishedAt: new Date() } : {}) } : {}),
      },
      include: { department: { select: { id: true, name: true } } },
    });
    await this.audit.log(
      me,
      'sop.updated',
      'SOP',
      id,
      { title: before.title, departmentId: before.departmentId, version: before.version, body: before.body },
      { title: s.title, departmentId: s.departmentId, version: s.version, body: s.body },
      ip,
    );
    return this.view(s, editable);
  }

  /** Publish a draft to the team library, or take an SOP back to draft. */
  @Post(':id/status')
  @HttpCode(200)
  async setStatus(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string): Promise<SopView & { notice?: string }> {
    assertOperations(me);
    const { status } = parse(z.object({ status: z.enum(['draft', 'published']) }), body);
    const before = await this.prisma.sOP.findFirst({ where: { id, orgId: me.orgId } });
    if (!before) throw new NotFoundException('SOP not found');
    const editable = await this.editable(me);
    await this.assertDepartment(me, before.departmentId, editable);
    if (status === 'published' && !isFounderOrAdmin(me)) {
      const notice = await this.askToPublish(me, id, { title: before.title, body: before.body, departmentId: before.departmentId }, ip);
      const cur = await this.prisma.sOP.findUniqueOrThrow({ where: { id }, include: { department: { select: { id: true, name: true } } } });
      return { ...this.view(cur, editable, await this.acks([id])), notice };
    }
    const s = await this.prisma.sOP.update({
      where: { id },
      data: { status, ...(status === 'published' ? { publishedAt: new Date() } : {}) },
      include: { department: { select: { id: true, name: true } } },
    });
    await this.audit.log(me, status === 'published' ? 'sop.published' : 'sop.unpublished', 'SOP', id, { status: before.status }, { status, version: s.version }, ip);
    return this.view(s, editable, await this.acks([id]));
  }
}
