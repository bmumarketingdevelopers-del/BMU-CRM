import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { SETTINGS_SECTIONS, settingsCapability, settingsDefaults, settingsSchemas, type AllSettings, type Me, type SettingsSection, type SettingsValue } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsService } from '../auth/sessions.service.js';

const ADMIN_ROLES = ['founder', 'admin', 'department_head', 'finance', 'am_lead', 'hr_ops'];

/** Organisation settings edited from the Command Centre (holidays, SLA, GST, templates, branding…). */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
  ) {}

  /** v11 ops: callbacks after a section is saved (e.g. holidays → recalculate SLA timers and deadlines). */
  private readonly savedHooks: ((me: Me, section: SettingsSection) => Promise<void>)[] = [];
  onSaved(fn: (me: Me, section: SettingsSection) => Promise<void>) {
    this.savedHooks.push(fn);
  }

  private async raw(orgId: string) {
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true, name: true } });
    return { settings: (org.settings ?? {}) as Record<string, unknown>, name: org.name };
  }

  /** One section with defaults filled in. Usable by any service. */
  async get<S extends SettingsSection>(orgId: string, section: S): Promise<SettingsValue<S>> {
    const { settings, name } = await this.raw(orgId);
    return this.fill(section, settings, name);
  }

  private fill<S extends SettingsSection>(section: S, settings: Record<string, unknown>, orgName: string): SettingsValue<S> {
    const def = settingsDefaults[section];
    if (section === 'discountLimits') return { ...(def as object), ...((settings.discountLimits as object) ?? {}) } as SettingsValue<S>;
    const stored = (settings.v8 as Record<string, unknown> | undefined)?.[section];
    if (section === 'holidays' && !stored) {
      const dates = (settings.holidays as string[] | undefined) ?? [];
      if (dates.length) return { list: dates.map((date) => ({ date, name: 'Holiday' })) } as SettingsValue<S>;
    }
    if (section === 'tenant' && !stored) return { ...(def as object), name: orgName } as SettingsValue<S>;
    if (!stored) return def;
    if (Array.isArray(def) || typeof def !== 'object') return stored as SettingsValue<S>;
    // v15: AI feature groups added later (e.g. agents) default to their standard value for older saved settings.
    if (section === 'ai') return { ...(def as object), ...(stored as object), features: { ...(def as { features: object }).features, ...((stored as { features?: object }).features ?? {}) } } as SettingsValue<S>;
    return { ...(def as object), ...(stored as object) } as SettingsValue<S>;
  }

  private assertReader(me: Me) {
    if (me.type !== 'staff' || !me.roles.some((r) => ADMIN_ROLES.includes(r))) throw new ForbiddenException('Command Centre only');
  }

  async all(me: Me): Promise<AllSettings & { canEdit: Record<SettingsSection, boolean> }> {
    this.assertReader(me);
    const { settings, name } = await this.raw(me.orgId);
    const out = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s, this.fill(s, settings, name)])) as AllSettings;
    const canEdit = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s, this.canEdit(me, s)])) as Record<SettingsSection, boolean>;
    return { ...out, canEdit };
  }

  canEdit(me: Me, section: SettingsSection) {
    const scope = me.permissions[settingsCapability[section]]?.scope ?? 'none';
    // Platform-wide sections are Founder/Admin only; others need the capability plus a leadership role.
    const editors = ['branding', 'tenant', 'notificationTemplates', 'ai'].includes(section)
      ? ['founder', 'admin']
      : section === 'workingHours'
        ? ['founder'] // v30: only the Founder changes the company working time (check-in window, late, grace)
        : section === 'holidays'
        ? ['founder', 'admin', 'hr_ops']
        : ['founder', 'admin', 'finance', 'department_head'];
    return me.type === 'staff' && scope !== 'none' && me.roles.some((r) => editors.includes(r));
  }

  async save<S extends SettingsSection>(me: Me, section: S, body: unknown, ip?: string) {
    if (!SETTINGS_SECTIONS.includes(section)) throw new BadRequestException('Unknown settings section');
    if (!this.canEdit(me, section)) throw new ForbiddenException('You cannot change these settings');
    const parsed = settingsSchemas[section].safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const value = parsed.data as SettingsValue<S>;
    const { settings } = await this.raw(me.orgId);
    const before = this.fill(section, settings, '');
    const next: Record<string, unknown> = { ...settings, v8: { ...((settings.v8 as object) ?? {}), [section]: value } };
    // Keep the keys other services already read in sync.
    if (section === 'holidays') next.holidays = (value as SettingsValue<'holidays'>).list.map((h) => h.date).sort();
    if (section === 'discountLimits') next.discountLimits = value;
    const data: Prisma.OrganisationUpdateInput = { settings: next as Prisma.InputJsonValue };
    if (section === 'tenant') data.name = (value as SettingsValue<'tenant'>).name;
    if (section === 'branding') data.branding = value as Prisma.InputJsonValue;
    await this.prisma.organisation.update({ where: { id: me.orgId }, data });
    await this.audit.log(me, `settings.${section}.updated`, 'Organisation', me.orgId, before, value, ip);
    if (section === 'security') this.sessions.clearRequiredCache(me.orgId);
    for (const fn of this.savedHooks) await fn(me, section);
    return this.all(me);
  }
}
