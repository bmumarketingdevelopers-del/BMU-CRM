import { Controller, Get } from '@nestjs/common';
import type { AuditRow, Me } from '@bmu/shared';
import { CurrentUser, RequireCapability } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('audit')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequireCapability('audit_log')
  async list(@CurrentUser() me: Me): Promise<AuditRow[]> {
    const rows = await this.prisma.auditEvent.findMany({
      where: { orgId: me.orgId },
      orderBy: { at: 'desc' },
      take: 200,
    });
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
    const actors = await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } });
    const byId = new Map(actors.map((a) => [a.id, a]));
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      at: r.at.toISOString(),
      actor: r.actorId ? (byId.get(r.actorId) ?? null) : null,
      before: r.before,
      after: r.after,
    }));
  }
}
