import { CallHandler, ExecutionContext, ForbiddenException, Injectable, type NestInterceptor, StreamableFile } from '@nestjs/common';
import { from, mergeMap, type Observable } from 'rxjs';
import type { FieldAccessSettings, Me } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { blockedWrite, buildContext, forPath, redact, seesEverything, type CustomDef, type FieldContext } from './field-access.js';
import { eventBus } from '../platform/event-bus.js';

/** Loads each organisation's field rules (Settings → Field access, custom field visibility), cached for 30 seconds. */
@Injectable()
export class FieldAccessService {
  private readonly cache = new Map<string, { overrides: FieldAccessSettings; custom: CustomDef[]; at: number }>();

  constructor(private readonly prisma: PrismaService) {
    // v21: changes made by any backend process (this or another API, the worker) take effect at once.
    eventBus.watch(['Organisation', 'CustomFieldDef'], (e) => (e.orgId ? this.cache.delete(e.orgId) : this.cache.clear()));
  }

  clear(orgId: string) {
    this.cache.delete(orgId);
  }

  async rules(orgId: string) {
    const hit = this.cache.get(orgId);
    if (hit && Date.now() - hit.at < 30_000) return hit;
    const [org, defs] = await Promise.all([
      this.prisma.organisation.findUnique({ where: { id: orgId }, select: { settings: true } }),
      this.prisma.customFieldDef.findMany({ where: { orgId, archivedAt: null, OR: [{ hiddenFrom: { isEmpty: false } }, { readOnlyFor: { isEmpty: false } }] }, select: { key: true, hiddenFrom: true, readOnlyFor: true } }),
    ]);
    const overrides = ((org?.settings as { v8?: { fieldAccess?: FieldAccessSettings } } | null)?.v8?.fieldAccess ?? {}) as FieldAccessSettings;
    const row = { overrides, custom: defs, at: Date.now() };
    this.cache.set(orgId, row);
    return row;
  }

  async context(me: Pick<Me, 'id' | 'orgId' | 'roles'>): Promise<FieldContext> {
    const r = await this.rules(me.orgId);
    return buildContext(me, r.overrides, r.custom);
  }

  /** Redacts any value for this person (used for AI tool results, exports and search). */
  async forMe<T>(me: Pick<Me, 'id' | 'orgId' | 'roles'>, value: T): Promise<T> {
    return redact(value, await this.context(me));
  }
}

/** Global: refuses changes to read-only or hidden fields, and strips hidden fields from every JSON response. */
@Injectable()
export class FieldAccessInterceptor implements NestInterceptor {
  constructor(private readonly fields: FieldAccessService) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<{ user?: Me; method: string; path?: string; url: string; body?: unknown }>();
    const me = req.user;
    if (!me) return next.handle();
    const path = (req.path ?? req.url).split('?')[0];
    const fc = forPath(await this.fields.context(me), path);
    if (req.method !== 'GET' && req.body) {
      const blocked = blockedWrite(req.body, path, fc, req.method);
      if (blocked) throw new ForbiddenException(`You can't change ${blocked}`);
    }
    if (seesEverything(fc)) return next.handle();
    return next.handle().pipe(mergeMap((data) => from(Promise.resolve(data instanceof StreamableFile || Buffer.isBuffer(data) || typeof data !== 'object' ? data : redact(data, fc)))));
  }
}
