// v20: each person's own sign-in security (Profile → Security): two-factor, passkeys and signed-in devices, plus
// "sign this person out everywhere" for Founder and Admin.
import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { passkeyNameSchema, totpCodeSchema, type Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsService } from './sessions.service.js';

const registerSchema = passkeyNameSchema.extend({ token: z.string().min(10), response: z.object({ id: z.string() }).passthrough() });
const disableSchema = z.object({ code: z.string().trim().min(6).max(20) });

@Controller('security')
export class SecurityController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('me')
  overview(@CurrentUser() me: Me) {
    return this.sessions.overview(me);
  }

  @Post('totp/setup')
  @HttpCode(200)
  totpSetup(@CurrentUser() me: Me) {
    return this.sessions.totpSetup(me);
  }

  @Post('totp/enable')
  @HttpCode(200)
  async totpEnable(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    const r = await this.sessions.totpEnable(me, parse(totpCodeSchema, body).code);
    await this.audit.log(me, 'security.2fa_enabled', 'User', me.id, undefined, { method: 'totp' }, ip);
    return r;
  }

  @Post('totp/disable')
  @HttpCode(200)
  async totpDisable(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    const r = await this.sessions.totpDisable(me, parse(disableSchema, body).code);
    await this.audit.log(me, 'security.2fa_disabled', 'User', me.id, undefined, { method: 'totp' }, ip);
    return r;
  }

  @Post('passkeys/options')
  @HttpCode(200)
  passkeyOptions(@CurrentUser() me: Me) {
    return this.sessions.passkeyRegisterOptions(me);
  }

  @Post('passkeys')
  async addPasskey(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    const b = parse(registerSchema, body);
    const r = await this.sessions.passkeyRegister(me, b.token, b.response as never, b.name);
    await this.audit.log(me, 'security.passkey_added', 'User', me.id, undefined, { name: r.name }, ip);
    return r;
  }

  @Delete('passkeys/:id')
  async removePasskey(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    const r = await this.sessions.removePasskey(me, id);
    await this.audit.log(me, 'security.passkey_removed', 'User', me.id, undefined, { passkeyId: id }, ip);
    return r;
  }

  @Get('sessions')
  list(@CurrentUser() me: Me) {
    return this.sessions.list(me);
  }

  @Delete('sessions/:id')
  revoke(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.sessions.revoke(me, id);
  }

  @Post('sessions/sign-out-others')
  @HttpCode(200)
  async signOutOthers(@CurrentUser() me: Me, @ClientIp() ip?: string) {
    const r = await this.sessions.revokeAll(me.id, me.sessionId);
    await this.audit.log(me, 'security.signed_out_everywhere', 'User', me.id, undefined, r, ip);
    return r;
  }

  /** Founder and Admin: sign a person out of every device (lost phone, someone leaving). */
  @Post('users/:id/sign-out')
  @HttpCode(200)
  async signOutUser(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    if (!me.roles.some((r) => r === 'founder' || r === 'admin')) throw new ForbiddenException('Only the Founder or an Admin can do this');
    const user = await this.prisma.user.findFirst({ where: { id, orgId: me.orgId } });
    if (!user) throw new ForbiddenException('Person not found');
    const r = await this.sessions.revokeAll(id);
    await this.audit.log(me, 'security.user_signed_out', 'User', id, undefined, r, ip);
    return r;
  }
}
