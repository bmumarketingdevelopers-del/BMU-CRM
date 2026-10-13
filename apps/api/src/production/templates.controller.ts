import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { flowStepSchema, flowTemplateInputSchema, type FlowTemplateView, type Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApprovalsService } from '../actions/approvals.service.js';

const qcTemplateSchema = z.object({ name: z.string().trim().min(2), items: z.array(z.string().trim().min(2)).min(1) });

/** Admin → Templates: department flows and QC checklists. Edits create a new version; existing tasks keep theirs. */
@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  /** v11 ops: department heads' edits are drafts a Branch Manager publishes (approval handlers in ops-admin). */
  private isHead(me: Me) {
    return !me.roles.some((r) => ['founder', 'admin'].includes(r));
  }

  private canEdit(me: Me) {
    const rule = me.permissions.sop_checklists_flow_templates?.rule ?? 'none';
    if (me.type !== 'staff' || !(rule === 'full' || rule.startsWith('edit'))) throw new ForbiddenException('Only Founder, Branch Manager or department heads can edit templates');
  }

  private async latestFlows(orgId: string) {
    const rows = await this.prisma.flowTemplate.findMany({ where: { orgId, active: true }, include: { department: true }, orderBy: [{ key: 'asc' }, { version: 'desc' }] });
    return rows.filter((r, i) => rows.findIndex((x) => x.key === r.key) === i);
  }

  @Get('flows')
  async flows(@CurrentUser() me: Me): Promise<FlowTemplateView[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    return (await this.latestFlows(me.orgId)).map((f) => ({
      id: f.id,
      key: f.key,
      name: f.name,
      version: f.version,
      department: f.department.name,
      departmentId: f.departmentId,
      deliverableTypes: f.deliverableTypes,
      steps: z.array(flowStepSchema).parse(f.steps),
    }));
  }

  @Put('flows/:key')
  async saveFlow(@CurrentUser() me: Me, @Param('key') key: string, @Body() body: unknown, @ClientIp() ip?: string) {
    this.canEdit(me);
    const input = parse(flowTemplateInputSchema, body);
    const current = (await this.latestFlows(me.orgId)).find((f) => f.key === key);
    if (!current) throw new BadRequestException('Unknown flow');
    const dept = await this.prisma.department.findFirst({ where: { orgId: me.orgId, name: input.department } });
    if (!dept) throw new BadRequestException('Unknown department');
    if (me.roles.includes('department_head') && !me.roles.some((r) => ['founder', 'admin'].includes(r))) {
      const self = await this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } });
      if (self?.departmentId !== current.departmentId) throw new ForbiddenException('Department heads edit their own department flows');
    }
    if (this.isHead(me)) {
      await this.approvals.create(me, { action: 'template.flow_publish', targetType: 'flow_template', targetId: current.id, summary: `Publish flow "${input.name}" v${current.version + 1}`, payload: { key, name: input.name, departmentId: dept.id, deliverableTypes: input.deliverableTypes, steps: input.steps }, reason: 'Department draft ready to publish', approverId: null, approverRoles: ['admin'] }, ip);
      return this.flows(me);
    }
    const created = await this.prisma.flowTemplate.create({
      data: { orgId: me.orgId, departmentId: dept.id, key, name: input.name, deliverableTypes: input.deliverableTypes, steps: input.steps, version: current.version + 1 },
    });
    await this.audit.log(me, 'flow_template.updated', 'FlowTemplate', created.id, { version: current.version }, { version: created.version, steps: input.steps.length }, ip);
    return this.flows(me);
  }

  @Get('qc')
  async qc(@CurrentUser() me: Me) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const rows = await this.prisma.checklistTemplate.findMany({ where: { orgId: me.orgId, kind: 'qc' }, orderBy: [{ key: 'asc' }, { version: 'desc' }] });
    return rows.filter((r, i) => rows.findIndex((x) => x.key === r.key) === i).map((r) => ({ id: r.id, key: r.key ?? 'general', name: r.name, version: r.version, items: r.items as string[] }));
  }

  @Put('qc/:key')
  async saveQc(@CurrentUser() me: Me, @Param('key') key: string, @Body() body: unknown, @ClientIp() ip?: string) {
    this.canEdit(me);
    const input = parse(qcTemplateSchema, body);
    const current = await this.prisma.checklistTemplate.findFirst({ where: { orgId: me.orgId, kind: 'qc', key }, orderBy: { version: 'desc' } });
    if (!current) throw new BadRequestException('Unknown checklist');
    if (this.isHead(me)) {
      await this.approvals.create(me, { action: 'template.qc_publish', targetType: 'checklist_template', targetId: current.id, summary: `Publish QC checklist "${input.name}" v${current.version + 1}`, payload: { key, name: input.name, items: input.items }, reason: 'Department draft ready to publish', approverId: null, approverRoles: ['admin'] }, ip);
      return this.qc(me);
    }
    const created = await this.prisma.checklistTemplate.create({
      data: { orgId: me.orgId, kind: 'qc', key, name: input.name, items: input.items, departmentId: current.departmentId, version: current.version + 1 },
    });
    await this.audit.log(me, 'qc_checklist.updated', 'ChecklistTemplate', created.id, { version: current.version }, { version: created.version }, ip);
    return this.qc(me);
  }
}
