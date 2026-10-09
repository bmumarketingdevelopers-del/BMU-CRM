import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { enquirySchema, LEAD_STAGES, leadUpdateSchema, rupeesToPaise, type LeadRow, type Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { ClientIp, CurrentUser, Public, RequireCapability } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { logLeadActivity } from '../proposals/lead-activity.js';
import { createInboundLead } from './inbound-lead.js';
import { publicLimit } from '../common/rate-limit.js';
import { CustomFieldsService } from '../customise/custom-fields.service.js';
import { PipelinesService } from '../customise/pipelines.service.js';

const include = { owner: { select: { id: true, name: true } } } as const;
type LeadWithOwner = Prisma.LeadGetPayload<{ include: typeof include }>;

const toRow = (l: LeadWithOwner): LeadRow => ({
  id: l.id,
  source: l.source,
  contact: l.contact as LeadRow['contact'],
  need: l.need,
  budgetPaise: l.budgetPaise,
  score: l.score,
  stage: l.stage,
  owner: l.owner,
  lostReason: l.lostReason,
  serviceIds: l.serviceIds,
  createdAt: l.createdAt.toISOString(),
  nextFollowUpAt: l.nextFollowUpAt?.toISOString() ?? null,
  duplicateOfId: l.duplicateOfId,
  lastActivityAt: l.lastActivityAt?.toISOString() ?? null,
  customFields: (l.customFields ?? {}) as LeadRow['customFields'],
});


@Controller('leads')
export class LeadsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly customFields: CustomFieldsService,
    private readonly pipelines: PipelinesService,
  ) {}

  /** Website enquiry form and package builder create a Lead. */
  @Public()
  @Post('enquiry')
  async enquiry(@Body() body: unknown, @ClientIp() ip?: string): Promise<{ id: string }> {
    const input = parse(enquirySchema, body);
    // v20 bot protection: the hidden "website" box is only ever filled by bots; too many from one address are refused.
    if (input.website) return { id: 'received' };
    publicLimit(`enquiry:${ip}`, 10, 10 * 60_000, ip);
    const org = await this.prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const lead = await createInboundLead(
      { prisma: this.prisma, audit: this.audit, notifications: this.notifications },
      { orgId: org.id, source: 'website', name: input.name, email: input.email, phone: input.phone, company: input.company, need: input.need, budgetPaise: input.budgetRupees === undefined ? null : rupeesToPaise(input.budgetRupees), serviceIds: input.serviceIds, consent: { marketing: input.consentMarketing, whatsapp: input.consentWhatsapp, source: 'website_enquiry', ip: ip ?? null } },
    );
    return { id: lead.id };
  }

  private scopeWhere(me: Me): Prisma.LeadWhereInput {
    const scope = me.permissions.leads_pipeline?.scope ?? 'none';
    return { orgId: me.orgId, deletedAt: null, ...(scope === 'own' ? { ownerId: me.id } : {}) };
  }

  @Get()
  @RequireCapability('leads_pipeline')
  async list(@CurrentUser() me: Me, @Query() query: Record<string, string> = {}): Promise<LeadRow[]> {
    // v14: custom field filters as ?cf.<key>=<value>
    const cf = await this.customFields.listFilters(me.orgId, 'lead', query);
    // v11 ops: archived leads are hidden from the board (restorable from the archive).
    const rows = await this.prisma.lead.findMany({ where: { ...this.scopeWhere(me), archivedAt: null, ...(cf.length ? { AND: cf.map((f) => ({ customFields: f })) } : {}) }, include, orderBy: { createdAt: 'desc' } });
    // v14: when each lead entered its current stage (for "days in stage" on the board).
    const moves = rows.length
      ? await this.prisma.auditEvent.findMany({ where: { orgId: me.orgId, entity: 'Lead', entityId: { in: rows.map((r) => r.id) }, action: { in: LEAD_STAGES.map((s) => `lead.${s}`) } }, select: { entityId: true, action: true, at: true }, orderBy: { at: 'desc' } })
      : [];
    return rows.map((l) => ({ ...toRow(l), stageSince: (moves.find((m) => m.entityId === l.id && m.action === `lead.${l.stage}`)?.at ?? l.createdAt).toISOString() }));
  }

  /** People a manager can assign leads to (sales roles and the Founder). Managers only. */
  @Get('assignees')
  @RequireCapability('leads_pipeline')
  async assignees(@CurrentUser() me: Me): Promise<{ id: string; name: string; roles: { baseRole: string }[] }[]> {
    if ((me.permissions.leads_pipeline?.scope ?? 'none') !== 'all') throw new ForbiddenException('Only managers assign leads');
    const users = await this.prisma.user.findMany({
      where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { OR: [{ baseRole: { startsWith: 'sales' } }, { baseRole: 'founder' }] } } } },
      select: { id: true, name: true, roles: { select: { role: { select: { baseRole: true } } } } },
      orderBy: { name: 'asc' },
    });
    return users.map((u) => ({ id: u.id, name: u.name, roles: u.roles.map((r) => ({ baseRole: r.role.baseRole })) }));
  }

  @Patch(':id')
  @RequireCapability('leads_pipeline')
  async update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string): Promise<LeadRow> {
    const input = parse(leadUpdateSchema, body);
    const existing = await this.prisma.lead.findFirst({ where: { ...this.scopeWhere(me), id }, include });
    if (!existing) throw new NotFoundException('Lead not found');
    if (existing.stage === 'won' && input.stage && input.stage !== 'won') {
      throw new BadRequestException('A won lead has become a client and cannot move back');
    }
    // v14: stages can require fields (Pipelines settings).
    if (input.stage && input.stage !== existing.stage) await this.pipelines.assertLeadCanEnter(me.orgId, id, input.stage);
    if (input.ownerId !== undefined) {
      if (me.permissions.leads_pipeline?.scope !== 'all') throw new ForbiddenException('Only sales managers assign leads');
      if (input.ownerId) {
        const owner = await this.prisma.user.findFirst({ where: { id: input.ownerId, orgId: me.orgId, type: 'staff' } });
        if (!owner) throw new BadRequestException('Unknown team member');
      }
    }
    const lead = await this.prisma.lead.update({
      where: { id },
      data: {
        stage: input.stage,
        ownerId: input.ownerId,
        lostReason: input.stage === 'lost' ? input.lostReason : input.stage ? null : undefined,
      },
      include,
    });
    await this.audit.log(me, input.stage ? `lead.${input.stage}` : 'lead.updated', 'Lead', id, toRow(existing), toRow(lead), ip);
    const name = (lead.contact as { company?: string; name?: string }).company || (lead.contact as { name?: string }).name || 'a lead';
    if (input.stage && input.stage !== existing.stage) {
      await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: id, kind: 'system', userId: me.id, body: `${me.name} moved the lead to ${input.stage.replace('_', ' ')}${input.stage === 'lost' && input.lostReason ? `: ${input.lostReason}` : ''}` });
    }
    if (input.ownerId !== undefined && input.ownerId !== existing.ownerId) {
      await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: id, kind: 'system', userId: me.id, body: lead.owner ? `${me.name} assigned the lead to ${lead.owner.name}` : `${me.name} unassigned the lead` });
      if (input.ownerId && input.ownerId !== me.id) {
        await this.notifications.notify(me.orgId, [input.ownerId], { kind: 'lead_assigned', title: `New lead for you: ${name}`, body: lead.need.slice(0, 140), link: `/team/leads/${id}` });
      }
    }
    return toRow(lead);
  }
}
