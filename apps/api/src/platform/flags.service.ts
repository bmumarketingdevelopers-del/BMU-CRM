// v13 foundation: feature flags per organisation, optionally limited to roles. A missing row means the default.
import { ForbiddenException, Injectable } from '@nestjs/common';
import { FEATURE_FLAGS, featureFlagOn, type FeatureFlagKey, type FeatureFlagRow, type FeatureFlagUpdate, type Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { eventBus } from './event-bus.js';

const CACHE_MS = 10_000;

@Injectable()
export class FlagsService {
  private cache = new Map<string, { at: number; rows: FeatureFlagRow[] }>();
  /** Called after a change so open screens pick it up (RealtimeService). */
  onChange: ((orgId: string) => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    // v21: changes made by any backend process (this or another API, the worker) take effect at once.
    eventBus.watch(['FeatureFlag'], (e) => (e.orgId ? this.cache.delete(e.orgId) : this.cache.clear()));
  }

  async rows(orgId: string): Promise<FeatureFlagRow[]> {
    const hit = this.cache.get(orgId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
    const saved = await this.prisma.featureFlag.findMany({ where: { orgId } });
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: saved.map((s) => s.updatedById).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const rows = FEATURE_FLAGS.map((f) => {
      const s = saved.find((x) => x.key === f.key);
      return { key: f.key, label: f.label, hint: f.hint, enabled: s ? s.enabled : f.default, roles: s?.roles ?? [], isDefault: !s, updatedAt: s?.updatedAt.toISOString() ?? null, updatedBy: s?.updatedById ? (names.get(s.updatedById) ?? null) : null };
    });
    this.cache.set(orgId, { at: Date.now(), rows });
    return rows;
  }

  async forMe(me: Pick<Me, 'orgId' | 'roles'>): Promise<Record<FeatureFlagKey, boolean>> {
    const rows = await this.rows(me.orgId);
    return Object.fromEntries(rows.map((r) => [r.key, featureFlagOn(r, me.roles)])) as Record<FeatureFlagKey, boolean>;
  }

  async on(me: Pick<Me, 'orgId' | 'roles'>, key: FeatureFlagKey) {
    return (await this.forMe(me))[key];
  }

  async set(me: Me, key: FeatureFlagKey, input: FeatureFlagUpdate, ip?: string) {
    if (!me.roles.some((r) => r === 'founder' || r === 'admin')) throw new ForbiddenException('Only Founders and Branch Managers change feature flags');
    const before = (await this.rows(me.orgId)).find((r) => r.key === key);
    await this.prisma.featureFlag.upsert({
      where: { orgId_key: { orgId: me.orgId, key } },
      create: { orgId: me.orgId, key, enabled: input.enabled, roles: input.roles, updatedById: me.id },
      update: { enabled: input.enabled, roles: input.roles, updatedById: me.id },
    });
    this.cache.delete(me.orgId);
    await this.audit.log(me, 'feature_flag.changed', 'FeatureFlag', key, before ? { enabled: before.enabled, roles: before.roles } : null, input, ip);
    this.onChange?.(me.orgId);
    return (await this.rows(me.orgId)).find((r) => r.key === key)!;
  }
}
