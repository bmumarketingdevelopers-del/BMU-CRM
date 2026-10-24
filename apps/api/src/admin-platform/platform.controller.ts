import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put } from '@nestjs/common';
import {
  anonymiseSchema,
  type AdminPlatformAccess,
  type AdminPlatformSection,
  type ClientDataExport,
  type DataOverview,
  type IntegrationStatus,
  type Me,
  type TenantInfo,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { accessFor, assertClientData, assertOperations, assertPlatform, assertStaff, clientDataWhere } from './access.js';

const OPERATIONS_SECTIONS = ['requirementChecklists', 'sla', 'gateRules'] as const;
const PLATFORM_SECTIONS = ['notificationTemplates', 'branding', 'tenant'] as const;
const UNPAID = ['issued', 'partially_paid', 'overdue'] as const;

/** Command Centre → Platform: role-checked settings saves, integrations status, tenant info, DPDP export/deletion. */
@Controller('admin-platform')
export class PlatformController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  @Get('access')
  access(@CurrentUser() me: Me): AdminPlatformAccess {
    assertStaff(me);
    return accessFor(me);
  }

  /** Operations sections: Founder/Admin/department heads. Platform sections: Founder/Admin. Audit-logged by SettingsService. */
  @Put('settings/:section')
  save(@CurrentUser() me: Me, @Param('section') section: string, @Body() body: unknown, @ClientIp() ip?: string) {
    if ((OPERATIONS_SECTIONS as readonly string[]).includes(section)) assertOperations(me);
    else if ((PLATFORM_SECTIONS as readonly string[]).includes(section)) assertPlatform(me);
    else throw new BadRequestException('This section is not edited here');
    return this.settings.save(me, section as AdminPlatformSection, body, ip);
  }

  /** Which integrations are configured. Booleans only: secret values never leave the server. */
  @Get('integrations')
  async integrations(@CurrentUser() me: Me): Promise<IntegrationStatus[]> {
    assertPlatform(me);
    const env = (k: string) => !!process.env[k]?.trim();
    const accounting = await this.settings.get(me.orgId, 'accounting');
    return [
      { key: 'razorpay', configured: env('RAZORPAY_KEY_ID') && env('RAZORPAY_KEY_SECRET') },
      { key: 'email', configured: env('SMTP_HOST') },
      { key: 'whatsapp', configured: env('WHATSAPP_TOKEN') },
      { key: 'storage', configured: true, usingDefault: !env('STORAGE_DIR') },
      { key: 'accounting', configured: accounting.tool !== 'none', accountingTool: accounting.tool },
    ];
  }

  @Get('tenant')
  async tenant(@CurrentUser() me: Me): Promise<TenantInfo> {
    assertPlatform(me);
    const [org, clients, staff] = await Promise.all([
      this.prisma.organisation.findUniqueOrThrow({ where: { id: me.orgId }, select: { plan: true, createdAt: true } }),
      this.prisma.clientOrg.count({ where: { orgId: me.orgId, deletedAt: null } }),
      this.prisma.user.count({ where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' } } }),
    ]);
    return { plan: org.plan, createdAt: org.createdAt.toISOString(), clients, staff };
  }

  // ---------------------------------------------------------------------------
  // Data export / deletion (DPDP)

  @Get('data/clients')
  async dataClients(@CurrentUser() me: Me): Promise<DataOverview> {
    assertClientData(me);
    const [rows, tenant] = await Promise.all([
      this.prisma.clientOrg.findMany({
        // v43: a Client Manager sees only the clients they manage; the Founder sees all.
        where: { orgId: me.orgId, deletedAt: null, ...clientDataWhere(me) },
        include: {
          users: { include: { user: { select: { status: true, name: true, email: true, phone: true } } } },
          invoices: { where: { status: { in: [...UNPAID] } }, select: { id: true } },
          _count: { select: { engagements: true } },
        },
        orderBy: { name: 'asc' },
      }),
      this.settings.get(me.orgId, 'tenant'),
    ]);
    return {
      retentionDays: tenant.dataRetentionDays,
      clients: rows.map((c) => ({
        id: c.id,
        name: c.name,
        createdAt: c.createdAt.toISOString(),
        users: c.users.length,
        activeUsers: c.users.filter((u) => u.user.status === 'active').length,
        anonymisedUsers: c.users.filter((u) => u.user.name === 'Deleted user' && !u.user.email && !u.user.phone).length,
        engagements: c._count.engagements,
        unpaidInvoices: c.invoices.length,
      })),
    };
  }

  private async client(me: Me, id: string) {
    const c = await this.prisma.clientOrg.findFirst({ where: { id, orgId: me.orgId, deletedAt: null, ...clientDataWhere(me) } });
    if (!c) throw new NotFoundException('Client not found');
    return c;
  }

  @Get('data/clients/:id/export')
  async exportClient(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string): Promise<ClientDataExport> {
    assertClientData(me);
    const client = await this.client(me, id);
    const [clientUsers, engagements, threads, invoices, brands] = await Promise.all([
      this.prisma.clientUser.findMany({ where: { clientOrgId: id }, include: { user: true } }),
      this.prisma.engagement.findMany({
        where: { clientOrgId: id, orgId: me.orgId },
        include: { service: { select: { key: true, name: true } }, cycles: { include: { deliverables: true, requirements: true, plans: { select: { id: true, status: true, approvedAt: true } } } }, requests: true },
      }),
      this.prisma.thread.findMany({ where: { clientOrgId: id, orgId: me.orgId }, include: { messages: { where: { isInternal: false }, orderBy: { createdAt: 'asc' } } } }),
      this.prisma.invoice.findMany({ where: { clientOrgId: id, orgId: me.orgId }, include: { payments: true }, orderBy: { createdAt: 'asc' } }),
      this.prisma.clientBrand.findMany({ where: { clientOrgId: id } }),
    ]);
    const deliverables = engagements.flatMap((e) => e.cycles.flatMap((c) => c.deliverables.map((d) => ({ engagementId: e.id, cycle: c.period, id: d.id, type: d.type, title: d.title, status: d.status, dueAt: d.dueAt, revisionRoundsUsed: d.revisionRoundsUsed, approvedVersionId: d.approvedVersionId }))));
    const userIds = clientUsers.map((u) => u.userId);
    const targetIds = [id, ...engagements.map((e) => e.id), ...engagements.flatMap((e) => e.cycles.flatMap((c) => c.plans.map((p) => p.id))), ...deliverables.map((d) => d.id), ...engagements.flatMap((e) => e.requests.map((r) => r.id))];
    const approvals = await this.prisma.approval.findMany({ where: { orgId: me.orgId, OR: [{ userId: { in: userIds } }, { targetId: { in: targetIds } }] }, orderBy: { at: 'asc' } });
    const authors = await this.prisma.user.findMany({ where: { id: { in: [...new Set(threads.flatMap((t) => t.messages.map((m) => m.authorId)))] } }, select: { id: true, name: true, type: true } });

    const out: ClientDataExport = {
      exportedAt: new Date().toISOString(),
      exportedBy: me.name,
      client: { id: client.id, name: client.name, industry: client.industry, gstin: client.gstin, billingAddress: client.billingAddress, health: client.health, tenureStart: client.tenureStart, createdAt: client.createdAt, brands: brands.map((b) => ({ id: b.id, name: b.name, location: b.location })) },
      users: clientUsers.map((u) => ({ id: u.user.id, name: u.user.name, email: u.user.email, phone: u.user.phone, status: u.user.status, clientRole: u.clientRole, createdAt: u.user.createdAt })),
      engagements: engagements.map((e) => ({
        id: e.id,
        service: e.service.name,
        serviceKey: e.service.key,
        tier: e.tier,
        billingType: e.billingType,
        status: e.status,
        currentGate: e.currentGate,
        startDate: e.startDate,
        endDate: e.endDate,
        finalSignedOffAt: e.finalSignedOffAt,
        createdAt: e.createdAt,
        cycles: e.cycles.map((c) => ({ period: c.period, rcdAt: c.rcdAt, planningDue: c.planningDue, status: c.status, requirements: c.requirements.map((r) => ({ label: r.label, type: r.type, status: r.status })), plans: c.plans })),
      })),
      deliverables,
      requests: engagements.flatMap((e) => e.requests.map((r) => ({ id: r.id, engagementId: e.id, type: r.type, status: r.status, description: r.description, quoteAmountPaise: r.quoteAmountPaise, timeline: r.timeline, createdAt: r.createdAt, resolvedAt: r.resolvedAt, approvedAt: r.approvedAt }))),
      messages: threads.flatMap((t) => t.messages.map((m) => ({ id: m.id, threadId: t.id, engagementId: t.engagementId, author: authors.find((a) => a.id === m.authorId)?.name ?? '', fromClient: authors.find((a) => a.id === m.authorId)?.type === 'client', body: m.body, attachments: m.attachments, createdAt: m.createdAt }))),
      invoices: invoices.map((i) => ({ id: i.id, number: i.number, kind: i.kind, lines: i.lines, subtotalPaise: i.subtotalPaise, gstPaise: i.gstPaise, totalPaise: i.totalPaise, status: i.status, dueDate: i.dueDate, createdAt: i.createdAt })),
      payments: invoices.flatMap((i) => i.payments.map((p) => ({ id: p.id, invoiceId: i.id, invoiceNumber: i.number, amountPaise: p.amountPaise, method: p.method, ref: p.ref, at: p.at }))),
      approvals: approvals.map((a) => ({ id: a.id, targetType: a.targetType, targetId: a.targetId, gate: a.gate, byClientUser: userIds.includes(a.userId), userId: a.userId, at: a.at })),
    };
    await this.audit.log(me, 'client.data_exported', 'ClientOrg', id, null, { users: out.users.length, engagements: out.engagements.length, messages: out.messages.length, invoices: out.invoices.length }, ip);
    return out;
  }

  /** Right to erasure: anonymises the client's people (name, email, phone) and suspends their access. Business records stay. */
  @Post('data/clients/:id/anonymise')
  @HttpCode(200)
  async anonymise(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    assertClientData(me);
    const { confirmName } = parse(anonymiseSchema, body);
    const client = await this.client(me, id);
    if (confirmName.trim().toLowerCase() !== client.name.trim().toLowerCase()) throw new BadRequestException('The name you typed does not match the client name');
    const unpaid = await this.prisma.invoice.count({ where: { clientOrgId: id, orgId: me.orgId, status: { in: [...UNPAID] } } });
    if (unpaid) throw new BadRequestException(`This client has ${unpaid} unpaid invoice(s). Settle or void them before deleting personal data.`);
    const users = await this.prisma.clientUser.findMany({ where: { clientOrgId: id }, include: { user: { select: { id: true, name: true, email: true, phone: true, status: true } } } });
    await this.prisma.user.updateMany({ where: { id: { in: users.map((u) => u.userId) }, orgId: me.orgId }, data: { name: 'Deleted user', email: null, phone: null, status: 'suspended' } });
    await this.audit.log(
      me,
      'client.personal_data_deleted',
      'ClientOrg',
      id,
      // Keep only counts and ids in the log so the erased data is not copied into the audit trail.
      { users: users.map((u) => ({ id: u.userId, status: u.user.status })) },
      { anonymised: users.length, name: 'Deleted user', email: null, phone: null, status: 'suspended' },
      ip,
    );
    return { anonymised: users.length };
  }
}
