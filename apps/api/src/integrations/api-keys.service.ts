// v19: managing public API keys (Founder and Admin). The full key is shown once; only its hash is kept.
import { ForbiddenException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { apiKeyCreateSchema, type ApiKeyCreated, type ApiKeyView, type ApiScope, type Me } from '@bmu/shared';
import type { ApiKey } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { hasRole } from '../creative/scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashKey, newApiKey } from './api-keys.js';

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private assertAdmin(me: Me) {
    if (me.type !== 'staff' || !hasRole(me, 'founder', 'admin')) throw new ForbiddenException('Only Founders and Admins can manage API keys and webhooks');
  }

  private async views(rows: ApiKey[]): Promise<ApiKeyView[]> {
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true } })).map((u) => [u.id, u]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes as ApiScope[],
      actsAs: users.get(r.userId) ?? { id: r.userId, name: 'Former team member' },
      rateLimitPerMin: r.rateLimitPerMin,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async list(me: Me) {
    this.assertAdmin(me);
    return this.views(await this.prisma.apiKey.findMany({ where: { orgId: me.orgId }, orderBy: { createdAt: 'desc' } }));
  }

  async create(me: Me, body: unknown, ip?: string): Promise<ApiKeyCreated> {
    this.assertAdmin(me);
    const input = parse(apiKeyCreateSchema, body);
    const active = await this.prisma.apiKey.count({ where: { orgId: me.orgId, revokedAt: null } });
    if (active >= 25) throw new BadRequestException('At most 25 active keys. Revoke one you no longer use.');
    const key = newApiKey();
    const row = await this.prisma.apiKey.create({
      data: { orgId: me.orgId, name: input.name, prefix: `${key.slice(0, 12)}…`, hash: hashKey(key), scopes: [...new Set(input.scopes)], userId: me.id, createdById: me.id, rateLimitPerMin: input.rateLimitPerMin, expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null },
    });
    await this.audit.log(me, 'api_key.created', 'ApiKey', row.id, undefined, { name: row.name, scopes: row.scopes }, ip);
    return { key, row: (await this.views([row]))[0] };
  }

  async revoke(me: Me, id: string, ip?: string): Promise<ApiKeyView> {
    this.assertAdmin(me);
    const row = await this.prisma.apiKey.findFirst({ where: { id, orgId: me.orgId } });
    if (!row) throw new NotFoundException('Key not found');
    const updated = row.revokedAt ? row : await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.log(me, 'api_key.revoked', 'ApiKey', id, undefined, { name: row.name }, ip);
    return (await this.views([updated]))[0];
  }
}
