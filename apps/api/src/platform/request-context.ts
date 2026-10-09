// v13 foundation: who is making the current request, available anywhere below the controller (Prisma writes included)
// without passing it through every service. Set by RequestContextInterceptor after the auth guard ran.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AuthedRequest } from '../common/decorators.js';

export type RequestContext = { method: string; userId: string | null; orgId: string | null };

export const requestContext = new AsyncLocalStorage<RequestContext>();

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<AuthedRequest & { method: string }>();
    const store: RequestContext = { method: req.method, userId: req.user?.id ?? null, orgId: req.user?.orgId ?? null };
    return new Observable((sub) => requestContext.run(store, () => next.handle().subscribe(sub)));
  }
}
