import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DASHBOARD_LIST_SOURCES,
  dashboardListInfo,
  dashboardPeriodRange,
  opsExploreSchema,
  requestTypeLabels,
  type DashboardListResult,
  type DashboardListRow,
  type DashboardFieldBreakdown,
  type DashboardListSource,
  customFieldDisplay,
  customFieldEntityLabels,
  type CustomFieldEntity,
  type Me,
  type OpsExploreResult,
  type RequestType,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { canReadCommand, canReadFinance, seesAllDepartments } from '../insights/access.js';
import { OpsExploreService } from '../ops-analytics/explore.service.js';
import { seesAllClients } from '../clients-actions/clients-access.js';
import { visibleEngagementWhere } from '../engagements/engagement-access.js';
import { isCustomEntity } from '../customise/custom-fields.service.js';

const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
const OPEN_REQUEST = ['received', 'scope_check', 'in_scope', 'quoted', 'approved', 'paid', 'in_progress', 'rescheduled'] as const;
const REQUEST_LEADERS = ['founder', 'admin', 'am_lead', 'finance', 'department_head'];
const DAY = 86_400_000;

const day = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const inr = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
/** End of today in IST. */
const endOfToday = () => {
  const ist = new Date(Date.now() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) - 330 * 60_000);
};

/** Data for dashboard widgets, always scoped to the person looking at the dashboard. */
@Injectable()
export class DashboardDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly explorer: OpsExploreService,
  ) {}

  explore(me: Me, body: unknown): Promise<OpsExploreResult & { ownOnly: boolean }> {
    return this.explorer.exploreForDashboard(me, body);
  }

  /** A saved report, re-run for today's dates when it was saved with a rolling period. */
  async report(me: Me, id: string): Promise<OpsExploreResult & { ownOnly: boolean; name: string }> {
    if (me.type !== 'staff') throw new ForbiddenException('For BMU team members only');
    const r = await this.prisma.savedReport.findFirst({ where: { id, orgId: me.orgId, OR: [{ shared: true }, { userId: me.id }] } });
    if (!r) throw new NotFoundException('This saved report was deleted or is no longer shared');
    const parsed = opsExploreSchema.safeParse(r.config);
    if (!parsed.success) throw new BadRequestException('This saved report needs to be opened and saved again in the Report Builder');
    const config = { ...parsed.data };
    const rolling: Record<string, () => { from: string; to: string }> = {
      '30d': () => dashboardPeriodRange('last_30'),
      '90d': () => dashboardPeriodRange('last_90'),
      fy: () => dashboardPeriodRange('this_fy'),
      '6m': () => this.monthsBack(6),
      '12m': () => this.monthsBack(12),
    };
    if (config.preset && rolling[config.preset]) Object.assign(config, rolling[config.preset]());
    return { ...(await this.explore(me, config)), name: r.name };
  }

  private monthsBack(n: number) {
    const { to } = dashboardPeriodRange('last_7');
    const [y, m, d] = to.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1 - n, d));
    return { from: from.toISOString().slice(0, 10), to };
  }

  async list(me: Me, sourceRaw: string, limitRaw?: string): Promise<DashboardListResult> {
    if (me.type !== 'staff') throw new ForbiddenException('For BMU team members only');
    if (!(DASHBOARD_LIST_SOURCES as readonly string[]).includes(sourceRaw)) throw new BadRequestException('Pick a list from the library');
    const source = sourceRaw as DashboardListSource;
    const limit = Math.min(20, Math.max(3, Number(limitRaw) || 6));
    const info = dashboardListInfo[source];
    const { rows, total } = await this.rows(me, source, limit);
    return { source, label: info.label, href: info.href, rows, total };
  }

  /** v14: how many of the viewer's records have each value of a custom field. */
  async fieldBreakdown(me: Me, entity: string, field: string, scope: 'open' | 'all'): Promise<DashboardFieldBreakdown> {
    if (me.type !== 'staff') throw new ForbiddenException('For BMU team members only');
    if (!isCustomEntity(entity)) throw new BadRequestException('Unknown record type');
    const def = await this.prisma.customFieldDef.findFirst({ where: { orgId: me.orgId, entity, key: field } });
    if (!def) throw new NotFoundException('This custom field was deleted');
    const orgId = me.orgId;
    const select = { customFields: true } as const;
    const take = 5000;
    let rows: { customFields: unknown }[];
    switch (entity as CustomFieldEntity) {
      case 'lead':
        rows = await this.prisma.lead.findMany({ where: { AND: [{ orgId, deletedAt: null, archivedAt: null }, this.leadScope(me), scope === 'open' ? { stage: { notIn: ['won', 'lost'] } } : {}] }, select, take });
        break;
      case 'client':
        rows = await this.prisma.clientOrg.findMany({ where: { orgId, deletedAt: null, ...(scope === 'open' ? { archivedAt: null } : {}), ...(seesAllClients(me) ? {} : { amUserId: me.id }) }, select, take });
        break;
      case 'engagement':
        rows = await this.prisma.engagement.findMany({ where: { AND: [await visibleEngagementWhere(this.prisma, me), scope === 'open' ? { status: { not: 'closed' }, archivedAt: null } : {}] }, select, take });
        break;
      case 'request':
        rows = await this.prisma.request.findMany({ where: { AND: [{ orgId }, this.requestScope(me), scope === 'open' ? { status: { in: [...OPEN_REQUEST] } } : {}] }, select, take });
        break;
      default:
        rows = await this.prisma.creator.findMany({ where: { orgId }, select, take });
    }
    const counts = new Map<string, number>();
    let empty = 0;
    for (const r of rows) {
      const v = ((r.customFields ?? {}) as Record<string, unknown>)[def.key];
      if (v === undefined || v === null || v === '') {
        empty++;
        continue;
      }
      const key = def.type === 'checkbox' ? (v ? 'yes' : 'no') : String(v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const options = Array.isArray(def.options) ? (def.options as string[]) : [];
    const order = def.type === 'select' ? options : def.type === 'checkbox' ? ['yes', 'no'] : [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
    const keys = [...new Set([...order.filter((k) => def.type !== 'select' || counts.has(k) || options.includes(k)), ...counts.keys()])].slice(0, 12);
    return {
      entity: entity as CustomFieldEntity,
      field: def.key,
      label: `${customFieldEntityLabels[entity as CustomFieldEntity].many} by ${def.label.toLowerCase()}`,
      type: def.type,
      rows: keys.map((k) => ({
        value: k,
        label: def.type === 'checkbox' ? (k === 'yes' ? 'Yes' : 'No') : customFieldDisplay(def, def.type === 'number' || def.type === 'money' ? Number(k) : k),
        count: counts.get(k) ?? 0,
        href: entity === 'lead' ? `/team/leads?cf.${def.key}=${encodeURIComponent(k)}` : null,
      })),
      total: rows.length,
      empty,
    };
  }

  private async taskScope(me: Me): Promise<Prisma.TaskWhereInput> {
    if (canReadCommand(me)) {
      if (me.roles.includes('department_head') && !seesAllDepartments(me)) {
        const self = await this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } });
        const headed = await this.prisma.department.findFirst({ where: { orgId: me.orgId, headUserId: me.id, deletedAt: null }, select: { id: true } });
        const dept = self?.departmentId ?? headed?.id ?? '__none__';
        return { OR: [{ departmentId: dept }, { owner: { departmentId: dept } }, { ownerId: me.id }] };
      }
      return {};
    }
    if (me.roles.includes('account_manager')) {
      const mine = await this.prisma.engagement.findMany({ where: { orgId: me.orgId, amId: me.id, deletedAt: null }, select: { id: true } });
      return { OR: [{ ownerId: me.id }, { engagementId: { in: mine.map((e) => e.id) } }] };
    }
    return { ownerId: me.id };
  }

  private requestScope(me: Me): Prisma.RequestWhereInput {
    if (me.roles.some((r) => REQUEST_LEADERS.includes(r))) return {};
    if (me.roles.includes('account_manager')) return { OR: [{ assigneeId: me.id }, { engagement: { amId: me.id } }] };
    return { assigneeId: me.id };
  }

  private leadScope(me: Me): Prisma.LeadWhereInput {
    const scope = me.permissions.leads_pipeline?.scope ?? 'none';
    if (scope === 'none') throw new ForbiddenException('Leads are for the sales team');
    return scope === 'all' ? {} : { ownerId: me.id };
  }

  private async rows(me: Me, source: DashboardListSource, limit: number): Promise<{ rows: DashboardListRow[]; total: number }> {
    const orgId = me.orgId;
    const now = new Date();
    const clientOf = new Map<string, string>();
    const taskRow = (t: { id: string; title: string; deadline: Date | null; status: string; blockedReason: string | null; owner: { name: string } | null; engagementId: string | null }): DashboardListRow => ({
      id: t.id,
      title: t.title,
      meta: [(t.engagementId && clientOf.get(t.engagementId)) || 'Internal', t.owner?.name, source === 'blocked_tasks' ? t.blockedReason || 'No reason given' : t.deadline ? `due ${day.format(t.deadline)}` : 'no deadline'].filter(Boolean).join(' · '),
      href: `/team/tasks/${t.id}`,
      badge: t.status === 'blocked' ? { label: 'Blocked', tone: 'red' } : t.deadline && t.deadline < now ? { label: 'Late', tone: 'red' } : t.deadline && t.deadline < endOfToday() ? { label: 'Today', tone: 'amber' } : undefined,
    });
    const taskSelect = { id: true, title: true, deadline: true, status: true, blockedReason: true, engagementId: true, owner: { select: { name: true } } } as const;

    switch (source) {
      case 'my_tasks':
      case 'due_this_week':
      case 'overdue_tasks':
      case 'blocked_tasks': {
        const base: Prisma.TaskWhereInput = { orgId, archivedAt: null, isDraft: false, status: { in: [...OPEN_TASK] } };
        const scope = source === 'my_tasks' ? { ownerId: me.id } : await this.taskScope(me);
        const extra: Prisma.TaskWhereInput =
          source === 'due_this_week' ? { deadline: { gte: now, lt: new Date(endOfToday().getTime() + 6 * DAY) } } : source === 'overdue_tasks' ? { deadline: { lt: now } } : source === 'blocked_tasks' ? { status: 'blocked' } : {};
        const where: Prisma.TaskWhereInput = { AND: [base, scope, extra] };
        const [rows, total] = await Promise.all([
          this.prisma.task.findMany({ where, select: taskSelect, orderBy: [{ deadline: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }], take: limit }),
          this.prisma.task.count({ where }),
        ]);
        const engIds = [...new Set(rows.map((t) => t.engagementId).filter((x): x is string => !!x))];
        if (engIds.length) for (const e of await this.prisma.engagement.findMany({ where: { id: { in: engIds } }, select: { id: true, clientOrg: { select: { name: true } } } })) clientOf.set(e.id, e.clientOrg.name);
        return { rows: rows.map(taskRow), total };
      }
      case 'open_requests':
      case 'late_requests': {
        const where: Prisma.RequestWhereInput = {
          AND: [{ orgId, status: { in: [...OPEN_REQUEST] } }, this.requestScope(me), source === 'late_requests' ? { slaDue: { lt: now }, firstReplyAt: null } : {}],
        };
        const [rows, total] = await Promise.all([
          this.prisma.request.findMany({ where, select: { id: true, type: true, description: true, slaDue: true, firstReplyAt: true, engagement: { select: { clientOrg: { select: { name: true } } } } }, orderBy: [{ slaDue: { sort: 'asc', nulls: 'last' } }], take: limit }),
          this.prisma.request.count({ where }),
        ]);
        return {
          total,
          rows: rows.map((r) => ({
            id: r.id,
            title: r.description.length > 90 ? `${r.description.slice(0, 89)}…` : r.description,
            meta: [r.engagement.clientOrg.name, requestTypeLabels[r.type as RequestType]?.team ?? r.type, r.slaDue ? `reply due ${day.format(r.slaDue)}` : null].filter(Boolean).join(' · '),
            href: `/team/requests/${r.id}`,
            badge: !r.firstReplyAt && r.slaDue && r.slaDue < now ? { label: 'Late reply', tone: 'red' } : undefined,
          })),
        };
      }
      case 'new_leads':
      case 'follow_ups_due': {
        const where: Prisma.LeadWhereInput = {
          AND: [{ orgId, deletedAt: null, archivedAt: null }, this.leadScope(me), source === 'new_leads' ? { stage: 'new' } : { stage: { notIn: ['won', 'lost'] }, nextFollowUpAt: { lt: endOfToday() } }],
        };
        const [rows, total] = await Promise.all([
          this.prisma.lead.findMany({ where, select: { id: true, contact: true, need: true, source: true, createdAt: true, nextFollowUpAt: true, owner: { select: { name: true } } }, orderBy: source === 'new_leads' ? { createdAt: 'desc' } : { nextFollowUpAt: 'asc' }, take: limit }),
          this.prisma.lead.count({ where }),
        ]);
        return {
          total,
          rows: rows.map((l) => {
            const c = (l.contact ?? {}) as { name?: string; company?: string };
            return {
              id: l.id,
              title: [c.name, c.company].filter(Boolean).join(' · ') || 'Lead',
              meta: [l.need.slice(0, 60), l.owner?.name ?? 'No owner', source === 'new_leads' ? `came in ${day.format(l.createdAt)}` : l.nextFollowUpAt ? `follow up ${day.format(l.nextFollowUpAt)}` : null].filter(Boolean).join(' · '),
              href: `/team/leads/${l.id}`,
              badge: source === 'follow_ups_due' && l.nextFollowUpAt && l.nextFollowUpAt < now ? { label: 'Overdue', tone: 'amber' } : undefined,
            };
          }),
        };
      }
      case 'overdue_invoices': {
        if (!canReadFinance(me)) throw new ForbiddenException('Invoices are for the Founder, Admin and Finance');
        const open = await this.prisma.invoice.findMany({
          where: { orgId, status: { in: ['issued', 'partially_paid', 'overdue'] }, dueDate: { lt: now } },
          select: { id: true, number: true, totalPaise: true, dueDate: true, clientOrg: { select: { name: true } }, payments: { select: { amountPaise: true } } },
          orderBy: { dueDate: 'asc' },
        });
        const due = open.map((i) => ({ ...i, balance: i.totalPaise - i.payments.reduce((s, p) => s + p.amountPaise, 0) })).filter((i) => i.balance > 0);
        return {
          total: due.length,
          rows: due.slice(0, limit).map((i) => ({
            id: i.id,
            title: i.clientOrg?.name ?? 'Client',
            meta: `${i.number} · ${Math.max(1, Math.floor((now.getTime() - i.dueDate.getTime()) / DAY))} days late · ${inr(i.balance)}`,
            href: `/admin/finance/invoices/${i.id}`,
            badge: { label: inr(i.balance), tone: 'red' },
          })),
        };
      }
    }
  }
}
