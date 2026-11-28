import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import { normaliseIdentifier, type Me } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeService } from './me.service.js';
import { OtpSender } from './otp-sender.js';
import { SessionsService, type ReqInfo } from './sessions.service.js';
import type { SecondFactorChallenge } from '@bmu/shared';

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** v58: sign-in code limits, counted in the database so they hold across every server (Vercel runs many). */
const RESEND_WAIT_MS = 60_000;
const LIMIT_WINDOW_MS = 15 * 60_000;
const MAX_PER_ADDRESS = 6;
const MAX_PER_NETWORK = 30;
const tooMany = (message: string, retryAfterSec: number) => new HttpException({ statusCode: 429, message, retryAfterSec }, 429);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly me: MeService,
    private readonly sender: OtpSender,
    private readonly sessions: SessionsService,
  ) {}

  /** v20: sign-in codes are limited per address and per network (bot protection). Local development is not limited. */
  private readonly attempts = new Map<string, number[]>();
  private limit(key: string, max: number, windowMs: number, ip?: string) {
    const local = !ip || /^(::1|127\.|::ffff:127\.)/.test(ip);
    if (local && process.env.NODE_ENV !== 'production') return;
    const now = Date.now();
    const list = (this.attempts.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) throw new HttpException({ statusCode: 429, message: `Too many sign-in attempts. Try again in ${Math.ceil((windowMs - (now - list[0])) / 60_000)} minutes.` }, 429);
    list.push(now);
    this.attempts.set(key, list);
    if (this.attempts.size > 10_000) this.attempts.clear();
  }

  private hash(identifier: string, code: string) {
    return createHash('sha256').update(`${identifier}:${code}:${process.env.JWT_SECRET}`).digest('hex');
  }

  private findUser(identifier: string) {
    return this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        status: { not: 'suspended' },
        ...(identifier.includes('@') ? { email: identifier } : { phone: identifier }),
      },
    });
  }

  /**
   * v58: a new code at most once a minute per address, 6 per address and 30 per network in 15 minutes. Counted from
   * the codes in the database, so the limits hold across servers. Local development is not limited (as before).
   */
  private async codeLimits(identifier: string, ip?: string) {
    const local = !ip || /^(::1|127\.|::ffff:127\.)/.test(ip);
    if (local && process.env.NODE_ENV !== 'production') return;
    const now = Date.now();
    const recent = await this.prisma.otpCode.findMany({ where: { identifier, createdAt: { gte: new Date(now - LIMIT_WINDOW_MS) } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const last = recent[0]?.createdAt.getTime();
    if (last && now - last < RESEND_WAIT_MS) {
      const s = Math.ceil((RESEND_WAIT_MS - (now - last)) / 1000);
      throw tooMany(`A code was just sent. Check your inbox (and spam), or ask for a new one in ${s} seconds.`, s);
    }
    if (recent.length >= MAX_PER_ADDRESS) {
      const s = Math.ceil((recent[recent.length - 1].createdAt.getTime() + LIMIT_WINDOW_MS - now) / 1000);
      throw tooMany(`Too many codes asked for this address. Try again in ${Math.ceil(s / 60)} minutes.`, s);
    }
    if (ip) {
      const fromNetwork = await this.prisma.otpCode.count({ where: { ip, createdAt: { gte: new Date(now - LIMIT_WINDOW_MS) } } });
      if (fromNetwork >= MAX_PER_NETWORK) throw tooMany('Too many sign-in codes asked from this network. Try again in 15 minutes.', LIMIT_WINDOW_MS / 1000);
    }
  }

  async requestOtp(raw: string, ip?: string): Promise<{ sent: true; devCode?: string; resendInSec: number }> {
    const identifier = normaliseIdentifier(raw);
    // Per-server check first (also slows down guessing which addresses have an account), then the database limits.
    this.limit(`ip:${ip}`, MAX_PER_NETWORK, LIMIT_WINDOW_MS, ip);
    await this.codeLimits(identifier, ip);
    const user = await this.findUser(identifier);
    if (!user) throw new NotFoundException('No BMU account uses that email or number. Ask your client manager for an invite.');

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.otpCode.create({
      data: { identifier, codeHash: this.hash(identifier, code), expiresAt: new Date(Date.now() + OTP_TTL_MS), ip: ip?.slice(0, 64) ?? null },
    });
    await this.sender.send(identifier, code);
    const resendInSec = RESEND_WAIT_MS / 1000;
    return process.env.NODE_ENV === 'production' ? { sent: true, resendInSec } : { sent: true, devCode: code, resendInSec };
  }

  /**
   * Sign in with Google: Google has confirmed the person owns this (verified) email. From here it is the same as a correct
   * email code: the same account lookup (exists, not removed, not suspended), the same two-factor step and the same
   * session, so roles and permissions apply exactly as for any other sign-in.
   */
  async signInWithGoogle(email: string, googleSub: string, req: ReqInfo = {}): Promise<{ token: string; me: Me } | SecondFactorChallenge> {
    const identifier = normaliseIdentifier(email);
    this.limit(`google-ip:${req.ip}`, 40, 15 * 60_000, req.ip);
    if (!identifier.includes('@') || !googleSub) throw new NotFoundException('No BMU account uses that Google email');
    const user = await this.findUser(identifier);
    if (!user) throw new NotFoundException('No BMU account uses that Google email');
    // v42: the first Google sign-in ties the account to that Google account; later ones must be the same Google account
    // (so a deleted and recreated address cannot be used by someone else). A changed email in the CRM, or Unlink in
    // Profile > Security, lets the next Google sign-in tie it again.
    const bound = !!user.googleSub && user.googleEmail === identifier;
    if (bound && user.googleSub !== googleSub) {
      throw new ForbiddenException({ statusCode: 403, code: 'google_account_mismatch', message: 'This BMU account is tied to a different Google account. Sign in with an email code, then unlink Google in Profile > Security.' });
    }
    if (!bound) await this.prisma.user.update({ where: { id: user.id }, data: { googleSub, googleEmail: identifier } });
    if (user.status === 'invited') await this.prisma.user.update({ where: { id: user.id }, data: { status: 'active' } });
    const next = await this.sessions.afterFirstFactor(user.id, user.orgId, req, 'google');
    if ('needsSecondFactor' in next) return next;
    const me = await this.me.load(user.id);
    return { token: next.token, me: me! };
  }

  async verifyOtp(raw: string, code: string, req: ReqInfo = {}): Promise<{ token: string; me: Me } | SecondFactorChallenge> {
    const identifier = normaliseIdentifier(raw);
    this.limit(`verify-ip:${req.ip}`, 40, 15 * 60_000, req.ip);
    // v58: any code still valid for this address works (whichever email the person opens). A wrong guess counts
    // against all of them together, so 5 wrong guesses still lock the address until a new code is asked for.
    const valid = await this.prisma.otpCode.findMany({
      where: { identifier, usedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { createdAt: 'desc' },
      take: MAX_PER_ADDRESS * 2,
    });
    if (!valid.length) throw new BadRequestException('Code expired. Request a new one');
    const hit = valid.find((o) => o.codeHash === this.hash(identifier, code));
    if (!hit) {
      await this.prisma.otpCode.updateMany({ where: { id: { in: valid.map((o) => o.id) } }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException('That code is not right');
    }
    // Claim it once (two quick submits sign in once), then retire the other codes still out there.
    const now = new Date();
    const claimed = await this.prisma.otpCode.updateMany({ where: { id: hit.id, usedAt: null }, data: { usedAt: now } });
    if (!claimed.count) throw new BadRequestException('Code expired. Request a new one');
    await this.prisma.otpCode.updateMany({ where: { identifier, usedAt: null, id: { not: hit.id } }, data: { usedAt: now } });

    const user = await this.findUser(identifier);
    if (!user) throw new NotFoundException('Account not found');
    if (user.status === 'invited') await this.prisma.user.update({ where: { id: user.id }, data: { status: 'active' } });

    // v20: people with two-factor on get a second step instead of a session.
    const next = await this.sessions.afterFirstFactor(user.id, user.orgId, req);
    if ('needsSecondFactor' in next) return next;
    const me = await this.me.load(user.id);
    return { token: next.token, me: me! };
  }
}
