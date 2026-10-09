import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { craftSpecialtyLabel, otpRequestSchema, otpVerifySchema, secondFactorSchema, type Me } from '@bmu/shared';
import { z } from 'zod';
import { CurrentUser, Public } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';
import { MeService } from './me.service.js';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, type SessionClaims } from './session.js';
import { SessionsService, type ReqInfo } from './sessions.service.js';

const info = (req: Request): ReqInfo => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
const passkeySchema = z.object({ token: z.string().min(10), response: z.object({ id: z.string() }).passthrough(), challenge: z.string().optional() });

const DEMO_ORDER = [
  'founder@bmu.demo', 'admin@bmu.demo', 'sales.manager@bmu.demo', 'sales@bmu.demo', 'am.lead@bmu.demo', 'am@bmu.demo', 'pm@bmu.demo',
  'design.head@bmu.demo', 'strategist@bmu.demo', 'producer@bmu.demo', 'qc@bmu.demo', 'video@bmu.demo', 'script@bmu.demo', 'social@bmu.demo',
  'dev@bmu.demo', 'uxui@bmu.demo', 'design@bmu.demo', 'finance@bmu.demo', 'hr@bmu.demo', 'creator@bmu.demo', 'client@sunrise.demo', 'approver@sunrise.demo',
];

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly meService: MeService,
    private readonly jwt: JwtService,
  ) {}

  private setCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      // Secure (HTTPS-only) on a live server, unless the site itself is plain http (e.g. trying it on a LAN address).
      secure: process.env.NODE_ENV === 'production' && !(process.env.APP_URL ?? '').startsWith('http://'),
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: '/',
    });
  }

  @Public()
  @Post('otp/request')
  @HttpCode(200)
  request(@Body() body: unknown, @Req() req: Request) {
    return this.auth.requestOtp(parse(otpRequestSchema, body).identifier, req.ip);
  }

  /** Returns a token (mobile) and also sets an httpOnly session cookie (web). */
  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  async verify(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { identifier, code } = parse(otpVerifySchema, body);
    const result = await this.auth.verifyOtp(identifier, code, info(req));
    if ('token' in result) this.setCookie(res, result.token);
    return result;
  }

  /** v20: second step for people with two-factor on: a 6-digit app code or a recovery code. */
  @Public()
  @Post('2fa')
  @HttpCode(200)
  async secondFactor(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { challenge, code } = parse(secondFactorSchema, body);
    const r = await this.sessions.secondFactor(challenge, code, info(req));
    this.setCookie(res, r.token);
    return { token: r.token, me: await this.meService.load(r.userId) };
  }

  /** v20: passkey sign-in (no code), or the second step when `challenge` is the pending sign-in. */
  @Public()
  @Post('passkey/options')
  @HttpCode(200)
  passkeyOptions() {
    return this.sessions.passkeyLoginOptions();
  }

  @Public()
  @Post('passkey/verify')
  @HttpCode(200)
  async passkeyVerify(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = parse(passkeySchema, body);
    const r = await this.sessions.passkeyLogin(b.token, b.response as never, info(req), b.challenge);
    this.setCookie(res, r.token);
    return { token: r.token, me: await this.meService.load(r.userId) };
  }

  @Get('me')
  me(@CurrentUser() user: Me): Me {
    return user;
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // v20: signing out also ends this device's session on the server.
    const header = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (token && !token.startsWith('bmu_')) {
      const claims = await this.jwt.verifyAsync<SessionClaims>(token).catch(() => null);
      if (claims?.sid) await this.prisma.userSession.updateMany({ where: { id: claims.sid, revokedAt: null }, data: { revokedAt: new Date() } });
      if (claims?.sid) this.sessions.forget(claims.sid);
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  /** Development only: the seeded accounts, so you can sign in as each role. */
  @Public()
  @Get('demo-accounts')
  async demoAccounts() {
    if (process.env.NODE_ENV === 'production') return [];
    const users = await this.prisma.user.findMany({
      where: { email: { endsWith: '.demo' }, deletedAt: null, status: { not: 'suspended' } },
      include: { roles: { include: { role: true } } },
      orderBy: { createdAt: 'asc' },
    });
    // The main role accounts first (the ones the guide talks about), then everyone else by name.
    const rank = (email: string) => {
      const i = DEMO_ORDER.indexOf(email);
      return i === -1 ? DEMO_ORDER.length : i;
    };
    return users
      .map((u) => ({
        name: u.name,
        email: u.email!,
        // Short label: the craft specialty when there is one, else the role name without its long "(…)" list.
        role: craftSpecialtyLabel(u.specialty) || (u.roles[0]?.role.name ?? u.type).replace(/\s*\(.*\)\s*$/, ''),
      }))
      .sort((a, b) => rank(a.email) - rank(b.email) || a.name.localeCompare(b.name));
  }
}
