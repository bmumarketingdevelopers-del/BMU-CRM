// v20 Command Centre security: field-level permission editor with "view as this person", audit-chain check,
// DPDP requests, consents and retention, plus the public privacy endpoints.
import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { CAPABILITIES, PEOPLE_CAPABILITY_LABELS, fieldAccessSaveSchema, PROTECTED_FIELDS, ALL_ROLES, fieldModeFor, hierarchyData, type FieldAccessView, type Me, type ViewAsView, type FieldMode } from '@bmu/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { MeService } from '../auth/me.service.js';
import { ClientIp, CurrentUser, Public } from '../common/decorators.js';
import { publicLimit } from '../common/rate-limit.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { assertDpdp, DpdpService, withdrawSchema } from './dpdp.service.js';
import { redact } from './field-access.js';
import { FieldAccessService } from './field-access.service.js';

const roleLabel = (id: string) => (hierarchyData.team_roles as readonly { id: string; name: string }[]).concat(hierarchyData.client_roles as readonly { id: string; name: string }[]).find((r) => r.id === id)?.name?.replace(/\s*\(.*\)\s*$/, '') ?? id;
const customAccessSchema = z.object({ hiddenFrom: z.array(z.string()).max(30), readOnlyFor: z.array(z.string()).max(30) });

@Controller('security-admin')
export class SecurityAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fields: FieldAccessService,
    private readonly settings: SettingsService,
    private readonly meService: MeService,
    private readonly audit: AuditService,
    private readonly dpdp: DpdpService,
  ) {}

  private assertAdmin(me: Me) {
    if (me.type !== 'staff' || !me.roles.some((r) => r === 'founder' || r === 'admin')) throw new ForbiddenException('Only the Founder or a Branch Manager can open this');
  }

  // ---------------------------------------------------------------------------------------------- field access

  @Get('fields')
  async fieldAccess(@CurrentUser() me: Me): Promise<FieldAccessView> {
    this.assertAdmin(me);
    const rules = await this.fields.rules(me.orgId);
    const custom = await this.prisma.customFieldDef.findMany({ where: { orgId: me.orgId, archivedAt: null }, orderBy: [{ entity: 'asc' }, { position: 'asc' }] });
    const roles = ALL_ROLES;
    return {
      fields: [
        ...PROTECTED_FIELDS.map((f) => ({ key: f.key, label: f.label, area: f.area, description: f.description, modes: Object.fromEntries(roles.map((r) => [r, fieldModeFor(f.key, [r], rules.overrides)])) as Record<string, FieldMode> })),
        ...custom.map((c) => ({
          key: `custom.${c.id}`,
          label: c.label,
          area: `Custom field · ${c.entity}`,
          description: c.helpText ?? `Custom field “${c.key}” on ${c.entity}s`,
          modes: Object.fromEntries(roles.map((r) => [r, r === 'founder' ? 'edit' : c.hiddenFrom.includes(r) ? 'hidden' : c.readOnlyFor.includes(r) ? 'read' : 'edit'])) as Record<string, FieldMode>,
          custom: { entity: c.entity, id: c.id },
        })),
      ],
      roles: roles.map((r) => ({ id: r, label: roleLabel(r), client: r.startsWith('client_') })),
      canEdit: true,
    };
  }

  @Put('fields')
  async saveFieldAccess(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    this.assertAdmin(me);
    const { fields } = parse(fieldAccessSaveSchema, body);
    const builtIn: Record<string, Record<string, FieldMode>> = {};
    for (const [key, modes] of Object.entries(fields)) {
      if (key.startsWith('custom.')) {
        const id = key.slice(7);
        const def = await this.prisma.customFieldDef.findFirst({ where: { id, orgId: me.orgId } });
        if (!def) throw new NotFoundException(`Custom field ${id} not found`);
        const hiddenFrom = Object.entries(modes).filter(([r, m]) => m === 'hidden' && r !== 'founder').map(([r]) => r);
        const readOnlyFor = Object.entries(modes).filter(([r, m]) => m === 'read' && r !== 'founder').map(([r]) => r);
        parse(customAccessSchema, { hiddenFrom, readOnlyFor });
        await this.prisma.customFieldDef.update({ where: { id }, data: { hiddenFrom, readOnlyFor } });
      } else if (PROTECTED_FIELDS.some((f) => f.key === key)) {
        // Founder always keeps full access so nobody can lock the company out of its own data.
        builtIn[key] = Object.fromEntries(Object.entries(modes).filter(([r]) => r !== 'founder'));
      }
    }
    await this.settings.save(me, 'fieldAccess', builtIn, ip);
    this.fields.clear(me.orgId);
    return this.fieldAccess(me);
  }

  /** "View as this person": what they can open, which protected fields they see, and a real record as they'd see it. */
  @Get('view-as/:userId')
  async viewAs(@CurrentUser() me: Me, @Param('userId') userId: string): Promise<ViewAsView> {
    this.assertAdmin(me);
    const person = await this.meService.load(userId);
    if (!person || person.orgId !== me.orgId) throw new NotFoundException('Person not found');
    const ctx = await this.fields.context(person);
    const lead = await this.prisma.lead.findFirst({ where: { orgId: me.orgId, deletedAt: null, budgetPaise: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, contact: true, need: true, stage: true, budgetPaise: true, score: true, customFields: true } });
    let sample: ViewAsView['sample'] = null;
    if (lead) {
      const shown = redact(lead as unknown as Record<string, unknown>, ctx);
      const hiddenKeys = Object.keys(lead).filter((k) => !(k in shown));
      const hiddenCustom = Object.keys((lead.customFields ?? {}) as object).filter((k) => !((shown.customFields as object | undefined) && k in (shown.customFields as object)));
      sample = { title: `Lead · ${(lead.contact as { company?: string; name?: string })?.company ?? (lead.contact as { name?: string })?.name ?? lead.id}`, shown, hiddenKeys: [...hiddenKeys, ...hiddenCustom.map((k) => `customFields.${k}`)] };
    }
    return {
      person: { id: person.id, name: person.name, roles: person.roles, type: person.type },
      capabilities: CAPABILITIES.map((c) => ({ capability: c, label: PEOPLE_CAPABILITY_LABELS[c] ?? c.replace(/_/g, ' '), scope: person.permissions[c]?.scope ?? 'none' })),
      fields: PROTECTED_FIELDS.map((f) => ({ key: f.key, label: f.label, mode: ctx.modes[f.key] })),
      menu: [],
      sample,
    };
  }

  // ---------------------------------------------------------------------------------------------- audit chain

  @Get('audit-chain')
  verifyAudit(@CurrentUser() me: Me, @Query('fromSeq') fromSeq?: string) {
    this.assertAdmin(me);
    return this.audit.verify(me.orgId, fromSeq ? Number(fromSeq) : undefined);
  }

  // ---------------------------------------------------------------------------------------------- DPDP

  @Get('privacy')
  privacy(@CurrentUser() me: Me) {
    return this.dpdp.overview(me);
  }

  @Post('privacy/requests')
  createRequest(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.dpdp.create(me, body, ip);
  }

  @Patch('privacy/requests/:id')
  updateRequest(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.dpdp.update(me, id, body, ip);
  }

  @Get('privacy/export/:type/:id')
  exportSubject(@CurrentUser() me: Me, @Param('type') type: string, @Param('id') id: string, @ClientIp() ip?: string) {
    if (type !== 'lead' && type !== 'user') throw new NotFoundException('Unknown record type');
    return this.dpdp.exportSubject(me, type, id, ip);
  }

  @Post('privacy/erase-lead/:id')
  @HttpCode(200)
  eraseLead(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.dpdp.eraseLead(me, id, ip);
  }

  @Post('privacy/consents/:id/withdraw')
  @HttpCode(200)
  withdraw(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.dpdp.withdrawConsent(me, id, ip);
  }

  @Put('privacy/retention')
  saveRetention(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.dpdp.saveRetention(me, body, ip);
  }

  @Post('privacy/retention/run')
  @HttpCode(200)
  async runRetention(@CurrentUser() me: Me) {
    // Deletes data across the whole organisation: the Founder only (v43).
    if (me.type !== 'staff' || !me.roles.includes('founder')) throw new ForbiddenException('Only the Founder can run the retention rules');
    return { ran: await this.dpdp.runRetention(me.orgId) };
  }
}

/** Public privacy endpoints: data requests and consent withdrawal (linked from /privacy and emails). */
@Controller('public/privacy')
export class PublicPrivacyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dpdp: DpdpService,
  ) {}

  private org() {
    return this.prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  }

  @Public()
  @Post('requests')
  async request(@Body() body: unknown, @ClientIp() ip?: string) {
    publicLimit(`privacy:${ip}`, 5, 60 * 60_000, ip);
    return this.dpdp.createPublic((await this.org()).id, body);
  }

  @Public()
  @Post('withdraw')
  @HttpCode(200)
  async withdraw(@Body() body: unknown, @ClientIp() ip?: string) {
    publicLimit(`withdraw:${ip}`, 10, 60 * 60_000, ip);
    const b = parse(withdrawSchema, body);
    return this.dpdp.withdrawByEmail((await this.org()).id, b.email, b.purpose);
  }
}
