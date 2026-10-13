// v20 sign-in security: device sessions (sign out anywhere), authenticator-app two-factor with recovery codes, and
// passkeys (WebAuthn) as a password-free sign-in or as the second step.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { settingsDefaults, type Me, type SecondFactorChallenge, type SecurityOverview, type SessionView, type TotpSetup } from '@bmu/shared';
import { seal, signToken, unseal, verifyToken } from '../integrations/crypto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../security/totp.js';
import type { SessionClaims } from './session.js';
import { eventBus } from '../platform/event-bus.js';

export type ReqInfo = { ip?: string; userAgent?: string };
type Challenge = { k: 'second_factor'; u: string; m: string } | { k: 'passkey_register'; u: string; c: string } | { k: 'passkey_login'; c: string };

const hashCode = (code: string) => createHash('sha256').update(`recovery:${code.replace(/[\s-]/g, '').toLowerCase()}:${process.env.JWT_SECRET ?? ''}`).digest('hex');

/** Where passkeys are bound: the web app's address (the API is reached through it at /api). */
function relyingParty() {
  const origin = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  return { origin, rpID: new URL(origin).hostname, rpName: 'BMU Hub' };
}

function deviceLabel(ua: string | null | undefined) {
  if (!ua) return 'Unknown device';
  if (/Expo|okhttp|CFNetwork|BMUHub/i.test(ua)) return 'BMU Hub app';
  const os = /Windows/i.test(ua) ? 'Windows' : /iPhone|iPad/i.test(ua) ? 'iPhone' : /Android/i.test(ua) ? 'Android' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /node|undici|curl/i.test(ua) ? 'Script' : 'Browser';
  return `${browser} on ${os}`;
}

@Injectable()
export class SessionsService {
  /** sid → last check, so the guard doesn't hit the database on every request. */
  private readonly cache = new Map<string, { ok: boolean; at: number; seenAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {
    // v21: a session signed out on another API process stops working here at once too.
    eventBus.watch(['UserSession'], (e) => (e.ids.length ? e.ids.forEach((id) => this.cache.delete(id)) : this.cache.clear()));
  }

  // ---------------------------------------------------------------------------------------------- sessions

  async issue(userId: string, orgId: string, method: string, req: ReqInfo): Promise<string> {
    const s = await this.prisma.userSession.create({ data: { userId, orgId, method, ip: req.ip ?? null, userAgent: req.userAgent?.slice(0, 300) ?? null } });
    const claims: SessionClaims = { sub: userId, org: orgId, sid: s.id, amr: method };
    return this.jwt.signAsync(claims);
  }

  /** True when the session is still signed in. Tokens from before v20 carry no session id and stay valid. */
  async isActive(sid: string | undefined): Promise<boolean> {
    if (!sid) return true;
    const now = Date.now();
    const hit = this.cache.get(sid);
    if (hit && now - hit.at < 15_000) return hit.ok;
    const s = await this.prisma.userSession.findUnique({ where: { id: sid }, select: { revokedAt: true, lastSeenAt: true } });
    const ok = !!s && !s.revokedAt;
    let seenAt = hit?.seenAt ?? s?.lastSeenAt.getTime() ?? 0;
    if (ok && now - seenAt > 5 * 60_000) {
      seenAt = now;
      await this.prisma.userSession.update({ where: { id: sid }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
    }
    this.cache.set(sid, { ok, at: now, seenAt });
    return ok;
  }

  forget(sid: string) {
    this.cache.delete(sid);
    this.strongCache.delete(sid);
  }

  async list(me: Me): Promise<SessionView[]> {
    const rows = await this.prisma.userSession.findMany({ where: { userId: me.id, revokedAt: null }, orderBy: { lastSeenAt: 'desc' }, take: 50 });
    return rows.map((s) => ({ id: s.id, method: s.method, device: deviceLabel(s.userAgent), ip: s.ip, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(), current: s.id === me.sessionId }));
  }

  async revoke(me: Me, id: string) {
    const s = await this.prisma.userSession.findFirst({ where: { id, userId: me.id } });
    if (!s) throw new NotFoundException('Session not found');
    await this.prisma.userSession.update({ where: { id }, data: { revokedAt: new Date() } });
    this.forget(id);
    return { ok: true as const };
  }

  /** Signs out every device except (optionally) this one. Branch Managers can do it for someone else (lost phone, leaver). */
  async revokeAll(userId: string, keep?: string) {
    const rows = await this.prisma.userSession.findMany({ where: { userId, revokedAt: null, ...(keep ? { id: { not: keep } } : {}) }, select: { id: true } });
    await this.prisma.userSession.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { revokedAt: new Date() } });
    for (const r of rows) this.forget(r.id);
    return { signedOut: rows.length };
  }

  // ---------------------------------------------------------------------------------------------- two-factor

  private readonly requiredCache = new Map<string, { roles: string[]; at: number }>();
  private readonly strongCache = new Map<string, { strong: boolean; at: number }>();

  /** Roles that must use two-factor (Settings → Security). */
  async requiredRoles(orgId: string): Promise<string[]> {
    const hit = this.requiredCache.get(orgId);
    if (hit && Date.now() - hit.at < 30_000) return hit.roles;
    const roles = await this.loadRequiredRoles(orgId);
    this.requiredCache.set(orgId, { roles, at: Date.now() });
    return roles;
  }

  clearRequiredCache(orgId: string) {
    this.requiredCache.delete(orgId);
  }

  /** The guard's question: must this signed-in person finish two-factor before using the app? */
  async mustDoTwoFactor(me: Me, sid: string | undefined): Promise<boolean> {
    const required = await this.requiredRoles(me.orgId);
    if (!me.roles.some((r) => required.includes(r))) return false;
    if (!sid) return true;
    const hit = this.strongCache.get(sid);
    if (hit && Date.now() - hit.at < 30_000) return !hit.strong;
    const strong = await this.sessionStrong(sid);
    this.strongCache.set(sid, { strong, at: Date.now() });
    return !strong;
  }

  private async loadRequiredRoles(orgId: string): Promise<string[]> {
    const org = await this.prisma.organisation.findUnique({ where: { id: orgId }, select: { settings: true } });
    const sec = (org?.settings as { v8?: { security?: { require2faRoles?: string[] } } } | null)?.v8?.security;
    return sec?.require2faRoles ?? settingsDefaults.security.require2faRoles;
  }

  async status(userId: string, orgId: string, roles: string[]) {
    const [totp, passkeys, required] = await Promise.all([
      this.prisma.userTotp.findUnique({ where: { userId }, select: { enabledAt: true } }),
      this.prisma.passkey.count({ where: { userId } }),
      this.requiredRoles(orgId),
    ]);
    return { enrolled: !!totp?.enabledAt || passkeys > 0, totp: !!totp?.enabledAt, passkeys, required: roles.some((r) => required.includes(r)) };
  }

  /** After the email/phone code: a token, or a challenge when this person has two-factor turned on. */
  async afterFirstFactor(userId: string, orgId: string, req: ReqInfo): Promise<{ token: string } | SecondFactorChallenge> {
    const [totp, passkeys] = await Promise.all([this.prisma.userTotp.findUnique({ where: { userId } }), this.prisma.passkey.count({ where: { userId } })]);
    const methods: SecondFactorChallenge['methods'] = [];
    if (totp?.enabledAt) methods.push('totp', 'recovery');
    if (passkeys) methods.push('passkey');
    if (!methods.length) return { token: await this.issue(userId, orgId, 'otp', req) };
    return { needsSecondFactor: true, challenge: signToken({ k: 'second_factor', u: userId, m: 'otp' } satisfies Challenge, 600), methods };
  }

  async secondFactor(challenge: string, code: string, req: ReqInfo) {
    const c = verifyToken<Challenge>(challenge);
    if (!c || c.k !== 'second_factor') throw new UnauthorizedException('This sign-in has expired. Start again.');
    const user = await this.prisma.user.findFirst({ where: { id: c.u, deletedAt: null, status: { not: 'suspended' } } });
    if (!user) throw new UnauthorizedException('Account not active');
    const totp = await this.prisma.userTotp.findUnique({ where: { userId: user.id } });
    if (!totp?.enabledAt) throw new BadRequestException('Two-factor is not set up for this account');
    const clean = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(clean)) {
      const step = verifyTotp(unseal(totp.secretEnc)!, clean, totp.lastUsedStep);
      if (step === null) throw new BadRequestException('That code is not right. Check the time on your phone and try the newest code.');
      await this.prisma.userTotp.update({ where: { userId: user.id }, data: { lastUsedStep: step } });
      return { token: await this.issue(user.id, user.orgId, 'otp+totp', req), userId: user.id };
    }
    const h = hashCode(clean);
    if (!totp.recoveryCodes.includes(h)) throw new BadRequestException('That recovery code is not right or was already used');
    await this.prisma.userTotp.update({ where: { userId: user.id }, data: { recoveryCodes: totp.recoveryCodes.filter((x) => x !== h) } });
    return { token: await this.issue(user.id, user.orgId, 'otp+recovery', req), userId: user.id };
  }

  async totpSetup(me: Me): Promise<TotpSetup> {
    const existing = await this.prisma.userTotp.findUnique({ where: { userId: me.id } });
    if (existing?.enabledAt) throw new BadRequestException('Two-factor is already on. Turn it off first to set up a new phone.');
    const secret = newTotpSecret();
    await this.prisma.userTotp.upsert({ where: { userId: me.id }, create: { userId: me.id, orgId: me.orgId, secretEnc: seal(secret) }, update: { secretEnc: seal(secret), lastUsedStep: null } });
    return { secret, otpauthUrl: otpauthUrl(secret, me.email ?? me.phone ?? me.name) };
  }

  /** Confirms the first code from the app, turns two-factor on and returns 10 one-time recovery codes. */
  async totpEnable(me: Me, code: string) {
    const row = await this.prisma.userTotp.findUnique({ where: { userId: me.id } });
    if (!row) throw new BadRequestException('Start the set-up first');
    if (row.enabledAt) throw new BadRequestException('Two-factor is already on');
    const step = verifyTotp(unseal(row.secretEnc)!, code, null);
    if (step === null) throw new BadRequestException('That code is not right. Enter the 6-digit code your app shows now.');
    const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
    await this.prisma.userTotp.update({ where: { userId: me.id }, data: { enabledAt: new Date(), lastUsedStep: step, recoveryCodes: codes.map(hashCode) } });
    await this.markSessionStrong(me);
    return { recoveryCodes: codes };
  }

  async totpDisable(me: Me, code: string) {
    const row = await this.prisma.userTotp.findUnique({ where: { userId: me.id } });
    if (!row?.enabledAt) throw new BadRequestException('Two-factor is not on');
    if (verifyTotp(unseal(row.secretEnc)!, code, row.lastUsedStep) === null && !row.recoveryCodes.includes(hashCode(code))) throw new BadRequestException('That code is not right');
    const st = await this.status(me.id, me.orgId, me.roles);
    if (st.required && st.passkeys === 0) throw new ForbiddenException('Your role must use two-factor. Add a passkey first, or ask the Founder to change Settings → Security.');
    await this.prisma.userTotp.delete({ where: { userId: me.id } });
    return { ok: true as const };
  }

  /** Two-factor set up during this session counts for it (no need to sign in again). */
  private async markSessionStrong(me: Me) {
    if (!me.sessionId) return;
    const s = await this.prisma.userSession.findUnique({ where: { id: me.sessionId } });
    if (s && !s.method.includes('+') && s.method !== 'passkey') await this.prisma.userSession.update({ where: { id: s.id }, data: { method: `${s.method}+enrolled` } });
    this.strongCache.delete(me.sessionId);
  }

  async sessionStrong(sid: string | undefined) {
    if (!sid) return false;
    const s = await this.prisma.userSession.findUnique({ where: { id: sid }, select: { method: true } });
    return !!s && (s.method === 'passkey' || s.method.includes('+'));
  }

  // ---------------------------------------------------------------------------------------------- passkeys

  async passkeyRegisterOptions(me: Me) {
    const rp = relyingParty();
    const existing = await this.prisma.passkey.findMany({ where: { userId: me.id }, select: { credentialId: true, transports: true } });
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: me.email ?? me.phone ?? me.id,
      userDisplayName: me.name,
      userID: new TextEncoder().encode(me.id),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    return { options, token: signToken({ k: 'passkey_register', u: me.id, c: options.challenge } satisfies Challenge, 300) };
  }

  async passkeyRegister(me: Me, token: string, response: RegistrationResponseJSON, name: string) {
    const c = verifyToken<Challenge>(token);
    if (!c || c.k !== 'passkey_register' || c.u !== me.id) throw new BadRequestException('This passkey set-up expired. Try again.');
    const rp = relyingParty();
    let v;
    try {
      v = await verifyRegistrationResponse({ response, expectedChallenge: c.c, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: false });
    } catch (e) {
      throw new BadRequestException(`The passkey could not be checked: ${(e as Error).message}`);
    }
    if (!v.verified) throw new BadRequestException('The passkey could not be checked');
    const cred = v.registrationInfo.credential;
    const row = await this.prisma.passkey.create({
      data: { orgId: me.orgId, userId: me.id, credentialId: cred.id, publicKey: Buffer.from(cred.publicKey), counter: cred.counter, transports: cred.transports ?? [], name: name || 'Passkey' },
    });
    await this.markSessionStrong(me);
    return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString(), lastUsedAt: null };
  }

  async passkeyLoginOptions() {
    const rp = relyingParty();
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred' });
    return { options, token: signToken({ k: 'passkey_login', c: options.challenge } satisfies Challenge, 300) };
  }

  /** Signs in with a passkey (no code needed), or completes the second step for a pending sign-in. */
  async passkeyLogin(token: string, response: AuthenticationResponseJSON, req: ReqInfo, pendingChallenge?: string) {
    const c = verifyToken<Challenge>(token);
    if (!c || c.k !== 'passkey_login') throw new UnauthorizedException('This passkey sign-in expired. Try again.');
    const pk = await this.prisma.passkey.findUnique({ where: { credentialId: response.id } });
    if (!pk) throw new UnauthorizedException('This passkey is not registered with BMU Hub');
    if (pendingChallenge) {
      const p = verifyToken<Challenge>(pendingChallenge);
      if (!p || p.k !== 'second_factor' || p.u !== pk.userId) throw new UnauthorizedException('Use a passkey that belongs to this account');
    }
    const rp = relyingParty();
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: c.c,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
        credential: { id: pk.credentialId, publicKey: new Uint8Array(pk.publicKey), counter: pk.counter, transports: pk.transports as never },
      });
    } catch (e) {
      throw new UnauthorizedException(`The passkey could not be checked: ${(e as Error).message}`);
    }
    if (!v.verified) throw new UnauthorizedException('The passkey could not be checked');
    await this.prisma.passkey.update({ where: { id: pk.id }, data: { counter: v.authenticationInfo.newCounter, lastUsedAt: new Date() } });
    const user = await this.prisma.user.findFirst({ where: { id: pk.userId, deletedAt: null, status: { not: 'suspended' } } });
    if (!user) throw new UnauthorizedException('Account not active');
    return { token: await this.issue(user.id, user.orgId, pendingChallenge ? 'otp+passkey' : 'passkey', req), userId: user.id };
  }

  async removePasskey(me: Me, id: string) {
    const pk = await this.prisma.passkey.findFirst({ where: { id, userId: me.id } });
    if (!pk) throw new NotFoundException('Passkey not found');
    const st = await this.status(me.id, me.orgId, me.roles);
    if (st.required && !st.totp && st.passkeys <= 1) throw new ForbiddenException('Your role must use two-factor. Turn on the authenticator app first.');
    await this.prisma.passkey.delete({ where: { id } });
    return { ok: true as const };
  }

  async overview(me: Me): Promise<SecurityOverview> {
    const [totp, passkeys, sessions, st] = await Promise.all([
      this.prisma.userTotp.findUnique({ where: { userId: me.id } }),
      this.prisma.passkey.findMany({ where: { userId: me.id }, orderBy: { createdAt: 'asc' } }),
      this.list(me),
      this.status(me.id, me.orgId, me.roles),
    ]);
    return {
      totp: { enabled: !!totp?.enabledAt, recoveryCodesLeft: totp?.enabledAt ? totp.recoveryCodes.length : 0 },
      passkeys: passkeys.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt.toISOString(), lastUsedAt: p.lastUsedAt?.toISOString() ?? null })),
      sessions,
      required: st.required,
    };
  }
}
