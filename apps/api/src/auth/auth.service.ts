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

  async requestOtp(raw: string, ip?: string): Promise<{ sent: true; devCode?: string }> {
    const identifier = normaliseIdentifier(raw);
    this.limit(`id:${identifier}`, 6, 15 * 60_000, ip);
    this.limit(`ip:${ip}`, 30, 15 * 60_000, ip);
    const user = await this.findUser(identifier);
    if (!user) throw new NotFoundException('No BMU account uses that email or number. Ask your client manager for an invite.');

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.otpCode.create({
      data: { identifier, codeHash: this.hash(identifier, code), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    });
    await this.sender.send(identifier, code);
    return process.env.NODE_ENV === 'production' ? { sent: true } : { sent: true, devCode: code };
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
    const otp = await this.prisma.otpCode.findFirst({
      where: { identifier, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.attempts >= MAX_ATTEMPTS) throw new BadRequestException('Code expired. Request a new one');
    if (otp.codeHash !== this.hash(identifier, code)) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException('That code is not right');
    }
    await this.prisma.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } });

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
