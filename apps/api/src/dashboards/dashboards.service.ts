import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CRAFT_SPECIALTY_OPTIONS,
  DASHBOARD_BUILTINS,
  DASHBOARD_BUILTIN_KEYS,
  DASHBOARD_TEMPLATES,
  craftSpecialtyLabel,
  dashboardArchiveSchema,
  dashboardAudienceRank,
  dashboardAudienceSchema,
  dashboardAudienceText,
  dashboardCreateSchema,
  dashboardDefaultLayout,
  dashboardLayoutProblem,
  dashboardLayoutSchema,
  dashboardPlacementLabels,
  dashboardUpdateSchema,
  hierarchyData,
  isCraftManager,
  isCraftSpecialty,
  isDashboardBuiltinKey,
  type DashboardAudience,
  type DashboardBuiltinKey,
  type DashboardMenuItem,
  type DashboardPlacement,
  type DashboardRow,
  type DashboardStudio,
  type DashboardSurface,
  type DashboardVersionRow,
  type DashboardView,
  type DashboardWidget,
  type Me,
} from '@bmu/shared';
import type { Dashboard, Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parse } from '../common/zod.js';

const STUDIO_ROLES = ['founder', 'admin'];
const EMPTY_AUDIENCE: DashboardAudience = { everyone: false, roles: [], specialties: [], userIds: [] };

export const canEditDashboards = (me: Me) => me.type === 'staff' && me.roles.some((r) => STUDIO_ROLES.includes(r));
function assertStudio(me: Me) {
  if (!canEditDashboards(me)) throw new ForbiddenException('Only the Founder and Admins can change dashboards');
}

const roleLabels: Record<string, string> = Object.fromEntries(hierarchyData.team_roles.map((r) => [r.id, r.name.replace(/ \(.*\)$/, '')]));

@Injectable()
export class DashboardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Reading

  private audienceOf(d: Dashboard): DashboardAudience {
    const r = dashboardAudienceSchema.safeParse(d.audience);
    return r.success ? r.data : EMPTY_AUDIENCE;
  }

  /** Stored layout, dropping anything that no longer validates (e.g. a section removed in a later version). */
  private layoutOf(d: Pick<Dashboard, 'layout' | 'surface'>): DashboardWidget[] {
    const raw = Array.isArray(d.layout) ? d.layout : [];
    const out: DashboardWidget[] = [];
    for (const item of raw) {
      const r = dashboardLayoutSchema.element.safeParse(item);
      if (r.success && !dashboardLayoutProblem([...out, r.data], d.surface as DashboardSurface)) out.push(r.data);
    }
    return out;
  }

  private async names(orgId: string, ids: (string | null | undefined)[]) {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map<string, string>();
    const users = await this.prisma.user.findMany({ where: { orgId, id: { in: want } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private view(me: Me, d: Dashboard, updatedBy: string | null): DashboardView {
    const builtin = d.builtin && isDashboardBuiltinKey(d.builtin) ? d.builtin : null;
    const layout = this.layoutOf(d);
    return {
      id: d.id,
      key: d.key,
      builtin,
      name: d.name,
      description: d.description,
      surface: d.surface as DashboardSurface,
      placement: builtin ? null : (d.placement as DashboardPlacement),
      audience: builtin ? null : this.audienceOf(d),
      layout,
      customised: builtin ? JSON.stringify(layout) !== JSON.stringify(dashboardDefaultLayout(builtin)) : false,
      archived: !!d.archivedAt,
      updatedAt: d.updatedAt.toISOString(),
      updatedBy,
      canEdit: canEditDashboards(me),
    };
  }

  private async viewWithName(me: Me, d: Dashboard) {
    const names = await this.names(me.orgId, [d.updatedById]);
    return this.view(me, d, d.updatedById ? (names.get(d.updatedById) ?? null) : null);
  }

  /** The built-in dashboard's row, created with its original layout the first time anyone asks. */
  private async builtinRow(orgId: string, key: DashboardBuiltinKey): Promise<Dashboard> {
    const def = DASHBOARD_BUILTINS[key];
    return this.prisma.dashboard.upsert({
      where: { orgId_key: { orgId, key } },
      update: {},
      create: { orgId, key, builtin: key, name: def.name, surface: def.surface, placement: 'menu', layout: dashboardDefaultLayout(key) as unknown as Prisma.InputJsonValue },
    });
  }

  private async find(me: Me, id: string): Promise<Dashboard> {
    const d = await this.prisma.dashboard.findFirst({ where: { id, orgId: me.orgId } });
    if (!d) throw new NotFoundException('That dashboard no longer exists');
    return d;
  }

  async studio(me: Me): Promise<DashboardStudio> {
    assertStudio(me);
    for (const key of DASHBOARD_BUILTIN_KEYS) await this.builtinRow(me.orgId, key);
    const [rows, staff] = await Promise.all([
      this.prisma.dashboard.findMany({ where: { orgId: me.orgId }, orderBy: [{ updatedAt: 'desc' }] }),
      this.prisma.user.findMany({
        where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' } },
        select: { id: true, name: true, specialty: true, roles: { select: { role: { select: { baseRole: true } } } } },
        orderBy: { name: 'asc' },
      }),
    ]);
    const updaters = await this.names(me.orgId, rows.map((r) => r.updatedById));
    const nameMaps = {
      roles: roleLabels,
      specialties: Object.fromEntries(CRAFT_SPECIALTY_OPTIONS.map((s) => [s.id, s.label])),
      people: Object.fromEntries(staff.map((u) => [u.id, u.name])),
    };
    const row = (d: Dashboard): DashboardRow => {
      const builtin = d.builtin && isDashboardBuiltinKey(d.builtin) ? d.builtin : null;
      const layout = this.layoutOf(d);
      const def = builtin ? DASHBOARD_BUILTINS[builtin] : null;
      return {
        id: d.id,
        key: d.key,
        builtin,
        name: d.name,
        description: d.description,
        who: def ? def.who : dashboardAudienceText(this.audienceOf(d), nameMaps),
        where: def ? def.where : dashboardPlacementLabels[d.placement as DashboardPlacement] ?? d.placement,
        widgets: layout.length,
        customised: builtin ? JSON.stringify(layout) !== JSON.stringify(dashboardDefaultLayout(builtin)) : false,
        archived: !!d.archivedAt,
        archivedReason: d.archivedReason,
        updatedAt: d.updatedAt.toISOString(),
        updatedBy: d.updatedById ? (updaters.get(d.updatedById) ?? null) : null,
      };
    };
    const builtins = DASHBOARD_BUILTIN_KEYS.map((k) => rows.find((r) => r.key === k)).filter((r): r is Dashboard => !!r);
    return {
      builtins: builtins.map(row),
      custom: rows.filter((r) => !r.builtin && !r.archivedAt).map(row),
      archived: rows.filter((r) => !r.builtin && r.archivedAt).map(row),
      people: staff.map((u) => ({ id: u.id, name: u.name, roles: u.roles.map((r) => r.role.baseRole), specialty: u.specialty })),
      roles: hierarchyData.team_roles.map((r) => ({ id: r.id, label: roleLabels[r.id] })),
      specialties: CRAFT_SPECIALTY_OPTIONS.map((s) => ({ id: s.id, label: s.label })),
      templates: Object.entries(DASHBOARD_TEMPLATES).map(([key, t]) => ({ key, name: t.name, hint: t.hint })),
    };
  }

  /** Custom dashboards this person can open (Founder and Admin see every one). */
  private async visibleCustom(me: Me) {
    if (me.type !== 'staff') return [];
    const rows = await this.prisma.dashboard.findMany({ where: { orgId: me.orgId, builtin: null, archivedAt: null }, orderBy: { name: 'asc' } });
    return rows
      .map((d) => ({ d, rank: dashboardAudienceRank(this.audienceOf(d), { id: me.id, roles: me.roles, specialty: me.specialty }) }))
      .filter((x) => x.rank >= 0 || canEditDashboards(me));
  }

  async mine(me: Me): Promise<DashboardMenuItem[]> {
    const rows = await this.visibleCustom(me);
    return rows.map(({ d }) => ({ id: d.id, name: d.name, description: d.description, placement: d.placement as DashboardPlacement }));
  }

  /** The dashboard a person lands on: a custom home made for them, else the built-in one for their role. */
  async home(me: Me, surface: string): Promise<DashboardView> {
    if (surface === 'client') {
      if (me.type !== 'client') throw new ForbiddenException('The client home is for client users');
      return this.viewWithName(me, await this.builtinRow(me.orgId, 'client_home'));
    }
    if (surface !== 'team' && surface !== 'admin') throw new BadRequestException('Pick team, admin or client');
    if (me.type !== 'staff') throw new ForbiddenException('Team dashboards are for the team');
    const placement = surface === 'team' ? 'team_home' : 'admin_home';
    const overrides = (await this.visibleCustom(me))
      .filter((x) => x.d.placement === placement && x.rank >= 0)
      .sort((a, b) => b.rank - a.rank || b.d.updatedAt.getTime() - a.d.updatedAt.getTime());
    if (overrides[0]) return this.viewWithName(me, overrides[0].d);
    const key: DashboardBuiltinKey = surface === 'admin' ? 'command_centre' : isCraftSpecialty(me.specialty) ? 'specialist' : isCraftManager(me) ? 'manager' : 'my_day';
    return this.viewWithName(me, await this.builtinRow(me.orgId, key));
  }

  async builtin(me: Me, key: string): Promise<DashboardView> {
    if (!isDashboardBuiltinKey(key)) throw new NotFoundException('There is no built-in dashboard by that name');
    const def = DASHBOARD_BUILTINS[key];
    if (!canEditDashboards(me) && (def.surface === 'client') !== (me.type === 'client')) throw new ForbiddenException('That dashboard is not part of your app');
    return this.viewWithName(me, await this.builtinRow(me.orgId, key));
  }

  async get(me: Me, id: string): Promise<DashboardView> {
    const d = await this.find(me, id);
    if (!canEditDashboards(me)) {
      if (d.builtin) {
        const def = DASHBOARD_BUILTINS[d.builtin as DashboardBuiltinKey];
        if (!def || (def.surface === 'client') !== (me.type === 'client')) throw new ForbiddenException('That dashboard is not part of your app');
      } else if (me.type !== 'staff' || d.archivedAt || dashboardAudienceRank(this.audienceOf(d), { id: me.id, roles: me.roles, specialty: me.specialty }) < 0) {
        throw new ForbiddenException('This dashboard has not been shared with you');
      }
    }
    return this.viewWithName(me, d);
  }

  // -------------------------------------------------------------------------
  // Writing

  private async checkAudience(me: Me, a: DashboardAudience) {
    const known = new Set<string>(hierarchyData.team_roles.map((r) => r.id));
    const bad = a.roles.find((r) => !known.has(r));
    if (bad) throw new BadRequestException(`"${bad}" is not a team role`);
    if (a.userIds.length) {
      const found = await this.prisma.user.count({ where: { orgId: me.orgId, id: { in: a.userIds }, type: 'staff', deletedAt: null } });
      if (found !== new Set(a.userIds).size) throw new BadRequestException('One of the people picked is no longer in the team');
    }
  }

  private async saveVersion(me: Me, d: Dashboard, note?: string | null) {
    await this.prisma.dashboardVersion.create({
      data: {
        orgId: me.orgId,
        dashboardId: d.id,
        name: d.name,
        placement: d.placement,
        audience: (d.audience ?? {}) as Prisma.InputJsonValue,
        layout: (d.layout ?? []) as Prisma.InputJsonValue,
        note: note ?? null,
        savedById: me.id,
      },
    });
  }

  async create(me: Me, body: unknown, ip?: string): Promise<DashboardView> {
    assertStudio(me);
    const input = parse(dashboardCreateSchema, body);
    await this.checkAudience(me, input.audience);
    let layout: DashboardWidget[];
    if (input.startFrom === 'copy') {
      if (!input.copyFromId) throw new BadRequestException('Pick the dashboard to copy');
      const src = await this.find(me, input.copyFromId);
      if (src.surface === 'client') throw new BadRequestException('The client home cannot be copied into a team dashboard');
      layout = this.layoutOf(src);
    } else {
      const t = DASHBOARD_TEMPLATES[input.startFrom];
      if (!t) throw new BadRequestException('Pick a starting point');
      layout = t.layout;
    }
    const d = await this.prisma.$transaction(async (tx) => {
      const created = await tx.dashboard.create({
        data: {
          orgId: me.orgId,
          key: `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          name: input.name,
          description: input.description || null,
          surface: input.placement === 'admin_home' ? 'admin' : 'team',
          placement: input.placement,
          audience: input.audience as Prisma.InputJsonValue,
          layout: layout as unknown as Prisma.InputJsonValue,
          createdById: me.id,
          updatedById: me.id,
        },
      });
      return tx.dashboard.update({ where: { id: created.id }, data: { key: `custom:${created.id}` } });
    });
    await this.saveVersion(me, d, 'Created');
    await this.audit.log(me, 'dashboard.created', 'dashboard', d.id, null, { name: d.name, placement: d.placement, audience: d.audience, widgets: layout.length }, ip);
    return this.viewWithName(me, d);
  }

  async update(me: Me, id: string, body: unknown, ip?: string): Promise<DashboardView> {
    assertStudio(me);
    const input = parse(dashboardUpdateSchema, body);
    const before = await this.find(me, id);
    if (before.archivedAt) throw new BadRequestException('Restore the dashboard before changing it');
    const data: Prisma.DashboardUpdateInput = { updatedById: me.id };
    if (before.builtin) {
      if (input.audience || input.placement) throw new BadRequestException('Who sees a built-in dashboard is fixed. Make a new dashboard to show different people something else.');
      if (input.name && input.name !== before.name) throw new BadRequestException('Built-in dashboards keep their name');
    } else {
      if (input.name !== undefined) data.name = input.name;
      if (input.description !== undefined) data.description = input.description || null;
      if (input.placement) {
        data.placement = input.placement;
        data.surface = input.placement === 'admin_home' ? 'admin' : 'team';
      }
      if (input.audience) {
        await this.checkAudience(me, input.audience);
        data.audience = input.audience as Prisma.InputJsonValue;
      }
    }
    if (input.layout) {
      const surface = (data.surface as string | undefined) ?? before.surface;
      const problem = dashboardLayoutProblem(input.layout, surface as DashboardSurface);
      if (problem) throw new BadRequestException(problem);
      if (!before.builtin && input.layout.some((w) => w.type === 'section' && DASHBOARD_BUILTINS[w.dashboard].surface === 'client')) throw new BadRequestException('Client home sections only work in the client portal');
      const reportIds = input.layout.flatMap((w) => (w.type === 'report' ? [w.reportId] : []));
      if (reportIds.length) {
        const shared = await this.prisma.savedReport.count({ where: { orgId: me.orgId, id: { in: reportIds }, OR: [{ shared: true }, { userId: me.id }] } });
        if (shared !== new Set(reportIds).size) throw new BadRequestException('A saved report on this dashboard was deleted or is not shared. Share it in the Report Builder first.');
        await this.prisma.savedReport.updateMany({ where: { orgId: me.orgId, id: { in: reportIds }, userId: me.id }, data: { shared: true } });
      }
      data.layout = input.layout as unknown as Prisma.InputJsonValue;
    }
    const d = await this.prisma.dashboard.update({ where: { id }, data });
    await this.saveVersion(me, d, input.note);
    await this.audit.log(
      me,
      'dashboard.updated',
      'dashboard',
      id,
      { name: before.name, placement: before.placement, audience: before.audience, widgets: this.layoutOf(before).length },
      { name: d.name, placement: d.placement, audience: d.audience, widgets: this.layoutOf(d).length, note: input.note ?? null },
      ip,
    );
    return this.viewWithName(me, d);
  }

  async duplicate(me: Me, id: string, ip?: string): Promise<DashboardView> {
    assertStudio(me);
    const src = await this.find(me, id);
    if (src.surface === 'client') throw new BadRequestException('The client home cannot be copied into a team dashboard');
    return this.create(me, { name: `Copy of ${src.name}`.slice(0, 80), description: src.description ?? undefined, placement: 'menu', audience: src.builtin ? EMPTY_AUDIENCE : this.audienceOf(src), startFrom: 'copy', copyFromId: src.id }, ip);
  }

  async archive(me: Me, id: string, body: unknown, ip?: string): Promise<DashboardView> {
    assertStudio(me);
    const { reason } = parse(dashboardArchiveSchema, body);
    const d = await this.find(me, id);
    if (d.builtin) throw new BadRequestException('Built-in dashboards cannot be archived. Use "Reset to original" or hide sections instead.');
    if (d.archivedAt) return this.viewWithName(me, d);
    const out = await this.prisma.dashboard.update({ where: { id }, data: { archivedAt: new Date(), archivedReason: reason, updatedById: me.id } });
    await this.audit.log(me, 'dashboard.archived', 'dashboard', id, null, { reason }, ip);
    return this.viewWithName(me, out);
  }

  async restore(me: Me, id: string, ip?: string): Promise<DashboardView> {
    assertStudio(me);
    const d = await this.find(me, id);
    const out = await this.prisma.dashboard.update({ where: { id }, data: { archivedAt: null, archivedReason: null, updatedById: me.id } });
    if (d.archivedAt) await this.audit.log(me, 'dashboard.restored', 'dashboard', id, null, null, ip);
    return this.viewWithName(me, out);
  }

  async reset(me: Me, id: string, ip?: string): Promise<DashboardView> {
    assertStudio(me);
    const d = await this.find(me, id);
    if (!d.builtin || !isDashboardBuiltinKey(d.builtin)) throw new BadRequestException('Only built-in dashboards have an original layout');
    const out = await this.prisma.dashboard.update({ where: { id }, data: { layout: dashboardDefaultLayout(d.builtin) as unknown as Prisma.InputJsonValue, updatedById: me.id } });
    await this.saveVersion(me, out, 'Reset to original');
    await this.audit.log(me, 'dashboard.reset', 'dashboard', id, { widgets: this.layoutOf(d).length }, { widgets: this.layoutOf(out).length }, ip);
    return this.viewWithName(me, out);
  }

  async versions(me: Me, id: string): Promise<DashboardVersionRow[]> {
    assertStudio(me);
    await this.find(me, id);
    const rows = await this.prisma.dashboardVersion.findMany({ where: { dashboardId: id, orgId: me.orgId }, orderBy: { savedAt: 'desc' }, take: 50 });
    const names = await this.names(me.orgId, rows.map((r) => r.savedById));
    return rows.map((v, i) => ({
      id: v.id,
      savedAt: v.savedAt.toISOString(),
      savedBy: v.savedById ? (names.get(v.savedById) ?? null) : null,
      note: v.note,
      widgets: Array.isArray(v.layout) ? v.layout.length : 0,
      name: v.name,
      current: i === 0,
    }));
  }

  async restoreVersion(me: Me, id: string, versionId: string, ip?: string): Promise<DashboardView> {
    assertStudio(me);
    const d = await this.find(me, id);
    const v = await this.prisma.dashboardVersion.findFirst({ where: { id: versionId, dashboardId: id, orgId: me.orgId } });
    if (!v) throw new NotFoundException('That version no longer exists');
    const when = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(v.savedAt);
    const layout = this.layoutOf({ layout: v.layout, surface: d.surface });
    return this.update(
      me,
      id,
      d.builtin
        ? { layout, note: `Restored the version from ${when}` }
        : { name: v.name, placement: v.placement, audience: v.audience, layout, note: `Restored the version from ${when}` },
      ip,
    );
  }
}
