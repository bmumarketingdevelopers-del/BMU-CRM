import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { errorLogInputSchema, type ErrorLogList, type ErrorLogView, type Me } from '@bmu/shared';
import type { ErrorLog } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertStaff } from './access.js';

const canEdit = (me: Me) => me.type === 'staff' && me.roles.some((r) => ['founder', 'admin', 'department_head'].includes(r));

const view = (e: ErrorLog): ErrorLogView => ({
  id: e.id,
  what: e.what,
  why: e.why,
  foundBy: e.foundBy,
  impact: e.impact,
  fix: e.fix,
  prevention: e.prevention,
  cause: e.cause,
  createdAt: e.createdAt.toISOString(),
});

/** Error log: anyone on the team can log a mistake; Founder, Admin and department heads edit. */
@Controller('admin-platform/errors')
export class ErrorsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser() me: Me, @Query('q') q?: string, @Query('cause') cause?: string): Promise<ErrorLogList> {
    assertStaff(me);
    const term = q?.trim();
    const [rows, all] = await Promise.all([
      this.prisma.errorLog.findMany({
        where: {
          orgId: me.orgId,
          ...(cause ? { cause: cause === 'none' ? null : cause } : {}),
          ...(term
            ? { OR: (['what', 'why', 'impact', 'fix', 'prevention', 'foundBy'] as const).map((f) => ({ [f]: { contains: term, mode: 'insensitive' as const } })) }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      this.prisma.errorLog.findMany({ where: { orgId: me.orgId }, select: { cause: true, prevention: true } }),
    ]);
    const counts = new Map<string, number>();
    for (const e of all) counts.set(e.cause ?? 'none', (counts.get(e.cause ?? 'none') ?? 0) + 1);
    return {
      rows: rows.map(view),
      stats: [...counts.entries()].map(([c, count]) => ({ cause: c, count })).sort((a, b) => b.count - a.count),
      total: all.length,
      open: all.filter((e) => !e.prevention?.trim()).length,
      canEdit: canEdit(me),
    };
  }

  @Post()
  async create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string): Promise<ErrorLogView> {
    assertStaff(me);
    const input = parse(errorLogInputSchema, body);
    const e = await this.prisma.errorLog.create({ data: { orgId: me.orgId, ...input, foundBy: input.foundBy?.trim() || me.name } });
    await this.audit.log(me, 'error_log.created', 'ErrorLog', e.id, null, view(e), ip);
    return view(e);
  }

  @Put(':id')
  async update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string): Promise<ErrorLogView> {
    if (!canEdit(me)) throw new ForbiddenException('Only Founder, Branch Manager or department heads can edit error log entries');
    const input = parse(errorLogInputSchema, body);
    const before = await this.prisma.errorLog.findFirst({ where: { id, orgId: me.orgId } });
    if (!before) throw new NotFoundException('Entry not found');
    const e = await this.prisma.errorLog.update({ where: { id }, data: input });
    await this.audit.log(me, 'error_log.updated', 'ErrorLog', id, view(before), view(e), ip);
    return view(e);
  }
}
