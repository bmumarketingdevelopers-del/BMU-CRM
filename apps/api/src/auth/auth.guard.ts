import { CanActivate, ExecutionContext, ForbiddenException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Capability } from '@bmu/shared';
import { API_SCOPE, IS_PUBLIC, REQUIRED_CAPABILITY, type ApiKeyRequest, type AuthedRequest } from '../common/decorators.js';
import { resolveApiKey, takeRate } from '../integrations/api-keys.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeService } from './me.service.js';
import { SessionsService } from './sessions.service.js';
import { SESSION_COOKIE, type SessionClaims } from './session.js';

/**
 * Global guard: every route needs a signed-in user unless marked @Public(),
 * and routes marked @RequireCapability() need a non-"none" scope for it.
 * Permissions are enforced here in the backend, not only in the UI.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly me: MeService,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Please sign in');

    // v19 public API: API keys work only on /v1 routes, and /v1 routes work only with API keys.
    const apiScope = this.reflector.getAllAndOverride<string | undefined>(API_SCOPE, targets);
    if (token.startsWith('bmu_')) {
      if (!apiScope) throw new ForbiddenException('API keys only work on the public API (/v1)');
      const found = await resolveApiKey(this.prisma, this.me, token);
      if (!found) throw new UnauthorizedException('This API key is not valid (revoked, expired or mistyped)');
      const rate = takeRate(found.key.id, found.key.rateLimitPerMin);
      const res = ctx.switchToHttp().getResponse<{ setHeader(k: string, v: string): void }>();
      res.setHeader('X-RateLimit-Limit', String(found.key.rateLimitPerMin));
      res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.resetSec));
        throw new HttpException({ statusCode: 429, message: `Too many requests: this key allows ${found.key.rateLimitPerMin} a minute. Try again in ${rate.resetSec} seconds.` }, 429);
      }
      if (apiScope !== 'any' && !found.key.scopes.includes(apiScope as never)) throw new ForbiddenException(`This API key does not have the ${apiScope} scope`);
      req.user = found.user;
      (req as ApiKeyRequest).apiKey = found.key;
      return true;
    }
    if (apiScope) throw new UnauthorizedException('Use an API key: Authorization: Bearer bmu_…');

    let claims: SessionClaims;
    try {
      claims = await this.jwt.verifyAsync<SessionClaims>(token);
    } catch {
      throw new UnauthorizedException('Your session has expired. Please sign in again');
    }
    // v20: a session signed out from Security (or by an admin) stops working straight away.
    if (!(await this.sessions.isActive(claims.sid))) throw new UnauthorizedException('You were signed out on this device. Please sign in again');
    const loaded = await this.me.load(claims.sub);
    if (!loaded) throw new UnauthorizedException('Account not active');
    const user = { ...loaded, sessionId: claims.sid };
    req.user = user;
    // v20: roles that must use two-factor can only reach sign-in and security set-up until they have.
    if (await this.sessions.mustDoTwoFactor(user, claims.sid)) {
      user.mustEnroll2fa = true;
      const path = ((req as { path?: string; url?: string }).path ?? (req as { url?: string }).url ?? '').split('?')[0];
      if (!/^\/(auth|security\/(me|totp|passkeys|sessions))(\/|$)/.test(path)) {
        throw new ForbiddenException({ statusCode: 403, code: 'two_factor_required', message: 'Your role must use two-factor sign-in. Set it up in Profile → Security to continue.' });
      }
    }

    const capability = this.reflector.getAllAndOverride<Capability | undefined>(REQUIRED_CAPABILITY, targets);
    if (capability && (user.permissions[capability]?.scope ?? 'none') === 'none') {
      throw new ForbiddenException("You don't have access to this");
    }
    return true;
  }
}
