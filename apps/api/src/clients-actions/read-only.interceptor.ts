// v11 clients: after offboarding, client users keep read-only access for 90 days. Any change they try is refused.
import { ForbiddenException, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';

const ALLOWED = [/^\/auth\//, /^\/notifications/, /^\/client-actions\/offboarding\/confirm/];

@Injectable()
export class ClientReadOnlyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest<{ method: string; path?: string; url: string; user?: Me }>();
    const me = req.user;
    if (me?.type === 'client' && me.clientOrg && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const path = req.path ?? req.url;
      if (!ALLOWED.some((r) => r.test(path))) {
        const c = await this.prisma.clientOrg.findUnique({ where: { id: me.clientOrg.id }, select: { readOnlyUntil: true } });
        if (c?.readOnlyUntil) throw new ForbiddenException(`Your account was closed. You can view and download everything until ${c.readOnlyUntil.toISOString().slice(0, 10)}, but nothing can be changed.`);
      }
    }
    return next.handle();
  }
}
