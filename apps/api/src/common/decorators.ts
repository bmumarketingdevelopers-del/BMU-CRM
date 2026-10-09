import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { ApiScope, Capability, Me } from '@bmu/shared';

export const IS_PUBLIC = 'isPublic';
/** Route needs no sign-in. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_CAPABILITY = 'requiredCapability';
/** Route needs a non-"none" scope on this capability from the permission matrix. */
export const RequireCapability = (capability: Capability) => SetMetadata(REQUIRED_CAPABILITY, capability);

export type AuthedRequest = { user?: Me; ip?: string; cookies?: Record<string, string>; headers: Record<string, string | undefined> };

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Me => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.user!;
});

export const ClientIp = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | undefined => ctx.switchToHttp().getRequest<AuthedRequest>().ip,
);

export const API_SCOPE = 'apiScope';
/** v19 public API route: needs an API key with this scope ("any" = any valid key). Session sign-ins are refused. */
export const ApiRoute = (scope: ApiScope | 'any') => SetMetadata(API_SCOPE, scope);

export type ApiKeyRequest = AuthedRequest & { apiKey?: { id: string; name: string; prefix: string; scopes: ApiScope[]; rateLimitPerMin: number } };
