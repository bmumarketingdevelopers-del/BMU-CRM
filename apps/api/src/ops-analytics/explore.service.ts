import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  OPS_METRICS,
  opsDimensionLabels,
  opsExploreSchema,
  opsMetricInfo,
  opsSaveReportSchema,
  opsUpdateReportSchema,
  requestTypeLabels,
  type Me,
  type OpsDimension,
  type OpsExploreConfig,
  type OpsExploreResult,
  type OpsReportsList,
  type OpsSavedReport,
  type RequestType,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { calendarFor } from '../production/generate.js';
import { canReadCommand, canSeeMoney } from '../insights/access.js';
import { isBillable, loadLedger } from '../insights/ledger.js';
import { parse } from '../common/zod.js';
import { OpsTeamService } from './team.service.js';
import { slaOutcome } from './sla.service.js';
import { assertOpsReader, buckets, inRange, limitedToOwnDepartment, outRange, parseRange, round1, type Range } from './common.js';

type Key = { key: string; label: string };
/** One measured thing: when it happened, its value (num/den for rates) and what it can be grouped by. */
type Fact = { at: Date; num: number; den: number; dims: Partial<Record<OpsDimension, Key | Key[]>> };

const k = (key: string | null | undefined, label: string | null | undefined): Key => (key ? { key, label: label ?? key } : { key: '_none', label: 'Not set' });
const sourceLabel = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

@Injectable()
export class OpsExploreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly team: OpsTeamService,
  ) {}

  private assertMetricAllowed(me: Me, config: OpsExploreConfig) {
    if (opsMetricInfo[config.metric].money && !canSeeMoney(me)) throw new ForbiddenException('Money reports are for the Founder, Admin and Finance');
  }

  async explore(me: Me, body: unknown): Promise<OpsExploreResult> {
    assertOpsReader(me);
    return this.run(me, body, false);
  }

  /**
   * v12 dashboards: Command Centre readers get the same numbers as the Report Builder; everyone else in the team
   * gets their own numbers only (facts where they are the person), so a dashboard can be shared with anyone.
   */
  async exploreForDashboard(me: Me, body: unknown): Promise<OpsExploreResult & { ownOnly: boolean }> {
    if (me.type !== 'staff') throw new ForbiddenException('For BMU team members only');
    const ownOnly = !canReadCommand(me);
    return { ...(await this.run(me, body, ownOnly)), ownOnly };
  }

  private async run(me: Me, body: unknown, ownOnly: boolean): Promise<OpsExploreResult> {
    const raw = (body ?? {}) as { metric?: unknown };
    if (raw.metric !== undefined && !(OPS_METRICS as readonly unknown[]).includes(raw.metric)) throw new BadRequestException('Pick a metric from the list');
    const config = parse(opsExploreSchema, body);
    this.assertMetricAllowed(me, config);
    const info = opsMetricInfo[config.metric];
    if (ownOnly && !info.dimensions.includes('person')) throw new ForbiddenException(`${info.label} is shown to the Command Centre team only`);
    const r = parseRange(config.from, config.to);
    const all = await this.facts(me, config.metric, r);
    const mine = (f: Fact) => {
      const p = f.dims.person;
      return Array.isArray(p) ? p.some((x) => x.key === me.id) : p?.key === me.id;
    };
    const facts = ownOnly ? all.filter(mine) : all;
    const isRate = info.unit === 'pct';
    const value = (num: number, den: number) => (isRate ? (den ? round1((num / den) * 100) : 0) : info.unit === 'count' ? num : round1(num));

    const cur = facts.filter((f) => inRange(f.at, r.from, r.to));
    const prev = facts.filter((f) => inRange(f.at, r.prevFrom, r.prevTo));
    const total = (xs: Fact[]) => {
      if (!xs.length) return isRate ? null : 0;
      const num = xs.reduce((s, f) => s + f.num, 0);
      const den = xs.reduce((s, f) => s + f.den, 0);
      return isRate && !den ? null : value(num, den);
    };

    let rows: OpsExploreResult['rows'];
    if (config.dimension === 'month' || config.dimension === 'week') {
      const bs = buckets(r, config.dimension);
      rows = bs.map((b) => {
        const xs = cur.filter((f) => f.at >= b.start && f.at < b.end);
        const num = xs.reduce((s, f) => s + f.num, 0);
        const den = xs.reduce((s, f) => s + f.den, 0);
        return { key: b.start.toISOString(), label: b.label, value: value(num, den), count: den };
      });
    } else {
      const groups = new Map<string, { label: string; num: number; den: number }>();
      for (const f of cur) {
        const d = f.dims[config.dimension];
        const keys = Array.isArray(d) ? (d.length ? d : [k(null, null)]) : [d ?? k(null, null)];
        for (const key of keys) {
          const g = groups.get(key.key) ?? { label: key.label, num: 0, den: 0 };
          g.num += f.num;
          g.den += f.den;
          groups.set(key.key, g);
        }
      }
      rows = [...groups.entries()]
        .map(([key, g]) => ({ key, label: g.label, value: value(g.num, g.den), count: g.den, href: config.dimension === 'client' && key !== '_none' ? `/team/clients/${key}` : undefined }))
        .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    }
    return {
      config,
      metricLabel: info.label,
      dimensionLabel: opsDimensionLabels[config.dimension],
      unit: info.unit,
      rows,
      total: total(cur),
      prevTotal: total(prev),
      range: outRange(r),
    };
  }

  // -------------------------------------------------------------------------
  // Facts per metric, for [prevFrom, to)

  private async facts(me: Me, metric: OpsExploreConfig['metric'], r: Range): Promise<Fact[]> {
    const orgId = me.orgId;
    const between = { gte: r.prevFrom, lt: r.to };
    const services = await this.prisma.service.findMany({ where: { orgId }, select: { id: true, key: true, name: true } });
    const serviceByKey = new Map(services.map((s) => [s.key, s.name]));
    const engagementDims = async (ids: (string | null | undefined)[]) => {
      const list = [...new Set(ids.filter((x): x is string => !!x))];
      const rows = list.length
        ? await this.prisma.engagement.findMany({
            where: { id: { in: list } },
            select: { id: true, service: { select: { id: true, name: true } }, clientOrg: { select: { id: true, name: true } }, am: { select: { id: true, name: true } } },
          })
        : [];
      return new Map(rows.map((e) => [e.id, { service: k(e.service.id, e.service.name), client: k(e.clientOrg.id, e.clientOrg.name), am: k(e.am?.id, e.am?.name) }]));
    };
    const dept = limitedToOwnDepartment(me) ? await this.team.ownDepartment(me) : null;

    switch (metric) {
      case 'revenue_raised': {
        const ledger = await loadLedger(this.prisma, orgId, { createdAt: between });
        const notes = await this.prisma.creditNote.findMany({ where: { orgId, createdAt: between }, select: { createdAt: true, amountPaise: true, invoiceId: true } });
        const noteInv = await this.prisma.invoice.findMany({ where: { id: { in: notes.map((n) => n.invoiceId) } }, select: { id: true, engagementId: true, clientOrg: { select: { id: true, name: true } } } });
        const eng = await engagementDims([...ledger.map((i) => i.engagementId), ...noteInv.map((i) => i.engagementId)]);
        const invById = new Map(noteInv.map((i) => [i.id, i]));
        return [
          ...ledger.filter(isBillable).map((i) => ({
            at: i.createdAt,
            num: i.subtotalPaise,
            den: 1,
            dims: { service: i.engagementId ? eng.get(i.engagementId)?.service : k('_addon', i.kind === 'addon' ? 'Add-ons' : 'Not linked to a service'), client: k(i.clientOrg?.id, i.clientOrg?.name) },
          })),
          ...notes.map((n) => {
            const inv = invById.get(n.invoiceId);
            return { at: n.createdAt, num: -n.amountPaise, den: 0, dims: { service: inv?.engagementId ? eng.get(inv.engagementId)?.service : k(null, null), client: k(inv?.clientOrg?.id, inv?.clientOrg?.name) } };
          }),
        ];
      }
      case 'revenue_collected': {
        const pays = await this.prisma.payment.findMany({ where: { orgId, at: between }, select: { at: true, amountPaise: true, invoice: { select: { kind: true, engagementId: true, clientOrg: { select: { id: true, name: true } } } } } });
        const eng = await engagementDims(pays.map((p) => p.invoice.engagementId));
        return pays.map((p) => ({
          at: p.at,
          num: p.amountPaise,
          den: 1,
          dims: { service: p.invoice.engagementId ? eng.get(p.invoice.engagementId)?.service : k('_addon', p.invoice.kind === 'addon' ? 'Add-ons' : 'Not linked to a service'), client: k(p.invoice.clientOrg?.id, p.invoice.clientOrg?.name) },
        }));
      }
      case 'leads': {
        const leads = await this.prisma.lead.findMany({ where: { orgId, deletedAt: null, createdAt: between }, select: { createdAt: true, source: true, serviceIds: true, owner: { select: { id: true, name: true } } } });
        return leads.map((l) => ({
          at: l.createdAt,
          num: 1,
          den: 1,
          dims: { service: l.serviceIds.map((s) => k(s, serviceByKey.get(s) ?? s)), person: k(l.owner?.id, l.owner?.name), lead_source: k(l.source, sourceLabel(l.source)) },
        }));
      }
      case 'proposals_sent':
      case 'proposals_won': {
        const field = metric === 'proposals_sent' ? 'sentAt' : 'acceptedAt';
        const props = await this.prisma.proposal.findMany({
          where: { orgId, deletedAt: null, [field]: between, ...(metric === 'proposals_won' ? { status: 'accepted' } : {}) },
          select: { sentAt: true, acceptedAt: true, createdById: true, lead: { select: { source: true } } },
        });
        const people = await this.prisma.user.findMany({ where: { id: { in: props.map((p) => p.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
        const name = new Map(people.map((p) => [p.id, p.name]));
        return props.map((p) => ({
          at: (metric === 'proposals_sent' ? p.sentAt : p.acceptedAt)!,
          num: 1,
          den: 1,
          dims: { person: k(p.createdById, p.createdById ? name.get(p.createdById) : null), lead_source: k(p.lead.source, sourceLabel(p.lead.source)) },
        }));
      }
      case 'tasks_completed':
      case 'hours_logged': {
        const tasks = await this.prisma.task.findMany({
          where: { orgId, status: 'done', completedAt: between, ...(dept ? { OR: [{ departmentId: dept }, { owner: { departmentId: dept } }] } : {}) },
          select: { completedAt: true, timeLoggedMin: true, departmentId: true, engagementId: true, owner: { select: { id: true, name: true, departmentId: true } }, deliverable: { select: { cycle: { select: { engagementId: true } } } } },
        });
        const depts = await this.prisma.department.findMany({ where: { orgId }, select: { id: true, name: true } });
        const deptName = new Map(depts.map((d) => [d.id, d.name]));
        const engId = (t: (typeof tasks)[number]) => t.engagementId ?? t.deliverable?.cycle.engagementId ?? null;
        const eng = await engagementDims(tasks.map(engId));
        return tasks.map((t) => {
          const e = engId(t) ? eng.get(engId(t)!) : undefined;
          const d = t.departmentId ?? t.owner?.departmentId ?? null;
          return {
            at: t.completedAt!,
            num: metric === 'tasks_completed' ? 1 : t.timeLoggedMin / 60,
            den: 1,
            dims: { department: k(d, d ? deptName.get(d) : null), person: k(t.owner?.id, t.owner?.name), client: e?.client ?? k(null, 'Internal work'), service: e?.service ?? k(null, 'Internal work') },
          };
        });
      }
      case 'requests':
      case 'sla_breaches': {
        const reqs = await this.prisma.request.findMany({ where: { orgId, createdAt: between }, select: { createdAt: true, type: true, slaDue: true, firstReplyAt: true, engagementId: true } });
        const eng = await engagementDims(reqs.map((x) => x.engagementId));
        let list = reqs;
        if (metric === 'sla_breaches') {
          const [cal, sla] = await Promise.all([calendarFor(this.prisma, orgId), this.settings.get(orgId, 'sla')]);
          const now = new Date();
          list = reqs.filter((x) => slaOutcome(x, (sla.firstReplyMinutes as Record<string, number>)[x.type] ?? 540, cal, now).breached === true);
        }
        return list.map((x) => {
          const e = eng.get(x.engagementId);
          return { at: x.createdAt, num: 1, den: 1, dims: { service: e?.service, client: e?.client, person: e?.am, request_type: k(x.type, requestTypeLabels[x.type as RequestType]?.team ?? x.type) } };
        });
      }
      case 'qc_pass_rate': {
        const qc = await this.prisma.qCResult.findMany({
          where: { orgId, createdAt: between, ...(dept ? { version: { deliverable: { departmentId: dept } } } : {}) },
          select: { createdAt: true, result: true, version: { select: { uploadedById: true, deliverable: { select: { departmentId: true, cycle: { select: { engagementId: true } } } } } } },
        });
        const [depts, people] = await Promise.all([
          this.prisma.department.findMany({ where: { orgId }, select: { id: true, name: true } }),
          this.prisma.user.findMany({ where: { id: { in: [...new Set(qc.map((q) => q.version.uploadedById))] } }, select: { id: true, name: true } }),
        ]);
        const deptName = new Map(depts.map((d) => [d.id, d.name]));
        const personName = new Map(people.map((p) => [p.id, p.name]));
        const eng = await engagementDims(qc.map((q) => q.version.deliverable.cycle.engagementId));
        return qc.map((q) => {
          const e = eng.get(q.version.deliverable.cycle.engagementId);
          const d = q.version.deliverable.departmentId;
          return {
            at: q.createdAt,
            num: q.result === 'pass' ? 1 : 0,
            den: 1,
            dims: { department: k(d, d ? deptName.get(d) : null), person: k(q.version.uploadedById, personName.get(q.version.uploadedById)), service: e?.service, client: e?.client },
          };
        });
      }
      case 'new_clients': {
        const clients = await this.prisma.clientOrg.findMany({
          where: { orgId, deletedAt: null, createdAt: between },
          select: { createdAt: true, leadId: true, am: { select: { id: true, name: true } }, engagements: { select: { service: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' }, take: 1 } },
        });
        const leads = await this.prisma.lead.findMany({ where: { id: { in: clients.map((c) => c.leadId).filter((x): x is string => !!x) } }, select: { id: true, source: true } });
        const source = new Map(leads.map((l) => [l.id, l.source]));
        return clients.map((c) => {
          const s = c.leadId ? source.get(c.leadId) : undefined;
          const svc = c.engagements[0]?.service;
          return { at: c.createdAt, num: 1, den: 1, dims: { person: k(c.am?.id, c.am?.name), service: k(svc?.id, svc?.name), lead_source: k(s, s ? sourceLabel(s) : 'Direct / no lead') } };
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Saved reports

  private view(row: { id: string; name: string; config: unknown; pinned: boolean; shared: boolean; userId: string; updatedAt: Date }, me: Me, owner: string): OpsSavedReport | null {
    const cfg = opsExploreSchema.safeParse(row.config);
    if (!cfg.success) return null;
    return { id: row.id, name: row.name, config: cfg.data, pinned: row.pinned, shared: row.shared, owner, mine: row.userId === me.id, updatedAt: row.updatedAt.toISOString() };
  }

  async reports(me: Me): Promise<OpsReportsList> {
    assertOpsReader(me);
    const money = canSeeMoney(me);
    const rows = await this.prisma.savedReport.findMany({ where: { orgId: me.orgId, OR: [{ userId: me.id }, { shared: true }] }, orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }] });
    const owners = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true } });
    const name = new Map(owners.map((o) => [o.id, o.name]));
    const all = rows.map((r) => this.view(r, me, name.get(r.userId) ?? 'Someone')).filter((r): r is OpsSavedReport => !!r && (money || !opsMetricInfo[r.config.metric].money));
    return { mine: all.filter((r) => r.mine), shared: all.filter((r) => !r.mine), canSeeMoney: money };
  }

  private async loadVisible(me: Me, id: string) {
    const row = await this.prisma.savedReport.findFirst({ where: { id, orgId: me.orgId, OR: [{ userId: me.id }, { shared: true }] } });
    if (!row) throw new NotFoundException('Report not found');
    return row;
  }

  async report(me: Me, id: string) {
    assertOpsReader(me);
    const row = await this.loadVisible(me, id);
    const v = this.view(row, me, '');
    if (!v) throw new NotFoundException('Report not found');
    if (opsMetricInfo[v.config.metric].money && !canSeeMoney(me)) throw new ForbiddenException('Money reports are for the Founder, Admin and Finance');
    const owner = await this.prisma.user.findUnique({ where: { id: row.userId }, select: { name: true } });
    return { ...v, owner: owner?.name ?? 'Someone' };
  }

  async create(me: Me, body: unknown, ip?: string) {
    assertOpsReader(me);
    const input = parse(opsSaveReportSchema, body);
    this.assertMetricAllowed(me, input.config);
    const row = await this.prisma.savedReport.create({ data: { orgId: me.orgId, userId: me.id, name: input.name, config: input.config, pinned: input.pinned ?? false, shared: input.shared ?? false } });
    await this.audit.log(me, 'report.saved', 'SavedReport', row.id, null, { name: row.name, config: input.config, pinned: row.pinned, shared: row.shared }, ip);
    return this.view(row, me, me.name)!;
  }

  async update(me: Me, id: string, body: unknown, ip?: string) {
    assertOpsReader(me);
    const input = parse(opsUpdateReportSchema, body);
    const row = await this.loadVisible(me, id);
    if (row.userId !== me.id) throw new ForbiddenException('Only the person who saved this report can change it');
    if (input.config) this.assertMetricAllowed(me, input.config);
    const next = await this.prisma.savedReport.update({ where: { id }, data: { name: input.name, config: input.config, pinned: input.pinned, shared: input.shared } });
    await this.audit.log(me, 'report.updated', 'SavedReport', id, { name: row.name, pinned: row.pinned, shared: row.shared, config: row.config }, { name: next.name, pinned: next.pinned, shared: next.shared, config: next.config }, ip);
    return this.view(next, me, me.name)!;
  }

  async remove(me: Me, id: string, ip?: string) {
    assertOpsReader(me);
    const row = await this.loadVisible(me, id);
    if (row.userId !== me.id) throw new ForbiddenException('Only the person who saved this report can delete it');
    await this.prisma.savedReport.delete({ where: { id } });
    await this.audit.log(me, 'report.deleted', 'SavedReport', id, { name: row.name, config: row.config }, null, ip);
    return { ok: true as const };
  }
}
