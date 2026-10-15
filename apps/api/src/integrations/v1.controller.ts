// v19 public REST API v1. Each route needs an API key with the route's scope (see auth.guard.ts). Requests act as the
// key's person, so visibility follows the app (a Client Manager's key sees their clients) and writes go through the
// same services as the app (validation, duplicate checks, leave rules, audit, undo, webhooks).
import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { services as catalogue, type Me, type PublicDepartment, type PublicMe, type PublicPage, type PublicPerson, type PublicService } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { TasksActionsService } from '../actions/tasks/tasks.service.js';
import { ApiRoute, ClientIp, CurrentUser, Public, type ApiKeyRequest } from '../common/decorators.js';
import { clientScope } from '../creative/scope.js';
import { assertFinanceRead } from '../insights/access.js';
import { OpsLeadsService } from '../ops-actions/ops-leads.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { openApiDocument } from './openapi.js';
import { clientSelect, clientShapes, invoiceShapes, leadSelect, leadShapes, postSelect, postShape, projectSelect, projectShape, taskSelect, taskShapes } from './shapes.js';

type PageQ = { limit?: string; cursor?: string; updatedSince?: string };
const pageArgs = (q: PageQ) => {
  const limit = q.limit === undefined ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be 1 to 100');
  let since: Date | undefined;
  if (q.updatedSince) {
    since = new Date(q.updatedSince);
    if (Number.isNaN(since.getTime())) throw new BadRequestException('updatedSince must be an ISO date-time');
  }
  return { take: limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}), orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }], since, limit };
};
function paged<T extends { id: string }, R>(rows: T[], limit: number, shaped: R[]): PublicPage<R> {
  return { data: shaped.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
}

@Controller('v1')
export class PublicApiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: OpsLeadsService,
    private readonly tasks: TasksActionsService,
  ) {}

  @Public()
  @Get('openapi.json')
  @Header('Cache-Control', 'public, max-age=300')
  openapi() {
    return openApiDocument();
  }

  @Get('me')
  @ApiRoute('any')
  me(@CurrentUser() me: Me, @Req() req: ApiKeyRequest): PublicMe {
    const k = req.apiKey!;
    return { key: { name: k.name, prefix: k.prefix, scopes: k.scopes, rateLimitPerMin: k.rateLimitPerMin }, actsAs: { id: me.id, name: me.name } };
  }

  // ---------------------------------------------------------------------------------------------- leads

  private leadWhere(me: Me): Prisma.LeadWhereInput {
    const scope = me.permissions.leads_pipeline?.scope ?? 'none';
    if (scope === 'none') throw new ForbiddenException("The key's person cannot see leads");
    return { orgId: me.orgId, deletedAt: null, ...(scope === 'own' ? { ownerId: me.id } : {}) };
  }

  @Get('leads')
  @ApiRoute('leads:read')
  async listLeads(@CurrentUser() me: Me, @Query() q: PageQ & { stage?: string }) {
    const p = pageArgs(q);
    const rows = await this.prisma.lead.findMany({ where: { ...this.leadWhere(me), ...(q.stage ? { stage: q.stage as never } : {}), ...(p.since ? { updatedAt: { gte: p.since } } : {}) }, select: leadSelect, take: p.take, ...(p.cursor ? { cursor: p.cursor, skip: 1 } : {}), orderBy: p.orderBy });
    return paged(rows, p.limit, await leadShapes(this.prisma, rows));
  }

  @Get('leads/:id')
  @ApiRoute('leads:read')
  async getLead(@CurrentUser() me: Me, @Param('id') id: string) {
    const l = await this.prisma.lead.findFirst({ where: { ...this.leadWhere(me), id }, select: leadSelect });
    if (!l) throw new NotFoundException('Lead not found');
    return (await leadShapes(this.prisma, [l]))[0];
  }

  @Post('leads')
  @HttpCode(201)
  @ApiRoute('leads:write')
  async createLead(@CurrentUser() me: Me, @Body() body: Record<string, unknown>, @ClientIp() ip?: string) {
    const created = await this.leads.create(me, { source: 'other', ...body }, ip);
    const l = await this.prisma.lead.findUniqueOrThrow({ where: { id: created.lead.id }, select: leadSelect });
    return (await leadShapes(this.prisma, [l]))[0];
  }

  @Get('services')
  @ApiRoute('leads:write')
  servicesList(): PublicService[] {
    return catalogue.map((s) => ({ id: s.id, name: s.name }));
  }

  // ---------------------------------------------------------------------------------------------- clients and projects

  private async clientIds(me: Me) {
    const scope = await clientScope(this.prisma, me);
    return scope === 'all' ? undefined : scope;
  }

  @Get('clients')
  @ApiRoute('clients:read')
  async listClients(@CurrentUser() me: Me, @Query() q: PageQ) {
    const p = pageArgs(q);
    const ids = await this.clientIds(me);
    const rows = await this.prisma.clientOrg.findMany({ where: { orgId: me.orgId, deletedAt: null, ...(ids ? { id: { in: ids } } : {}), ...(p.since ? { createdAt: { gte: p.since } } : {}) }, select: clientSelect, take: p.take, ...(p.cursor ? { cursor: p.cursor, skip: 1 } : {}), orderBy: p.orderBy });
    return paged(rows, p.limit, await clientShapes(this.prisma, rows));
  }

  @Get('clients/:id')
  @ApiRoute('clients:read')
  async getClient(@CurrentUser() me: Me, @Param('id') id: string) {
    const ids = await this.clientIds(me);
    if (ids && !ids.includes(id)) throw new NotFoundException('Client not found');
    const c = await this.prisma.clientOrg.findFirst({ where: { id, orgId: me.orgId, deletedAt: null }, select: clientSelect });
    if (!c) throw new NotFoundException('Client not found');
    return (await clientShapes(this.prisma, [c]))[0];
  }

  @Get('projects')
  @ApiRoute('projects:read')
  async listProjects(@CurrentUser() me: Me, @Query() q: PageQ & { clientId?: string }) {
    const p = pageArgs(q);
    const ids = await this.clientIds(me);
    if (q.clientId && ids && !ids.includes(q.clientId)) return { data: [], nextCursor: null };
    const clientFilter = q.clientId ? { clientOrgId: q.clientId } : ids ? { clientOrgId: { in: ids } } : {};
    const rows = await this.prisma.engagement.findMany({ where: { orgId: me.orgId, deletedAt: null, ...clientFilter, ...(p.since ? { createdAt: { gte: p.since } } : {}) }, select: projectSelect, take: p.take, ...(p.cursor ? { cursor: p.cursor, skip: 1 } : {}), orderBy: p.orderBy });
    return paged(rows, p.limit, rows.map(projectShape));
  }

  // ---------------------------------------------------------------------------------------------- tasks

  @Get('tasks')
  @ApiRoute('tasks:read')
  async listTasks(@CurrentUser() me: Me, @Query() q: PageQ & { projectId?: string; status?: string }) {
    const p = pageArgs(q);
    const ids = await this.clientIds(me);
    const engIds = ids ? (await this.prisma.engagement.findMany({ where: { orgId: me.orgId, clientOrgId: { in: ids } }, select: { id: true } })).map((e) => e.id) : [];
    const visible: Prisma.TaskWhereInput = ids ? { OR: [{ ownerId: me.id }, { engagementId: { in: engIds } }] } : {};
    const rows = await this.prisma.task.findMany({
      where: { orgId: me.orgId, archivedAt: null, isDraft: false, ...visible, ...(q.projectId ? { engagementId: q.projectId } : {}), ...(q.status ? { status: q.status as never } : {}), ...(p.since ? { updatedAt: { gte: p.since } } : {}) },
      select: taskSelect,
      take: p.take,
      ...(p.cursor ? { cursor: p.cursor, skip: 1 } : {}),
      orderBy: p.orderBy,
    });
    return paged(rows, p.limit, await taskShapes(this.prisma, rows));
  }

  @Post('tasks')
  @HttpCode(201)
  @ApiRoute('tasks:write')
  async createTask(@CurrentUser() me: Me, @Body() body: Record<string, unknown>, @ClientIp() ip?: string) {
    const { projectId, ...rest } = body ?? {};
    const r = await this.tasks.create(me, { ...rest, engagementId: projectId ?? null }, ip);
    const t = await this.prisma.task.findUniqueOrThrow({ where: { id: r.task.id }, select: taskSelect });
    return (await taskShapes(this.prisma, [t]))[0];
  }

  @Get('people')
  @ApiRoute('tasks:read')
  async people(@CurrentUser() me: Me): Promise<PublicPerson[]> {
    const rows = await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null }, select: { id: true, name: true, email: true, departmentId: true, roles: { select: { role: { select: { baseRole: true } } } } }, orderBy: { name: 'asc' } });
    return rows.map((u) => ({ id: u.id, name: u.name, email: u.email, departmentId: u.departmentId, roles: u.roles.map((r) => r.role.baseRole) }));
  }

  @Get('departments')
  @ApiRoute('tasks:read')
  async departments(@CurrentUser() me: Me): Promise<PublicDepartment[]> {
    return this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }

  // ---------------------------------------------------------------------------------------------- invoices and posts

  @Get('invoices')
  @ApiRoute('invoices:read')
  async listInvoices(@CurrentUser() me: Me, @Query() q: PageQ & { clientId?: string; status?: string }) {
    assertFinanceRead(me);
    const p = pageArgs(q);
    const rows = await this.prisma.invoice.findMany({
      where: { orgId: me.orgId, status: { notIn: ['draft'] }, ...(q.clientId ? { clientOrgId: q.clientId } : {}), ...(q.status ? { status: q.status as never } : {}), ...(p.since ? { createdAt: { gte: p.since } } : {}) },
      select: { id: true },
      take: p.take,
      ...(p.cursor ? { cursor: p.cursor, skip: 1 } : {}),
      orderBy: p.orderBy,
    });
    return paged(rows, p.limit, await invoiceShapes(this.prisma, me.orgId, rows.slice(0, p.limit).map((r) => r.id)));
  }

  @Get('invoices/:id')
  @ApiRoute('invoices:read')
  async getInvoice(@CurrentUser() me: Me, @Param('id') id: string) {
    assertFinanceRead(me);
    const [inv] = await invoiceShapes(this.prisma, me.orgId, [id]);
    if (!inv || inv.status === 'draft') throw new NotFoundException('Invoice not found');
    return inv;
  }

  @Get('posts')
  @ApiRoute('content:read')
  async listPosts(@CurrentUser() me: Me, @Query() q: PageQ & { clientId?: string }) {
    const p = pageArgs(q);
    const ids = await this.clientIds(me);
    if (q.clientId && ids && !ids.includes(q.clientId)) return { data: [], nextCursor: null };
    const clientFilter = q.clientId ? { clientOrgId: q.clientId } : ids ? { clientOrgId: { in: ids } } : {};
    const rows = await this.prisma.deliverable.findMany({
      where: { orgId: me.orgId, archivedAt: null, scheduledAt: { not: null }, cycle: { engagement: clientFilter }, ...(p.since ? { scheduledAt: { gte: p.since } } : {}) },
      select: postSelect,
      take: p.take,
      ...(p.cursor ? { cursor: p.cursor, skip: 1 } : {}),
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
    });
    return paged(rows, p.limit, rows.map(postShape));
  }
}
