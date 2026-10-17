import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CRAFT_CHECKLISTS,
  CRAFT_SOCIAL_QUOTAS,
  CRAFT_SOCIAL_STAGES,
  CRAFT_UX_PHASES,
  craftParseQuota,
  craftQuotaBucket,
  craftScriptStats,
  craftSocialStage,
  craftSpecialtyLabel,
  deliverableStatusLabels,
  isCraftSpecialty,
  istDate,
  reviewAnchorSchema,
  type CraftBrandKitInput,
  type CraftBrandKitView,
  type CraftChecklistInput,
  type CraftChecklistKind,
  type CraftChecklistView,
  type CraftComment,
  type CraftDashboard,
  type CraftDevPanels,
  type CraftGraphicPanels,
  type CraftHookInput,
  type CraftHookView,
  type CraftJob,
  type CraftKpi,
  type CraftNextItem,
  type CraftRate,
  type CraftRounds,
  type CraftScriptInput,
  type CraftScriptPanels,
  type CraftScriptView,
  type CraftSocialPanels,
  type CraftSocialStage,
  type CraftSpecialistRow,
  type CraftUxPanels,
  type CraftVideoPanels,
  type CraftWorkload,
  type DeliverableStatus,
  type Me,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CraftManagerService } from './craft-manager.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { checkWindow, loadWorkCalendar } from '../admin-org/work-calendar.js';
import { DAY, avg, clock, days, inRange, istDow, pct, periodsFrom, plural, round1, shortDay, weekStart, type Periods, type Range } from './craft-util.js';

const OPEN = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
const LOCKED = ['approved', 'scheduled', 'published'];
const NO_UPLOAD = [...LOCKED, 'in_qc', 'ready_for_client'];
const LEADS_ALL = ['founder', 'admin', 'am_lead'];

const dInclude = {
  cycle: {
    include: {
      engagement: { include: { clientOrg: { select: { id: true, name: true } }, service: { select: { id: true, name: true, key: true, track: true } } } },
      requirements: { orderBy: { dateRequested: 'asc' as const } },
    },
  },
  versions: { orderBy: { number: 'asc' as const }, include: { file: true, qcResults: { orderBy: { createdAt: 'asc' as const } } } },
  tasks: {
    orderBy: { sort: 'asc' as const },
    select: { id: true, ownerId: true, kind: true, status: true, flowStep: true, deadline: true, startedAt: true, completedAt: true, createdAt: true, timeLoggedMin: true, title: true, blockedReason: true },
  },
} satisfies Prisma.DeliverableInclude;
type DRow = Prisma.DeliverableGetPayload<{ include: typeof dInclude }>;
type TRow = DRow['tasks'][number];

type MyTask = Prisma.TaskGetPayload<{ select: { id: true; title: true; status: true; kind: true; flowStep: true; deadline: true; startedAt: true; completedAt: true; createdAt: true; timeLoggedMin: true; deliverableId: true; engagementId: true; blockedReason: true } }>;

type Target = { id: string; name: string; specialty: string | null; departmentId: string | null; department: string | null; baseRole: string | null };

type Ctx = {
  me: Me;
  target: Target;
  readOnly: boolean;
  p: Periods;
  now: Date;
  tasks: MyTask[];
  dels: Map<string, DRow>;
  comments: CommentRow[];
  included: Map<string, number>;
  checklists: Map<string, { label: string; done: boolean }[]>;
  /** Tasks a manager handed to the target in the last 3 days (from the audit log). */
  assigned: Map<string, { by: string; at: Date }>;
};
type CommentRow = { id: string; targetId: string; body: string; timestampOrPin: string | null; isInternal: boolean; authorId: string; createdAt: Date; resolvedAt: Date | null; author: string; fromClient: boolean };

const isOpen = (s: string) => (OPEN as readonly string[]).includes(s);
const deliverableHref = (id: string) => `/team/deliverables/${id}`;

@Injectable()
export class CraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly manager: CraftManagerService,
    private readonly settings: SettingsService,
  ) {}

  // -------------------------------------------------------------------------
  // Access

  private staffOnly(me: Me) {
    if (me.type !== 'staff') throw new ForbiddenException('Specialist dashboards are for the BMU team');
  }

  private async loadTarget(me: Me, userId: string): Promise<Target> {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, orgId: me.orgId, type: 'staff', deletedAt: null },
      include: { department: { select: { name: true } }, roles: { include: { role: { select: { baseRole: true } } } } },
    });
    if (!u) throw new NotFoundException('Team member not found');
    return { id: u.id, name: u.name, specialty: u.specialty, departmentId: u.departmentId, department: u.department?.name ?? null, baseRole: u.roles[0]?.role.baseRole ?? null };
  }

  /** Founder, Admin and CM Lead see everyone; a Department Head sees their own department. */
  private async leadScope(me: Me): Promise<Prisma.UserWhereInput | null> {
    if (me.roles.some((r) => LEADS_ALL.includes(r))) return { orgId: me.orgId };
    if (me.roles.includes('department_head')) {
      const self = await this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } });
      return { orgId: me.orgId, departmentId: self?.departmentId ?? '__none__' };
    }
    return null;
  }

  private async assertCanView(me: Me, target: Target) {
    if (target.id === me.id) return;
    // Account and project managers may open the dashboard of anyone working on their clients.
    if (await this.manager.worksForMe(me, target.id)) return;
    const scope = await this.leadScope(me);
    if (!scope) throw new ForbiddenException('You can only open your own dashboard');
    if (scope.departmentId && scope.departmentId !== target.departmentId) throw new ForbiddenException('That person is outside your department');
  }

  /** Who may act on a deliverable: someone with a task on it, its CM, a department head or leadership. */
  private async assertWorksOn(me: Me, deliverableId: string) {
    this.staffOnly(me);
    const d = await this.prisma.deliverable.findFirst({
      where: { id: deliverableId, orgId: me.orgId },
      include: { tasks: { select: { ownerId: true } }, cycle: { include: { engagement: { select: { amId: true, clientOrgId: true, id: true } } } } },
    });
    if (!d) throw new NotFoundException('Deliverable not found');
    const ok =
      d.tasks.some((t) => t.ownerId === me.id) || d.cycle.engagement.amId === me.id || me.roles.some((r) => [...LEADS_ALL, 'department_head'].includes(r));
    // A social media manager runs the whole content pipeline of the clients they work on.
    const smm =
      !ok &&
      me.specialty === 'social_media_manager' &&
      (await this.prisma.task.count({ where: { ownerId: me.id, OR: [{ engagementId: d.cycle.engagement.id }, { deliverable: { cycle: { engagementId: d.cycle.engagement.id } } }] } })) > 0;
    if (!ok && !smm) throw new ForbiddenException('Only the people working on this deliverable can do that');
    return d;
  }

  // -------------------------------------------------------------------------
  // Specialists list (leads)

  async specialists(me: Me): Promise<CraftSpecialistRow[]> {
    this.staffOnly(me);
    const scope = await this.leadScope(me);
    if (!scope) throw new ForbiddenException('Only leads can see the specialists list');
    const users = await this.prisma.user.findMany({
      where: { ...scope, type: 'staff', deletedAt: null, specialty: { not: null } },
      include: { department: { select: { name: true } } },
      orderBy: [{ specialty: 'asc' }, { name: 'asc' }],
    });
    const now = new Date();
    const ids = users.map((u) => u.id);
    const tasks = ids.length
      ? await this.prisma.task.findMany({
          where: { ownerId: { in: ids }, OR: [{ status: { in: [...OPEN] } }, { completedAt: { gte: new Date(now.getTime() - 30 * DAY) } }] },
          select: { ownerId: true, status: true, deadline: true, completedAt: true, timeLoggedMin: true },
        })
      : [];
    const week = new Date(now.getTime() + 7 * DAY);
    return users.map((u) => {
      const mine = tasks.filter((t) => t.ownerId === u.id);
      const open = mine.filter((t) => isOpen(t.status));
      const done = mine.filter((t) => t.status === 'done' && t.completedAt && t.completedAt.getTime() >= now.getTime() - 30 * DAY);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        specialty: u.specialty!,
        specialtyLabel: craftSpecialtyLabel(u.specialty),
        department: u.department?.name ?? null,
        open: open.length,
        overdue: open.filter((t) => t.deadline && t.deadline < now && t.status !== 'blocked').length,
        dueThisWeek: open.filter((t) => t.deadline && t.deadline >= now && t.deadline < week).length,
        doneLast30: done.length,
        hoursLast30: round1(done.reduce((s, t) => s + t.timeLoggedMin, 0) / 60),
        href: `/team/specialists/${u.id}`,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Dashboard

  async dashboard(me: Me, opts: { userId?: string; from?: string; to?: string }): Promise<CraftDashboard> {
    this.staffOnly(me);
    const target = await this.loadTarget(me, opts.userId || me.id);
    await this.assertCanView(me, target);
    const ctx = await this.context(me, target, periodsFrom(opts.from, opts.to));
    const base = {
      person: { id: target.id, name: target.name, specialty: target.specialty, specialtyLabel: craftSpecialtyLabel(target.specialty), department: target.department, baseRole: target.baseRole },
      readOnly: ctx.readOnly,
      period: { from: istDate(ctx.p.cur.from), to: istDate(new Date(ctx.p.cur.to.getTime() - 1)), prevFrom: istDate(ctx.p.prev.from), prevTo: istDate(new Date(ctx.p.prev.to.getTime() - 1)) },
      strip: await this.strip(ctx),
      next: this.nextActions(ctx),
      workload: this.workload(ctx),
    };
    const common = this.commonKpis(ctx);
    const spec = isCraftSpecialty(target.specialty) ? target.specialty : null;
    switch (spec) {
      case 'video_editor': {
        const panels = this.videoPanels(ctx);
        return { ...base, specialty: spec, panels, ...this.videoSummary(ctx, panels, common) };
      }
      case 'script_writer': {
        const panels = await this.scriptPanels(ctx);
        return { ...base, specialty: spec, panels, ...this.scriptSummary(ctx, panels, common) };
      }
      case 'social_media_manager': {
        const panels = await this.socialPanels(ctx);
        // Client approvals that have waited 2+ days count as feedback to chase, right after today's work.
        const chase: CraftNextItem[] = panels.approvals
          .filter((a) => a.daysWaiting >= 2)
          .map((a) => ({ id: `a-${a.deliverableId}`, kind: 'feedback', title: a.title, detail: `Waiting on the client for ${plural(a.daysWaiting, 'day')}${a.canNudge ? ' — send a nudge' : ' — nudged recently'}`, href: a.href, due: null, client: a.client }));
        const cut = base.next.findIndex((n) => n.kind !== 'overdue' && n.kind !== 'due_today');
        const next = cut === -1 ? [...base.next, ...chase] : [...base.next.slice(0, cut), ...chase, ...base.next.slice(cut)];
        return { ...base, next: next.slice(0, 14), specialty: spec, panels, ...this.socialSummary(ctx, panels, common) };
      }
      case 'developer': {
        const panels = await this.devPanels(ctx);
        return { ...base, specialty: spec, panels, ...this.devSummary(ctx, panels, common) };
      }
      case 'ux_ui_designer': {
        const panels = await this.uxPanels(ctx);
        return { ...base, specialty: spec, panels, ...this.uxSummary(ctx, panels, common) };
      }
      case 'graphic_designer': {
        const panels = await this.graphicPanels(ctx);
        return { ...base, specialty: spec, panels, ...this.graphicSummary(ctx, panels, common) };
      }
      default:
        return { ...base, specialty: null, panels: null, kpis: [common.done, common.hours, common.onTime, common.open], insights: this.commonInsights(ctx, common) };
    }
  }

  private async context(me: Me, target: Target, p: Periods): Promise<Ctx> {
    const now = new Date();
    const horizon = new Date(Math.min(p.prev.from.getTime(), weekStart(now).getTime() - 8 * 7 * DAY));
    const tasks = await this.prisma.task.findMany({
      where: { orgId: me.orgId, ownerId: target.id, status: { not: 'cancelled' }, OR: [{ status: { not: 'done' } }, { completedAt: null }, { completedAt: { gte: horizon } }] },
      select: { id: true, title: true, status: true, kind: true, flowStep: true, deadline: true, startedAt: true, completedAt: true, createdAt: true, timeLoggedMin: true, deliverableId: true, engagementId: true, blockedReason: true },
      orderBy: [{ deadline: 'asc' }],
      take: 800,
    });
    const delIds = [...new Set(tasks.map((t) => t.deliverableId).filter((x): x is string => !!x))];
    const rows = delIds.length ? await this.prisma.deliverable.findMany({ where: { id: { in: delIds } }, include: dInclude }) : [];
    const ctx: Ctx = { me, target, readOnly: target.id !== me.id, p, now, tasks, dels: new Map(rows.map((d) => [d.id, d])), comments: [], included: new Map(), checklists: new Map(), assigned: new Map() };
    await this.hydrate(ctx, rows);
    const openIds = tasks.filter((t) => isOpen(t.status)).map((t) => t.id);
    if (openIds.length) {
      const events = await this.prisma.auditEvent.findMany({
        where: { orgId: me.orgId, entity: 'Task', entityId: { in: openIds }, action: { in: ['task.assigned', 'task.reassigned', 'task.created'] }, at: { gte: new Date(now.getTime() - 3 * DAY) } },
        orderBy: { at: 'desc' },
        select: { entityId: true, at: true, actorId: true, after: true },
      });
      const actors = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(events.map((e) => e.actorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      for (const e of events) {
        const after = e.after as { ownerId?: string | null } | null;
        if (after?.ownerId !== target.id || e.actorId === target.id || ctx.assigned.has(e.entityId)) continue;
        ctx.assigned.set(e.entityId, { by: (e.actorId && actors.get(e.actorId)) || 'A manager', at: e.at });
      }
    }
    return ctx;
  }

  /** Loads comments, included revision rounds and saved checklists for these deliverables into the context. */
  private async hydrate(ctx: Ctx, rows: DRow[]) {
    const versionIds = rows.flatMap((d) => d.versions.map((v) => v.id));
    if (versionIds.length) {
      const comments = await this.prisma.comment.findMany({ where: { targetType: 'version', targetId: { in: versionIds } }, orderBy: { createdAt: 'asc' } });
      const authors = await this.prisma.user.findMany({ where: { id: { in: [...new Set(comments.map((c) => c.authorId))] } }, select: { id: true, name: true, type: true } });
      const known = new Set(ctx.comments.map((c) => c.id));
      for (const c of comments) {
        if (known.has(c.id)) continue;
        const a = authors.find((x) => x.id === c.authorId);
        ctx.comments.push({ ...c, author: a?.name ?? '', fromClient: a?.type === 'client' });
      }
    }
    const pairs = [...new Set(rows.map((d) => `${d.cycle.engagement.serviceId}|${d.cycle.engagement.tier}`))].filter((k) => !ctx.included.has(k));
    if (pairs.length) {
      const tiers = await this.prisma.serviceTier.findMany({
        where: { OR: pairs.map((k) => ({ serviceId: k.split('|')[0], tier: k.split('|')[1] as never })) },
        select: { serviceId: true, tier: true, revisionRounds: true },
      });
      for (const k of pairs) ctx.included.set(k, tiers.find((t) => `${t.serviceId}|${t.tier}` === k)?.revisionRounds ?? 2);
    }
    const ids = rows.map((d) => d.id);
    if (ids.length) {
      const lists = await this.prisma.craftChecklist.findMany({ where: { deliverableId: { in: ids } } });
      for (const l of lists) ctx.checklists.set(`${l.deliverableId}:${l.kind}`, l.items as { label: string; done: boolean }[]);
    }
    for (const d of rows) ctx.dels.set(d.id, d);
  }

  // -------------------------------------------------------------------------
  // Shared builders

  private myTasksOn(ctx: Ctx, d: DRow): TRow[] {
    return d.tasks.filter((t) => t.ownerId === ctx.target.id);
  }

  private includedRounds(ctx: Ctx, d: DRow) {
    return ctx.included.get(`${d.cycle.engagement.serviceId}|${d.cycle.engagement.tier}`) ?? 2;
  }

  private canUpload(ctx: Ctx, d: DRow) {
    return !ctx.readOnly && this.makes(ctx, d) && !NO_UPLOAD.includes(d.status) && d.tasks.filter((t) => t.kind === 'work').slice(0, -1).every((t) => t.status === 'done');
  }

  private job(ctx: Ctx, d: DRow, stage: string, task?: TRow | MyTask | null): CraftJob {
    const mine = this.myTasksOn(ctx, d);
    const current = task ?? mine.find((t) => isOpen(t.status)) ?? mine.at(-1) ?? null;
    const due = current?.deadline ?? d.dueAt ?? null;
    const overdue = !!due && due < ctx.now && !!current && isOpen(current.status);
    const soon = !!due && due.getTime() - ctx.now.getTime() < 1.5 * DAY;
    const included = this.includedRounds(ctx, d);
    return {
      deliverableId: d.id,
      taskId: current?.id ?? null,
      title: d.title,
      type: d.type,
      client: d.cycle.engagement.clientOrg,
      engagementId: d.cycle.engagementId,
      status: d.status,
      statusLabel: deliverableStatusLabels[d.status as DeliverableStatus] ?? d.status,
      stage,
      due: due?.toISOString() ?? null,
      overdue,
      priority: overdue || d.status === 'changes_requested' || d.status === 'qc_failed' || (soon && !!current && isOpen(current.status)) ? 'high' : due && due.getTime() - ctx.now.getTime() < 4 * DAY ? 'normal' : 'low',
      roundsUsed: d.revisionRoundsUsed,
      roundsIncluded: included,
      versions: d.versions.length,
      canUpload: this.canUpload(ctx, d),
      href: deliverableHref(d.id),
    };
  }

  /** Deliverables this person is actively working on (open task, or work waiting on QC / client / fixes). */
  private activeDeliverables(ctx: Ctx): DRow[] {
    return [...ctx.dels.values()].filter((d) => {
      if (LOCKED.includes(d.status)) return false;
      return this.myTasksOn(ctx, d).some((t) => isOpen(t.status) && t.kind === 'work') || (this.makes(ctx, d) && d.status !== 'planned');
    });
  }

  private comment(ctx: Ctx, c: CommentRow): CraftComment {
    const d = [...ctx.dels.values()].find((x) => x.versions.some((v) => v.id === c.targetId))!;
    const v = d.versions.find((x) => x.id === c.targetId)!;
    let anchor: CraftComment['anchor'] = null;
    if (c.timestampOrPin) {
      try {
        const parsed = reviewAnchorSchema.safeParse(JSON.parse(c.timestampOrPin));
        if (parsed.success) anchor = parsed.data.x !== undefined && parsed.data.y !== undefined && parsed.data.t === undefined ? { x: parsed.data.x, y: parsed.data.y } : parsed.data.t !== undefined ? { t: parsed.data.t } : null;
      } catch {
        anchor = null;
      }
    }
    return {
      id: c.id,
      deliverableId: d.id,
      deliverableTitle: d.title,
      client: d.cycle.engagement.clientOrg.name,
      versionNumber: v.number,
      body: c.body,
      author: c.author,
      fromClient: c.fromClient,
      at: c.createdAt.toISOString(),
      anchorLabel: !anchor ? null : 't' in anchor ? clock(anchor.t) : `Pin ${Math.round(anchor.x)}% · ${Math.round(anchor.y)}%`,
      anchor,
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
      href: deliverableHref(d.id),
    };
  }

  /** Client feedback still to handle on this person's deliverables (newest version rounds first). */
  private openClientComments(ctx: Ctx, filter: (c: CraftComment) => boolean = () => true): CraftComment[] {
    const mineIds = new Set(this.madeBy(ctx).map((d) => d.id));
    return ctx.comments
      .filter((c) => c.fromClient && !c.isInternal)
      .map((c) => this.comment(ctx, c))
      .filter((c) => mineIds.has(c.deliverableId) && !c.resolvedAt && filter(c))
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  private rounds(ctx: Ctx, rows: DRow[]): CraftRounds[] {
    return rows
      .filter((d) => this.makes(ctx, d) && (d.versions.length > 0 || d.revisionRoundsUsed > 0))
      .map((d) => {
        const included = this.includedRounds(ctx, d);
        return { deliverableId: d.id, title: d.title, client: d.cycle.engagement.clientOrg.name, used: d.revisionRoundsUsed, included, left: included - d.revisionRoundsUsed, href: deliverableHref(d.id) };
      })
      .sort((a, b) => a.left - b.left);
  }

  private checklist(ctx: Ctx, d: DRow, kind: CraftChecklistKind): CraftChecklistView {
    const saved = ctx.checklists.get(`${d.id}:${kind}`);
    const items = saved?.length ? saved : CRAFT_CHECKLISTS[kind].map((label) => ({ label, done: false }));
    return { deliverableId: d.id, title: d.title, client: d.cycle.engagement.clientOrg.name, kind, items, done: items.filter((i) => i.done).length, total: items.length, href: deliverableHref(d.id) };
  }

  private approvedAt(d: DRow): Date | null {
    if (!LOCKED.includes(d.status)) return null;
    const v = d.versions.find((x) => x.id === d.approvedVersionId) ?? d.versions.at(-1);
    const doneTasks = d.tasks.filter((t) => t.completedAt).map((t) => t.completedAt!.getTime());
    return doneTasks.length ? new Date(Math.max(...doneTasks)) : (v?.createdAt ?? null);
  }

  /** First-time approval: deliverables approved in the range with no client revision round. */
  private firstTime(ctx: Ctx, rows: DRow[]): CraftRate {
    const rate = (r: Range) => {
      const approved = rows.filter((d) => inRange(this.approvedAt(d), r));
      const good = approved.filter((d) => d.revisionRoundsUsed === 0).length;
      return { good, total: approved.length, rate: pct(good, approved.length) };
    };
    const cur = rate(ctx.p.cur);
    return { ...cur, previous: rate(ctx.p.prev).rate };
  }

  /** The maker of a deliverable is whoever owns its last work step (they upload the versions clients review). */
  private makes(ctx: Ctx, d: DRow) {
    return d.tasks.filter((t) => t.kind === 'work').at(-1)?.ownerId === ctx.target.id;
  }

  private madeBy(ctx: Ctx) {
    return [...ctx.dels.values()].filter((d) => this.makes(ctx, d));
  }

  private commonKpis(ctx: Ctx) {
    const doneIn = (r: Range) => ctx.tasks.filter((t) => t.status === 'done' && inRange(t.completedAt, r));
    const hours = (r: Range) => round1(doneIn(r).reduce((s, t) => s + t.timeLoggedMin, 0) / 60);
    const onTime = (r: Range) => {
      const xs = doneIn(r).filter((t) => t.deadline);
      return pct(xs.filter((t) => t.completedAt! <= t.deadline!).length, xs.length);
    };
    const open = ctx.tasks.filter((t) => isOpen(t.status));
    const k = (key: string, label: string, value: number, previous: number | null, format: CraftKpi['format'], extra: Partial<CraftKpi> = {}): CraftKpi => ({ key, label, value, previous, format, ...extra });
    const otCur = onTime(ctx.p.cur);
    return {
      doneCount: doneIn(ctx.p.cur).length,
      donePrev: doneIn(ctx.p.prev).length,
      done: k('done', 'Tasks finished', doneIn(ctx.p.cur).length, doneIn(ctx.p.prev).length, 'int', { href: '/team/tasks' }),
      hours: k('hours', 'Hours logged', hours(ctx.p.cur), hours(ctx.p.prev), 'hours', { hint: 'on finished tasks' }),
      onTime: k('on_time', 'On time', otCur ?? 0, onTime(ctx.p.prev), 'pct', { hint: otCur === null ? 'no deadlines yet' : 'finished by the deadline' }),
      open: k('open', 'Open tasks', open.length, null, 'int', { href: '/team/tasks', hint: `${open.filter((t) => t.deadline && t.deadline < ctx.now && t.status !== 'blocked').length} overdue` }),
      onTimeCur: otCur,
    };
  }

  private commonInsights(ctx: Ctx, c: ReturnType<CraftService['commonKpis']>): string[] {
    const out: string[] = [];
    const len = Math.round((ctx.p.cur.to.getTime() - ctx.p.cur.from.getTime()) / DAY);
    if (c.doneCount || c.donePrev)
      out.push(`${ctx.readOnly ? `${ctx.target.name.split(' ')[0]} finished` : 'You finished'} ${plural(c.doneCount, 'task')} in the last ${len} days${c.donePrev ? `, ${c.doneCount >= c.donePrev ? 'up' : 'down'} from ${c.donePrev} the period before` : ''}.`);
    if (c.onTimeCur !== null) out.push(`${c.onTimeCur}% of finished tasks met their deadline${c.onTimeCur >= 85 ? ' — a strong record.' : c.onTimeCur < 60 ? '. Flag blockers early so deadlines can move before they slip.' : '.'}`);
    return out;
  }

  private nextActions(ctx: Ctx): CraftNextItem[] {
    const out: CraftNextItem[] = [];
    const today = istDate(ctx.now);
    const hrefFor = (t: MyTask) => (t.deliverableId ? deliverableHref(t.deliverableId) : '/team/tasks');
    const clientOf = (t: MyTask) => (t.deliverableId ? (ctx.dels.get(t.deliverableId)?.cycle.engagement.clientOrg.name ?? null) : null);
    const open = ctx.tasks.filter((t) => isOpen(t.status) && t.kind !== 'client_review');
    for (const t of open.filter((t) => t.status !== 'blocked' && t.deadline && t.deadline < ctx.now)) {
      const late = Math.max(1, Math.round(days(t.deadline!, ctx.now)));
      out.push({ id: `o-${t.id}`, kind: 'overdue', title: t.title, detail: `${plural(late, 'day')} late`, href: hrefFor(t), due: t.deadline!.toISOString(), client: clientOf(t) });
    }
    for (const t of open.filter((t) => t.status !== 'blocked' && t.deadline && t.deadline >= ctx.now && istDate(t.deadline) === today)) {
      out.push({ id: `t-${t.id}`, kind: 'due_today', title: t.title, detail: 'Due today', href: hrefFor(t), due: t.deadline!.toISOString(), client: clientOf(t) });
    }
    const listed = new Set(out.map((o) => o.id.slice(2)));
    for (const t of open.filter((t) => ctx.assigned.has(t.id) && !listed.has(t.id))) {
      const a = ctx.assigned.get(t.id)!;
      out.push({ id: `n-${t.id}`, kind: 'assigned', title: t.title, detail: `Assigned by ${a.by} ${shortDay(a.at)}${t.deadline ? ` · due ${shortDay(t.deadline)}` : ''}`, href: hrefFor(t), due: t.deadline?.toISOString() ?? null, client: clientOf(t) });
    }
    const feedbackSeen = new Set<string>();
    for (const d of this.madeBy(ctx).filter((d) => d.status === 'changes_requested' || d.status === 'qc_failed')) {
      feedbackSeen.add(d.id);
      out.push({
        id: `f-${d.id}`,
        kind: 'feedback',
        title: d.title,
        detail: d.status === 'qc_failed' ? 'QC asked for fixes' : `Client asked for changes (round ${d.revisionRoundsUsed} of ${this.includedRounds(ctx, d)})`,
        href: deliverableHref(d.id),
        due: d.tasks.find((t) => t.ownerId === ctx.target.id && isOpen(t.status))?.deadline?.toISOString() ?? null,
        client: d.cycle.engagement.clientOrg.name,
      });
    }
    const byDel = new Map<string, CraftComment[]>();
    for (const c of this.openClientComments(ctx)) byDel.set(c.deliverableId, [...(byDel.get(c.deliverableId) ?? []), c]);
    for (const [id, cs] of byDel) {
      if (feedbackSeen.has(id)) continue;
      out.push({ id: `c-${id}`, kind: 'feedback', title: cs[0].deliverableTitle, detail: `${plural(cs.length, 'client comment')} to resolve`, href: deliverableHref(id), due: null, client: cs[0].client });
    }
    for (const t of open.filter((t) => t.status === 'blocked')) {
      out.push({ id: `b-${t.id}`, kind: 'blocked', title: t.title, detail: t.blockedReason ? `Blocked: ${t.blockedReason}` : 'Blocked', href: hrefFor(t), due: t.deadline?.toISOString() ?? null, client: clientOf(t) });
    }
    return out.slice(0, 14);
  }

  private async strip(ctx: Ctx) {
    const date = new Date(`${istDate(ctx.now)}T00:00:00Z`);
    const [att, eod] = await Promise.all([
      this.prisma.attendance.findUnique({ where: { userId_date: { userId: ctx.target.id, date } } }),
      this.prisma.eODReport.findUnique({ where: { userId_date: { userId: ctx.target.id, date } } }),
    ]);
    const open = ctx.tasks.filter((t) => isOpen(t.status));
    const today = istDate(ctx.now);
    return {
      checkIn: att?.checkIn?.toISOString() ?? null,
      checkOut: att?.checkOut?.toISOString() ?? null,
      ...checkWindow(att, today, await loadWorkCalendar(this.settings, ctx.me.orgId)),
      overdue: open.filter((t) => t.status !== 'blocked' && t.deadline && t.deadline < ctx.now).length,
      dueToday: open.filter((t) => t.status !== 'blocked' && t.deadline && t.deadline >= ctx.now && istDate(t.deadline) === today).length,
      blocked: open.filter((t) => t.status === 'blocked').length,
      open: open.length,
      eodSubmitted: !!eod,
    };
  }

  private workload(ctx: Ctx): CraftWorkload {
    const past = 8;
    const future = 2;
    const start = weekStart(ctx.now).getTime() - (past - 1) * 7 * DAY;
    const weeks: string[] = [];
    const hours: (number | null)[] = [];
    const done: (number | null)[] = [];
    const due: number[] = [];
    const heat: (number | null)[][] = Array.from({ length: 6 }, () => Array(past).fill(0));
    for (let w = 0; w < past + future; w++) {
      const from = new Date(start + w * 7 * DAY);
      const to = new Date(from.getTime() + 7 * DAY);
      weeks.push(shortDay(from));
      const fin = ctx.tasks.filter((t) => t.status === 'done' && inRange(t.completedAt, { from, to }));
      const isFuture = w >= past;
      hours.push(isFuture ? null : round1(fin.reduce((s, t) => s + t.timeLoggedMin, 0) / 60));
      done.push(isFuture ? null : fin.length);
      due.push(ctx.tasks.filter((t) => t.deadline && inRange(t.deadline, { from, to }) && (isOpen(t.status) || t.status === 'done')).length);
      if (!isFuture) for (const t of fin) {
        const dow = istDow(t.completedAt!);
        if (dow < 6) heat[dow][w] = (heat[dow][w] ?? 0) + 1;
      }
    }
    return { weeks, future, hours, done, due, heat: { rows: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], cols: weeks.slice(0, past), values: heat } };
  }

  // -------------------------------------------------------------------------
  // Video editor

  private videoStage(ctx: Ctx, d: DRow): string {
    const open = this.myTasksOn(ctx, d).find((t) => isOpen(t.status));
    const step = open?.flowStep ?? '';
    if (['rough_cut', 'fine_cut', 'export'].includes(step)) return step;
    if (step === 'colour' || step === 'sound') return 'colour';
    if (step === 'shoot') return 'footage';
    if (LOCKED.includes(d.status) || ['qc_passed', 'ready_for_client'].includes(d.status)) return 'export';
    if (d.status === 'in_qc') return 'colour';
    if (d.versions.length === 0) return 'rough_cut';
    return 'fine_cut';
  }

  private videoPanels(ctx: Ctx): CraftVideoPanels {
    const active = this.activeDeliverables(ctx);
    const pendingExport = [...ctx.dels.values()].filter((d) => LOCKED.includes(d.status) && this.makes(ctx, d) && inRange(this.approvedAt(d), { from: new Date(ctx.now.getTime() - 7 * DAY), to: new Date(ctx.now.getTime() + DAY) }) && this.checklist(ctx, d, 'export').done < this.checklist(ctx, d, 'export').total);
    const jobs = [...active, ...pendingExport].map((d) => this.job(ctx, d, this.videoStage(ctx, d)));
    const stageDefs = [
      { key: 'footage', label: 'Prep & footage' },
      { key: 'rough_cut', label: 'Rough cut' },
      { key: 'fine_cut', label: 'Fine cut / fixes' },
      { key: 'colour', label: 'Colour & sound' },
      { key: 'export', label: 'Export & delivery' },
    ];
    const stages = stageDefs.map((s) => ({ ...s, items: jobs.filter((j) => j.stage === s.key).sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9')) })).filter((s) => s.key !== 'footage' || s.items.length);
    // Footage and assets the client owes, once per cycle (month or project) with the jobs that need them.
    const byCycle = new Map<string, DRow[]>();
    for (const d of active) byCycle.set(d.cycleId, [...(byCycle.get(d.cycleId) ?? []), d]);
    const assets = [...byCycle.values()]
      .map((ds) => {
        const d = ds[0];
        const label = d.cycle.period === 'project' ? 'project' : d.cycle.period;
        return {
          deliverableId: d.id,
          title: `${ds.length === 1 ? d.title : `${plural(ds.length, 'job')}: ${ds.slice(0, 3).map((x) => x.title).join(', ')}${ds.length > 3 ? '…' : ''}`} (${label})`,
          client: d.cycle.engagement.clientOrg.name,
          href: `/team/projects/${d.cycle.engagementId}`,
          items: d.cycle.requirements.filter((r) => r.type === 'asset').map((r) => ({ label: r.label, status: r.status, note: r.waitingFor ?? r.blockedReason ?? null })),
        };
      })
      .filter((a) => a.items.length);
    const madeBy = this.madeBy(ctx);
    const finished = madeBy.filter((d) => inRange(this.approvedAt(d), ctx.p.cur) || inRange(this.approvedAt(d), ctx.p.prev));
    const hoursPerVideo = finished
      .filter((d) => inRange(this.approvedAt(d), ctx.p.cur))
      .map((d) => {
        const mine = this.myTasksOn(ctx, d);
        const startAt = mine.map((t) => (t.startedAt ?? t.createdAt).getTime());
        const end = this.approvedAt(d);
        return {
          deliverableId: d.id,
          title: d.title,
          client: d.cycle.engagement.clientOrg.name,
          hours: round1(mine.reduce((s, t) => s + t.timeLoggedMin, 0) / 60),
          turnaroundDays: startAt.length && end ? round1(days(new Date(Math.min(...startAt)), end)) : null,
          href: deliverableHref(d.id),
        };
      });
    const upcoming = ctx.tasks
      .filter((t) => isOpen(t.status) && t.deadline && t.deadline >= new Date(ctx.now.getTime() - DAY) && t.deadline.getTime() < ctx.now.getTime() + 7 * DAY)
      .map((t) => ({ id: t.id, title: t.title, client: (t.deliverableId && ctx.dels.get(t.deliverableId)?.cycle.engagement.clientOrg.name) || '', at: t.deadline!.toISOString(), kind: (t.flowStep === 'shoot' ? 'shoot' : 'deadline') as 'shoot' | 'deadline', href: t.deliverableId ? deliverableHref(t.deliverableId) : '/team/tasks' }));
    return {
      stages,
      assets,
      timeComments: this.openClientComments(ctx, (c) => !!c.anchor && 't' in c.anchor).concat(this.openClientComments(ctx, (c) => !c.anchor)).slice(0, 30),
      rounds: this.rounds(ctx, active),
      exportChecklists: [...active.filter((d) => ['colour', 'export'].includes(this.videoStage(ctx, d))), ...pendingExport].map((d) => this.checklist(ctx, d, 'export')),
      hoursPerVideo,
      avgTurnaroundDays: avg(hoursPerVideo.map((h) => h.turnaroundDays).filter((x): x is number => x !== null)),
      upcoming,
    };
  }

  private videoSummary(ctx: Ctx, p: CraftVideoPanels, c: ReturnType<CraftService['commonKpis']>) {
    const madeBy = this.madeBy(ctx);
    const delivered = (r: Range) => madeBy.filter((d) => inRange(this.approvedAt(d), r));
    const turn = (r: Range) =>
      avg(
        delivered(r)
          .map((d) => {
            const s = this.myTasksOn(ctx, d).map((t) => (t.startedAt ?? t.createdAt).getTime());
            const e = this.approvedAt(d);
            return s.length && e ? days(new Date(Math.min(...s)), e) : null;
          })
          .filter((x): x is number => x !== null),
      );
    const tPrev = turn(ctx.p.prev);
    const hpv = p.hoursPerVideo.length ? round1(p.hoursPerVideo.reduce((s, h) => s + h.hours, 0) / p.hoursPerVideo.length) : 0;
    const kpis: CraftKpi[] = [
      { key: 'videos', label: 'Videos delivered', value: delivered(ctx.p.cur).length, previous: delivered(ctx.p.prev).length, format: 'int', hint: 'approved by the client' },
      { key: 'turnaround', label: 'Avg turnaround', value: p.avgTurnaroundDays ?? 0, previous: tPrev, format: 'days', lowerIsBetter: true, hint: 'start of edit to approval' },
      { key: 'hpv', label: 'Hours per video', value: hpv, previous: null, format: 'hours' },
      c.onTime,
      { key: 'comments', label: 'Time-coded notes open', value: p.timeComments.length, previous: null, format: 'int', lowerIsBetter: true },
    ];
    const insights = this.commonInsights(ctx, c);
    const stuck = p.stages.find((s) => s.key === 'rough_cut');
    if (p.timeComments.length) insights.push(`${plural(p.timeComments.length, 'client note')} ${p.timeComments.length === 1 ? 'is' : 'are'} waiting — the oldest is from ${shortDay(new Date(p.timeComments[0].at))}. Resolve them before exporting the next cut.`);
    if (stuck && stuck.items.length > 2) insights.push(`${stuck.items.length} edits are still at rough cut. Rough cuts first keeps client rounds short.`);
    const tight = p.rounds.filter((r) => r.left <= 0);
    if (tight.length) insights.push(`${plural(tight.length, 'video')} ${tight.length === 1 ? 'has' : 'have'} used every included revision round; any more changes should be quoted as an add-on.`);
    const missing = p.assets.filter((a) => a.items.some((i) => i.status !== 'received'));
    if (missing.length) insights.push(`Footage or assets are still missing for ${missing.map((m) => m.client).filter((c, i, a) => a.indexOf(c) === i).join(', ')}. Ask the CM to chase the client before the edit is due.`);
    return { kpis, insights };
  }

  // -------------------------------------------------------------------------
  // Script writer

  private writingStep(t: { flowStep: string | null; kind: string }) {
    return t.kind === 'work' && ['script', 'write', 'outline', 'copy', 'brief'].includes(t.flowStep ?? '');
  }

  private async scriptPanels(ctx: Ctx): Promise<CraftScriptPanels> {
    const rows = [...ctx.dels.values()];
    const writing = rows.filter((d) => this.myTasksOn(ctx, d).some((t) => this.writingStep(t) || t.kind === 'work'));
    const isScriptDeliverable = (d: DRow) => ['script', 'blog', 'other'].includes(d.type) || d.flowKey === 'writing';
    const briefs: CraftJob[] = [];
    const draft: CraftJob[] = [];
    const review: CraftJob[] = [];
    const approved: CraftJob[] = [];
    for (const d of writing) {
      const mine = this.myTasksOn(ctx, d).filter((t) => t.kind === 'work');
      const open = mine.find((t) => isOpen(t.status));
      if (open && open.status === 'todo' && d.versions.length === 0) briefs.push(this.job(ctx, d, 'brief', open));
      else if (open) draft.push(this.job(ctx, d, 'draft', open));
      else if (isScriptDeliverable(d) && ['in_qc', 'qc_passed', 'ready_for_client', 'qc_failed', 'changes_requested'].includes(d.status)) review.push(this.job(ctx, d, 'review'));
      else if (LOCKED.includes(d.status) || (!isScriptDeliverable(d) && mine.every((t) => t.status === 'done'))) {
        const last = mine.map((t) => t.completedAt?.getTime() ?? 0);
        if (Math.max(0, ...last) > ctx.now.getTime() - 45 * DAY) approved.push(this.job(ctx, d, 'approved'));
      }
    }
    const changesRequested = writing.filter((d) => d.status === 'changes_requested').map((d) => this.job(ctx, d, 'draft'));
    const drafts = await this.scriptViews(ctx.me.orgId, ctx.target.id);
    const hooks = await this.hookViews(ctx.me.orgId, ctx.target.id);
    const turnaround = (r: Range) =>
      avg(
        ctx.tasks
          .filter((t) => t.kind === 'work' && t.status === 'done' && inRange(t.completedAt, r))
          .map((t) => days(t.startedAt ?? t.createdAt, t.completedAt!))
          .filter((x) => x >= 0),
      );
    return {
      briefs: briefs.sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9')),
      scripts: { draft, review, approved: approved.slice(0, 12) },
      feedback: this.openClientComments(ctx),
      changesRequested,
      drafts,
      hooks,
      turnaround: { avgDays: turnaround(ctx.p.cur), previous: turnaround(ctx.p.prev) },
      firstTime: this.firstTime(ctx, writing.filter(isScriptDeliverable)),
      deliverables: writing
        .filter((d) => !LOCKED.includes(d.status) && this.makes(ctx, d))
        .map((d) => ({ id: d.id, title: d.title, client: d.cycle.engagement.clientOrg.name, canUpload: this.canUpload(ctx, d) })),
    };
  }

  private scriptSummary(ctx: Ctx, p: CraftScriptPanels, c: ReturnType<CraftService['commonKpis']>) {
    const wordsIn = (r: Range) => p.drafts.filter((s) => inRange(new Date(s.updatedAt), r)).reduce((s, x) => s + x.words, 0);
    const kpis: CraftKpi[] = [
      { ...c.done, label: 'Scripts & copy finished' },
      { key: 'first_time', label: 'First-time approval', value: p.firstTime.rate ?? 0, previous: p.firstTime.previous, format: 'pct', hint: p.firstTime.total ? `${p.firstTime.good} of ${p.firstTime.total} approved with no changes` : 'nothing approved yet' },
      { key: 'turnaround', label: 'Avg turnaround', value: p.turnaround.avgDays ?? 0, previous: p.turnaround.previous, format: 'days', lowerIsBetter: true, hint: 'start to done' },
      { key: 'briefs', label: 'Briefs waiting', value: p.briefs.length, previous: null, format: 'int', lowerIsBetter: true },
      { key: 'words', label: 'Words drafted', value: wordsIn(ctx.p.cur), previous: wordsIn(ctx.p.prev) || null, format: 'int', hint: 'in the script editor' },
    ];
    const insights = this.commonInsights(ctx, c);
    if (p.firstTime.rate !== null) insights.push(`${p.firstTime.rate}% of scripts were approved first time${p.firstTime.previous !== null ? `, compared with ${p.firstTime.previous}% the period before` : ''}.`);
    if (p.briefs.length) insights.push(`${plural(p.briefs.length, 'brief')} ${p.briefs.length === 1 ? 'is' : 'are'} waiting for a script. Start with the one due ${p.briefs[0].due ? shortDay(new Date(p.briefs[0].due)) : 'first'}.`);
    if (p.feedback.length || p.changesRequested.length) insights.push(`Client feedback is waiting on ${plural(new Set([...p.feedback.map((f) => f.deliverableId), ...p.changesRequested.map((j) => j.deliverableId)]).size, 'script')}.`);
    if (p.hooks.length) insights.push(`Your hooks library has ${plural(p.hooks.length, 'line')}; the most reused is used ${plural(Math.max(...p.hooks.map((h) => h.uses)), 'time')}.`);
    return { kpis, insights };
  }

  // -------------------------------------------------------------------------
  // Social media manager

  private async socialRows(ctx: Ctx): Promise<DRow[]> {
    const engagementIds = [...new Set([...ctx.tasks.map((t) => t.engagementId), ...[...ctx.dels.values()].map((d) => d.cycle.engagementId)].filter((x): x is string => !!x))];
    if (!engagementIds.length) return [];
    const rows = await this.prisma.deliverable.findMany({
      where: {
        cycle: { engagementId: { in: engagementIds }, engagement: { deletedAt: null } },
        type: { in: ['post', 'carousel', 'story', 'reel', 'video', 'ad'] },
        OR: [{ status: { notIn: ['approved', 'scheduled', 'published'] } }, { dueAt: { gte: new Date(ctx.now.getTime() - 40 * DAY) } }],
      },
      include: dInclude,
      take: 300,
    });
    await this.hydrate(ctx, rows);
    return rows;
  }

  private async socialPanels(ctx: Ctx): Promise<CraftSocialPanels> {
    const rows = await this.socialRows(ctx);
    const byClient = new Map<string, DRow[]>();
    for (const d of rows) byClient.set(d.cycle.engagement.clientOrg.id, [...(byClient.get(d.cycle.engagement.clientOrg.id) ?? []), d]);
    const pipeline = [...byClient.entries()].map(([clientId, ds]) => {
      const items = ds
        .filter((d) => !['published'].includes(d.status) || (d.dueAt && d.dueAt.getTime() > ctx.now.getTime() - 14 * DAY))
        .map((d) => ({ ...this.job(ctx, d, craftSocialStage(d.status)), socialStage: craftSocialStage(d.status) }))
        .sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9'));
      const counts = Object.fromEntries(CRAFT_SOCIAL_STAGES.map((s) => [s.key, items.filter((i) => i.socialStage === s.key).length])) as Record<CraftSocialStage, number>;
      return { clientId, client: ds[0].cycle.engagement.clientOrg.name, counts, items };
    });
    // This week's schedule: a scheduled date when the content calendar provides one, otherwise the due date.
    const dayKeys = Array.from({ length: 7 }, (_, i) => istDate(new Date(ctx.now.getTime() + i * DAY)));
    const dated = rows.map((d) => {
      const scheduled = (d as unknown as Record<string, unknown>).scheduledAt;
      const at = scheduled instanceof Date ? scheduled : d.dueAt;
      return { d, at, source: (scheduled instanceof Date ? 'scheduled' : 'due') as 'scheduled' | 'due' };
    });
    const schedule = dayKeys.map((date) => ({
      date,
      items: dated
        .filter((x) => x.at && istDate(x.at) === date)
        .map((x) => ({ id: x.d.id, title: x.d.title, client: x.d.cycle.engagement.clientOrg.name, status: x.d.status, statusLabel: deliverableStatusLabels[x.d.status as DeliverableStatus] ?? x.d.status, type: x.d.type, href: deliverableHref(x.d.id), at: x.at!.toISOString(), dateSource: x.source })),
    }));
    const waiting = rows.filter((d) => d.status === 'ready_for_client');
    const nudges = waiting.length
      ? await this.prisma.auditEvent.findMany({ where: { orgId: ctx.me.orgId, action: 'craft.client_nudged', entity: 'Deliverable', entityId: { in: waiting.map((d) => d.id) } }, orderBy: { at: 'desc' } })
      : [];
    const approvals = waiting
      .map((d) => {
        const sent = [...d.versions].reverse().find((v) => v.sentToClientAt)?.sentToClientAt ?? d.versions.at(-1)?.createdAt ?? ctx.now;
        const last = nudges.find((n) => n.entityId === d.id)?.at ?? null;
        return {
          deliverableId: d.id,
          title: d.title,
          client: d.cycle.engagement.clientOrg.name,
          sentAt: sent.toISOString(),
          daysWaiting: Math.max(0, Math.floor(days(sent, ctx.now))),
          lastNudgeAt: last?.toISOString() ?? null,
          canNudge: !ctx.readOnly && (!last || ctx.now.getTime() - last.getTime() > DAY),
          href: deliverableHref(d.id),
        };
      })
      .sort((a, b) => b.daysWaiting - a.daysWaiting);
    const engagementIds = [...new Set(rows.map((d) => d.cycle.engagementId))];
    const reqs = engagementIds.length
      ? await this.prisma.request.findMany({
          where: { engagementId: { in: engagementIds }, OR: [{ status: { notIn: ['done', 'declined'] } }, { createdAt: { gte: new Date(ctx.now.getTime() - 14 * DAY) } }] },
          include: { engagement: { include: { clientOrg: { select: { name: true } } } } },
          orderBy: { createdAt: 'desc' },
          take: 30,
        })
      : [];
    const requests = reqs.map((r) => ({
      id: r.id,
      client: r.engagement.clientOrg.name,
      type: r.type,
      description: r.description,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      overdue: !r.firstReplyAt && !!r.slaDue && r.slaDue < ctx.now && !['done', 'declined'].includes(r.status),
      href: `/team/requests/${r.id}`,
    }));
    // Monthly quota per social engagement: what the package includes vs what this month's cycle plans.
    const month = istDate(ctx.now).slice(0, 7);
    const engs = engagementIds.length
      ? await this.prisma.engagement.findMany({ where: { id: { in: engagementIds }, billingType: 'monthly' }, include: { service: true, clientOrg: { select: { id: true, name: true } }, cycles: { where: { period: month }, include: { deliverables: { select: { type: true } } } } } })
      : [];
    const tiers = engs.length ? await this.prisma.serviceTier.findMany({ where: { OR: engs.map((e) => ({ serviceId: e.serviceId, tier: e.tier })) } }) : [];
    const quotas = engs.filter((e) => e.service.track.startsWith('Social')).map((e) => {
      const parsed = craftParseQuota(tiers.find((t) => t.serviceId === e.serviceId && t.tier === e.tier)?.deliverables ?? []);
      const quota = parsed ?? CRAFT_SOCIAL_QUOTAS[e.tier] ?? CRAFT_SOCIAL_QUOTAS.starter;
      const used = { posts: 0, reels: 0, stories: 0 };
      for (const d of e.cycles.flatMap((c) => c.deliverables)) {
        const b = craftQuotaBucket(d.type);
        if (b) used[b]++;
      }
      return {
        clientId: e.clientOrg.id,
        client: e.clientOrg.name,
        packageName: `${e.service.name} · ${e.tier.charAt(0).toUpperCase()}${e.tier.slice(1)}`,
        source: (parsed ? 'price_book' : 'standard') as 'price_book' | 'standard',
        buckets: (['posts', 'reels', 'stories'] as const).map((key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1), used: used[key], quota: quota[key] })),
      };
    });
    return { pipeline, schedule, approvals, requests, quotas, performance: null };
  }

  private socialSummary(ctx: Ctx, p: CraftSocialPanels, c: ReturnType<CraftService['commonKpis']>) {
    const rows = [...ctx.dels.values()].filter((d) => ['post', 'carousel', 'story', 'reel', 'video', 'ad'].includes(d.type));
    const live = (r: Range) => rows.filter((d) => ['scheduled', 'published'].includes(d.status) && inRange(d.dueAt, r)).length;
    const approvalDays = (r: Range) =>
      avg(
        rows
          .filter((d) => LOCKED.includes(d.status))
          .map((d) => {
            const sent = d.versions.find((v) => v.sentToClientAt)?.sentToClientAt;
            const at = this.approvedAt(d);
            return sent && at && inRange(at, r) ? days(sent, at) : null;
          })
          .filter((x): x is number => x !== null && x >= 0),
      );
    const apCur = approvalDays(ctx.p.cur);
    const kpis: CraftKpi[] = [
      { key: 'live', label: 'Scheduled or published', value: live(ctx.p.cur), previous: live(ctx.p.prev), format: 'int', hint: 'by due date' },
      { key: 'waiting', label: 'Waiting on clients', value: p.approvals.length, previous: null, format: 'int', lowerIsBetter: true, hint: p.approvals[0] ? `oldest ${plural(p.approvals[0].daysWaiting, 'day')}` : undefined },
      { key: 'approval_days', label: 'Client approval time', value: apCur ?? 0, previous: approvalDays(ctx.p.prev), format: 'days', lowerIsBetter: true, hint: apCur === null ? 'no approvals yet' : 'sent to approved' },
      c.onTime,
      { key: 'requests', label: 'Open client requests', value: p.requests.filter((r) => !['done', 'declined'].includes(r.status)).length, previous: null, format: 'int', lowerIsBetter: true, href: '/team/requests' },
    ];
    const insights = this.commonInsights(ctx, c);
    const slow = p.approvals.filter((a) => a.daysWaiting >= 2);
    if (slow.length) insights.push(`${plural(slow.length, 'post')} ${slow.length === 1 ? 'has' : 'have'} waited 2+ days for client approval. A polite nudge usually unblocks the week's schedule.`);
    const empty = p.schedule.filter((d) => !d.items.length).length;
    if (empty >= 4) insights.push(`${empty} of the next 7 days have nothing planned to go out. Check each client's calendar has enough content queued.`);
    const over = p.quotas.flatMap((q) => q.buckets.filter((b) => b.used > b.quota).map((b) => `${q.client} (${b.label.toLowerCase()})`));
    if (over.length) insights.push(`Planned content is over the package for ${over.join(', ')}. Extra pieces should be quoted as add-ons.`);
    const under = p.quotas.filter((q) => q.buckets.some((b) => b.quota && b.used < b.quota * 0.75));
    for (const q of under.slice(0, 2)) {
      const b = q.buckets.find((x) => x.quota && x.used < x.quota * 0.75)!;
      insights.push(`Only ${b.used} of ${b.quota} ${b.label.toLowerCase()} are planned this month for ${q.client}. Plan the rest so the calendar doesn't run dry.`);
    }
    return { kpis, insights };
  }

  // -------------------------------------------------------------------------
  // Developer

  private isWeb(d: DRow) {
    return d.flowKey === 'web' || ['page', 'web_page', 'website', 'landing_page'].includes(d.type) || d.cycle.engagement.service.track.startsWith('Web');
  }

  private async devPanels(ctx: Ctx): Promise<CraftDevPanels> {
    const mine = [...ctx.dels.values()];
    const engagementIds = [...new Set(mine.filter((d) => this.isWeb(d)).map((d) => d.cycle.engagementId))];
    const all = engagementIds.length
      ? await this.prisma.deliverable.findMany({ where: { cycle: { engagementId: { in: engagementIds }, engagement: { deletedAt: null } } }, include: dInclude })
      : [];
    await this.hydrate(ctx, all);
    const web = all.filter((d) => this.isWeb(d));
    const byEng = new Map<string, DRow[]>();
    for (const d of web) byEng.set(d.cycle.engagementId, [...(byEng.get(d.cycle.engagementId) ?? []), d]);
    const projects = [...byEng.entries()].map(([engagementId, ds]) => {
      const done = ds.filter((d) => LOCKED.includes(d.status)).length;
      const dues = ds.map((d) => d.dueAt?.getTime()).filter((x): x is number => !!x);
      return {
        engagementId,
        client: ds[0].cycle.engagement.clientOrg.name,
        service: ds[0].cycle.engagement.service.name,
        done,
        total: ds.length,
        pct: Math.round((done / ds.length) * 100),
        deadline: dues.length ? new Date(Math.max(...dues)).toISOString() : null,
        deliverables: ds.map((d) => ({ id: d.id, title: d.title, status: d.status, statusLabel: deliverableStatusLabels[d.status as DeliverableStatus] ?? d.status, href: deliverableHref(d.id) })),
        href: `/team/projects/${engagementId}`,
      };
    });
    const board: CraftDevPanels['board'] = [
      { key: 'backlog', label: 'Backlog', items: [] },
      { key: 'in_progress', label: 'In progress', items: [] },
      { key: 'review', label: 'In review', items: [] },
      { key: 'done', label: 'Done (14 days)', items: [] },
    ];
    for (const t of ctx.tasks.filter((t) => t.kind === 'work' && t.deliverableId)) {
      const d = ctx.dels.get(t.deliverableId!);
      if (!d) continue;
      const j = this.job(ctx, d, '', t);
      j.title = t.title;
      if (t.status === 'todo') board[0].items.push(j);
      else if (isOpen(t.status)) board[1].items.push(j);
      else if (t.status === 'done' && ['in_qc', 'qc_passed', 'ready_for_client'].includes(d.status)) board[2].items.push(j);
      else if (t.status === 'done' && t.completedAt && t.completedAt.getTime() > ctx.now.getTime() - 14 * DAY) board[3].items.push(j);
    }
    const reqs = engagementIds.length
      ? await this.prisma.request.findMany({
          where: { engagementId: { in: engagementIds }, type: { in: ['change', 'urgent'] }, OR: [{ status: { notIn: ['done', 'declined'] } }, { createdAt: { gte: new Date(ctx.now.getTime() - 30 * DAY) } }] },
          include: { engagement: { include: { clientOrg: { select: { name: true } } } } },
          orderBy: { createdAt: 'desc' },
          take: 30,
        })
      : [];
    const changes = reqs.map((r) => ({
      id: r.id,
      client: r.engagement.clientOrg.name,
      description: r.description,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      deliverable: r.deliverableId ? (all.find((d) => d.id === r.deliverableId)?.title ?? null) : null,
      overdue: !r.firstReplyAt && !!r.slaDue && r.slaDue < ctx.now && !['done', 'declined'].includes(r.status),
      href: `/team/requests/${r.id}`,
    }));
    const shown = web.filter((d) => d.versions.length > 0 || d.tasks.some((t) => t.ownerId === ctx.target.id && t.status === 'in_progress'));
    const links = shown.map((d) => {
      const linkVersions = d.versions.filter((v) => v.file.kind === 'link');
      const staging = linkVersions.at(-1);
      const approved = LOCKED.includes(d.status) ? (linkVersions.find((v) => v.id === d.approvedVersionId) ?? staging) : undefined;
      return {
        deliverableId: d.id,
        title: d.title,
        client: d.cycle.engagement.clientOrg.name,
        staging: staging ? { url: staging.file.path, number: staging.number, at: staging.createdAt.toISOString() } : null,
        live: approved ? { url: approved.file.path, number: approved.number } : null,
        canAdd: this.canUpload(ctx, d),
        href: deliverableHref(d.id),
      };
    });
    const qc = shown.map((d) => {
      const latest = d.versions.flatMap((v) => v.qcResults).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1);
      const raw = latest?.items as { list?: { label: string; ok: boolean; note?: string }[] } | unknown[] | undefined;
      const list = Array.isArray(raw) ? [] : (raw?.list ?? []);
      const items = list.length ? list.map((i) => ({ label: i.label, ok: i.ok, note: i.note ?? null })) : CRAFT_CHECKLISTS.web_qc.map((label) => ({ label, ok: latest ? latest.result === 'pass' : null, note: null }));
      return { deliverableId: d.id, title: d.title, client: d.cycle.engagement.clientOrg.name, result: latest?.result ?? null, at: latest?.createdAt.toISOString() ?? null, items, href: deliverableHref(d.id) };
    });
    const templates = await this.prisma.flowTemplate.findMany({ where: { orgId: ctx.me.orgId, active: true }, orderBy: { version: 'desc' } });
    const estimate = (d: DRow | undefined, step: string | null) => {
      const t = templates.find((x) => x.key === (d?.flowKey ?? 'web'));
      const s = ((t?.steps ?? []) as { key: string; days: number }[]).find((x) => x.key === step);
      return (s?.days ?? 1) * 6;
    };
    const hours = ctx.tasks
      .filter((t) => t.kind === 'work' && t.deliverableId && (['in_progress', 'blocked', 'waiting'].includes(t.status) || inRange(t.completedAt, ctx.p.cur)))
      .map((t) => {
        const d = ctx.dels.get(t.deliverableId!);
        return { taskId: t.id, title: t.title, client: d?.cycle.engagement.clientOrg.name ?? '', loggedHours: round1(t.timeLoggedMin / 60), estimateHours: estimate(d, t.flowStep), done: t.status === 'done', href: d ? deliverableHref(d.id) : '/team/tasks' };
      });
    return {
      projects,
      board,
      changes,
      links,
      qc,
      hours,
      totals: { loggedHours: round1(hours.reduce((s, h) => s + h.loggedHours, 0)), estimateHours: hours.reduce((s, h) => s + h.estimateHours, 0) },
    };
  }

  private devSummary(ctx: Ctx, p: CraftDevPanels, c: ReturnType<CraftService['commonKpis']>) {
    const web = this.madeBy(ctx).filter((d) => this.isWeb(d));
    const shipped = (r: Range) => web.filter((d) => inRange(this.approvedAt(d), r)).length;
    const firstPass = this.qcFirstPass(ctx, web);
    const openChanges = p.changes.filter((x) => !['done', 'declined'].includes(x.status));
    const usage = p.totals.estimateHours ? Math.round((p.totals.loggedHours / p.totals.estimateHours) * 100) : 0;
    const kpis: CraftKpi[] = [
      { key: 'shipped', label: 'Pages shipped', value: shipped(ctx.p.cur), previous: shipped(ctx.p.prev), format: 'int', hint: 'approved by the client' },
      { key: 'qc_first', label: 'QC first pass', value: firstPass.rate ?? 0, previous: firstPass.previous, format: 'pct', hint: firstPass.total ? `${firstPass.good} of ${firstPass.total} builds` : 'no QC yet' },
      { key: 'hours_vs', label: 'Hours vs estimate', value: usage, previous: null, format: 'pct', lowerIsBetter: true, hint: `${p.totals.loggedHours}h of ${p.totals.estimateHours}h` },
      { key: 'changes', label: 'Open change requests', value: openChanges.length, previous: null, format: 'int', lowerIsBetter: true, href: '/team/requests' },
      c.onTime,
    ];
    const insights = this.commonInsights(ctx, c);
    if (p.totals.estimateHours) insights.push(usage > 100 ? `Work in this period has taken ${usage}% of the estimate. Raise scope creep with the CM early.` : `You are at ${usage}% of the estimated hours on current and recent work.`);
    if (openChanges.length) insights.push(`${plural(openChanges.length, 'change request')} from clients ${openChanges.length === 1 ? 'is' : 'are'} open on your web projects${openChanges.some((x) => x.overdue) ? ', and at least one is past its reply time' : ''}.`);
    const failing = p.qc.filter((q) => q.result === 'fail');
    if (failing.length) insights.push(`${plural(failing.length, 'page')} failed the last QC check. Fix the flagged items before sending a new staging link.`);
    const noLink = p.links.filter((l) => !l.staging && l.canAdd);
    if (noLink.length) insights.push(`${plural(noLink.length, 'page')} ${noLink.length === 1 ? 'has' : 'have'} no staging link yet.`);
    return { kpis, insights };
  }

  /** Share of versions this person uploaded (in the range) that passed QC on the first check. */
  private qcFirstPass(ctx: Ctx, rows: DRow[]): CraftRate {
    const rate = (r: Range) => {
      const vs = rows.flatMap((d) => d.versions).filter((v) => v.uploadedById === ctx.target.id && v.qcResults.length && inRange(v.createdAt, r));
      const good = vs.filter((v) => v.qcResults[0].result === 'pass').length;
      return { good, total: vs.length, rate: pct(good, vs.length) };
    };
    const cur = rate(ctx.p.cur);
    return { ...cur, previous: rate(ctx.p.prev).rate };
  }

  // -------------------------------------------------------------------------
  // UX/UI designer

  private uxPhase(ctx: Ctx, d: DRow): string {
    const open = this.myTasksOn(ctx, d).find((t) => isOpen(t.status));
    const step = open?.flowStep ?? '';
    if (CRAFT_UX_PHASES.some((p) => p.key === step)) return step;
    if (step === 'design') return 'ui';
    if (LOCKED.includes(d.status)) return 'handoff';
    if (['in_qc', 'qc_passed', 'ready_for_client'].includes(d.status)) return 'prototype';
    return d.versions.length ? 'ui' : 'wireframe';
  }

  private async brandKits(ctx: Ctx, clientIds: string[]): Promise<CraftBrandKitView[]> {
    const ids = [...new Set(clientIds)].slice(0, 8);
    if (!ids.length) return [];
    const [clients, kits, files] = await Promise.all([
      this.prisma.clientOrg.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
      this.prisma.craftBrandKit.findMany({ where: { clientOrgId: { in: ids } } }),
      this.prisma.file.findMany({ where: { clientOrgId: { in: ids }, tags: { has: 'brand' } }, orderBy: { createdAt: 'desc' } }),
    ]);
    return clients.map((c) => this.brandView(c, kits.find((k) => k.clientOrgId === c.id) ?? null, files.filter((f) => f.clientOrgId === c.id)));
  }

  private brandView(
    c: { id: string; name: string },
    kit: { colours: string[]; fonts: string[]; notes: string | null; tone?: string | null; dos?: string[]; donts?: string[]; competitors?: string[]; updatedAt: Date } | null,
    files: { id: string; name: string | null; kind: string; path: string; createdAt: Date }[],
  ): CraftBrandKitView {
    return {
      clientId: c.id,
      client: c.name,
      colours: kit?.colours ?? [],
      fonts: kit?.fonts ?? [],
      notes: kit?.notes ?? null,
      tone: kit?.tone ?? null,
      dos: kit?.dos ?? [],
      donts: kit?.donts ?? [],
      competitors: kit?.competitors ?? [],
      files: files.map((f) => ({ id: f.id, name: f.name ?? 'file', kind: f.kind, url: f.kind === 'link' ? f.path : `/api/files/${f.id}`, at: f.createdAt.toISOString() })),
      updatedAt: kit?.updatedAt.toISOString() ?? null,
    };
  }

  private async uxPanels(ctx: Ctx): Promise<CraftUxPanels> {
    const active = this.activeDeliverables(ctx);
    const recentlyApproved = this.madeBy(ctx).filter((d) => LOCKED.includes(d.status) && (this.approvedAt(d)?.getTime() ?? 0) > ctx.now.getTime() - 30 * DAY);
    const handoffPending = recentlyApproved.filter((d) => this.checklist(ctx, d, 'handoff').done < this.checklist(ctx, d, 'handoff').total);
    const jobs = [...active, ...handoffPending].map((d) => this.job(ctx, d, this.uxPhase(ctx, d)));
    const phases = CRAFT_UX_PHASES.map((p) => ({ key: p.key as string, label: p.label as string, items: jobs.filter((j) => j.stage === p.key) }));
    const all = this.madeBy(ctx);
    return {
      phases,
      pins: this.openClientComments(ctx, (c) => !!c.anchor && 'x' in c.anchor).concat(this.openClientComments(ctx, (c) => !c.anchor)).slice(0, 30),
      compare: all.filter((d) => d.versions.length >= 2 && (!LOCKED.includes(d.status) || recentlyApproved.includes(d))).map((d) => ({ deliverableId: d.id, title: d.title, client: d.cycle.engagement.clientOrg.name, versions: d.versions.length, href: `/team/craft/compare/${d.id}` })),
      brand: await this.brandKits(ctx, [...active, ...handoffPending].map((d) => d.cycle.engagement.clientOrg.id)),
      handoff: [...active.filter((d) => this.makes(ctx, d) && ['prototype', 'handoff'].includes(this.uxPhase(ctx, d))), ...handoffPending].map((d) => this.checklist(ctx, d, 'handoff')),
      rounds: this.rounds(ctx, active),
      firstTime: this.firstTime(ctx, all),
    };
  }

  private uxSummary(ctx: Ctx, p: CraftUxPanels, c: ReturnType<CraftService['commonKpis']>) {
    const all = this.madeBy(ctx);
    const delivered = (r: Range) => all.filter((d) => inRange(this.approvedAt(d), r));
    const avgRounds = (r: Range) => avg(delivered(r).map((d) => d.revisionRoundsUsed));
    const kpis: CraftKpi[] = [
      { key: 'delivered', label: 'Design jobs approved', value: delivered(ctx.p.cur).length, previous: delivered(ctx.p.prev).length, format: 'int' },
      { key: 'first_time', label: 'First-time approval', value: p.firstTime.rate ?? 0, previous: p.firstTime.previous, format: 'pct', hint: p.firstTime.total ? `${p.firstTime.good} of ${p.firstTime.total}` : 'nothing approved yet' },
      { key: 'rounds', label: 'Avg revision rounds', value: avgRounds(ctx.p.cur) ?? 0, previous: avgRounds(ctx.p.prev), format: 'int', lowerIsBetter: true },
      { key: 'pins', label: 'Client pins to resolve', value: p.pins.length, previous: null, format: 'int', lowerIsBetter: true },
      c.onTime,
    ];
    const insights = this.commonInsights(ctx, c);
    if (p.firstTime.rate !== null) insights.push(`${p.firstTime.rate}% of your designs were approved without a revision round${p.firstTime.previous !== null ? ` (previous period ${p.firstTime.previous}%)` : ''}.`);
    if (p.pins.length) insights.push(`${plural(p.pins.length, 'pinned client comment')} ${p.pins.length === 1 ? 'is' : 'are'} open. Resolve each pin as you fix it so the client sees progress.`);
    const hand = p.handoff.filter((h) => h.done < h.total);
    if (hand.length) insights.push(`${plural(hand.length, 'design')} ${hand.length === 1 ? 'needs' : 'need'} the handoff checklist finished before developers pick ${hand.length === 1 ? 'it' : 'them'} up.`);
    const research = p.phases.find((x) => x.key === 'research');
    if (research?.items.length) insights.push(`${plural(research.items.length, 'job')} ${research.items.length === 1 ? 'is' : 'are'} in research. Lock the brief with the CM before wireframing.`);
    return { kpis, insights };
  }

  // -------------------------------------------------------------------------
  // Graphic designer

  private async graphicPanels(ctx: Ctx): Promise<CraftGraphicPanels> {
    const active = this.activeDeliverables(ctx);
    const order = { high: 0, normal: 1, low: 2 };
    const queue = active.map((d) => this.job(ctx, d, d.status)).sort((a, b) => order[a.priority] - order[b.priority] || (a.due ?? '9').localeCompare(b.due ?? '9'));
    const all = this.madeBy(ctx);
    // Daily output: versions uploaded per IST day over the last 14 days, and the working-day streak.
    const mineVersions = [...ctx.dels.values()].flatMap((d) => d.versions).filter((v) => v.uploadedById === ctx.target.id);
    const doneDays = new Set([...mineVersions.map((v) => istDate(v.createdAt)), ...ctx.tasks.filter((t) => t.status === 'done' && t.kind === 'work' && t.completedAt).map((t) => istDate(t.completedAt!))]);
    const daysList = Array.from({ length: 14 }, (_, i) => istDate(new Date(ctx.now.getTime() - (13 - i) * DAY)));
    const outputDays = daysList.map((date) => ({ date, count: mineVersions.filter((v) => istDate(v.createdAt) === date).length }));
    let streak = 0;
    for (let i = 0; i < 60; i++) {
      const d = new Date(ctx.now.getTime() - i * DAY);
      if (istDow(d) === 6) continue; // Sundays don't break a streak
      const key = istDate(d);
      if (doneDays.has(key)) streak++;
      else if (i === 0) continue; // today isn't over yet
      else break;
    }
    return {
      queue,
      firstPass: this.qcFirstPass(ctx, all),
      pins: this.openClientComments(ctx, (c) => !!c.anchor && 'x' in c.anchor).concat(this.openClientComments(ctx, (c) => !c.anchor)).slice(0, 30),
      brand: await this.brandKits(ctx, active.map((d) => d.cycle.engagement.clientOrg.id)),
      uploadable: active.filter((d) => this.canUpload(ctx, d)).map((d) => ({ id: d.id, title: d.title, client: d.cycle.engagement.clientOrg.name, status: d.status })),
      output: { days: outputDays, today: outputDays.at(-1)!.count, streak, best: Math.max(0, ...outputDays.map((d) => d.count)) },
      rounds: this.rounds(ctx, active),
    };
  }

  private graphicSummary(ctx: Ctx, p: CraftGraphicPanels, c: ReturnType<CraftService['commonKpis']>) {
    const all = this.madeBy(ctx);
    const delivered = (r: Range) => all.filter((d) => inRange(this.approvedAt(d), r)).length;
    const versionsIn = (r: Range) => all.flatMap((d) => d.versions).filter((v) => v.uploadedById === ctx.target.id && inRange(v.createdAt, r)).length;
    const kpis: CraftKpi[] = [
      { key: 'delivered', label: 'Designs approved', value: delivered(ctx.p.cur), previous: delivered(ctx.p.prev), format: 'int' },
      { key: 'first_pass', label: 'QC first pass', value: p.firstPass.rate ?? 0, previous: p.firstPass.previous, format: 'pct', hint: p.firstPass.total ? `${p.firstPass.good} of ${p.firstPass.total} versions` : 'no QC yet' },
      { key: 'output', label: 'Versions uploaded', value: versionsIn(ctx.p.cur), previous: versionsIn(ctx.p.prev), format: 'int', hint: `${p.output.today} today` },
      { key: 'streak', label: 'Working-day streak', value: p.output.streak, previous: null, format: 'int', hint: 'days in a row with output' },
      c.onTime,
    ];
    const insights = this.commonInsights(ctx, c);
    if (p.firstPass.rate !== null) insights.push(`${p.firstPass.rate}% of your versions passed QC first time${p.firstPass.previous !== null ? `, ${p.firstPass.rate >= p.firstPass.previous ? 'up' : 'down'} from ${p.firstPass.previous}%` : ''}. ${p.firstPass.rate < 70 ? 'Run the brand checklist before uploading.' : ''}`.trim());
    const high = p.queue.filter((j) => j.priority === 'high');
    if (high.length) insights.push(`${plural(high.length, 'design')} ${high.length === 1 ? 'needs' : 'need'} attention first (overdue, due within a day, or sent back with changes).`);
    if (p.output.streak >= 3) insights.push(`You have shipped work ${p.output.streak} working days in a row.`);
    if (p.pins.length) insights.push(`${plural(p.pins.length, 'client pin')} still to resolve.`);
    return { kpis, insights };
  }

  // -------------------------------------------------------------------------
  // Actions

  private async commentRow(me: Me, id: string) {
    const c = await this.prisma.comment.findFirst({ where: { id, orgId: me.orgId, targetType: 'version' } });
    if (!c) throw new NotFoundException('Comment not found');
    const v = await this.prisma.version.findUnique({ where: { id: c.targetId }, select: { deliverableId: true } });
    if (!v) throw new NotFoundException('Comment not found');
    return { c, deliverableId: v.deliverableId };
  }

  private async commentView(me: Me, id: string): Promise<CraftComment> {
    const { c, deliverableId } = await this.commentRow(me, id);
    const d = await this.prisma.deliverable.findUniqueOrThrow({ where: { id: deliverableId }, include: dInclude });
    const author = await this.prisma.user.findUnique({ where: { id: c.authorId }, select: { name: true, type: true } });
    const ctx = { dels: new Map([[d.id, d]]) } as Ctx;
    return this.comment(ctx, { ...c, author: author?.name ?? '', fromClient: author?.type === 'client' });
  }

  async setResolved(me: Me, id: string, resolved: boolean, ip?: string): Promise<CraftComment> {
    const { c, deliverableId } = await this.commentRow(me, id);
    await this.assertWorksOn(me, deliverableId);
    if (resolved && c.resolvedAt) throw new BadRequestException('Already resolved');
    await this.prisma.comment.update({ where: { id }, data: resolved ? { resolvedAt: new Date(), resolvedById: me.id } : { resolvedAt: null, resolvedById: null } });
    await this.audit.log(me, resolved ? 'comment.resolved' : 'comment.reopened', 'Comment', id, { resolvedAt: c.resolvedAt }, { resolved }, ip);
    return this.commentView(me, id);
  }

  async nudge(me: Me, deliverableId: string, message: string | undefined, ip?: string) {
    const d = await this.assertWorksOn(me, deliverableId);
    if (d.status !== 'ready_for_client') throw new BadRequestException('Only work that is waiting for the client can be nudged');
    const recent = await this.prisma.auditEvent.findFirst({ where: { orgId: me.orgId, action: 'craft.client_nudged', entity: 'Deliverable', entityId: d.id, at: { gte: new Date(Date.now() - DAY) } } });
    if (recent) throw new BadRequestException('This client was already reminded in the last 24 hours. Give them a day before nudging again.');
    const full = await this.prisma.deliverable.findUniqueOrThrow({ where: { id: d.id }, include: { versions: { orderBy: { number: 'desc' }, take: 1 }, cycle: { include: { engagement: { include: { clientOrg: true } } } } } });
    const client = full.cycle.engagement.clientOrg;
    const owner = await this.prisma.clientUser.findFirst({ where: { clientOrgId: client.id, clientRole: 'client_owner' }, include: { user: { select: { name: true } } } });
    const thread =
      (await this.prisma.thread.findFirst({ where: { clientOrgId: client.id, type: 'client_am' } })) ??
      (await this.prisma.thread.create({ data: { orgId: me.orgId, clientOrgId: client.id, type: 'client_am' } }));
    const first = owner?.user.name.split(' ')[0];
    const sent = full.versions[0]?.sentToClientAt;
    const body =
      message?.trim() ||
      `Hi${first ? ` ${first}` : ''}, a gentle reminder that "${full.title}" (version ${full.versions[0]?.number ?? 1}) has been ready for your review${sent ? ` since ${shortDay(sent)}` : ''}. When you have a moment, please approve it or leave comments on the exact spot to change, so we can keep your posting schedule on track. Thank you!`;
    const now = new Date();
    await this.prisma.message.create({ data: { orgId: me.orgId, threadId: thread.id, authorId: me.id, body, isInternal: false, createdAt: now } });
    await this.audit.log(me, 'craft.client_nudged', 'Deliverable', d.id, undefined, { threadId: thread.id }, ip);
    await this.audit.log(me, 'message.sent', 'Thread', thread.id, undefined, { internal: false, nudge: true }, ip);
    await this.notifications.notify(me.orgId, await this.notifications.clientDeciders(client.id), {
      kind: 'draft_ready',
      title: `Reminder: ${full.title} is waiting for your review`,
      body: body.slice(0, 140),
      link: `/client/reviews/${d.id}`,
    });
    await this.notifications.notify(me.orgId, [d.cycle.engagement.amId].filter((x) => x !== me.id), { kind: 'message', title: `${me.name} nudged ${client.name} about ${full.title}`, link: `/team/messages/${thread.id}` });
    return { ok: true as const, threadId: thread.id, at: now.toISOString() };
  }

  // Hooks library

  private async hookViews(orgId: string, userId: string): Promise<CraftHookView[]> {
    const rows = await this.prisma.craftHook.findMany({ where: { orgId, userId, deletedAt: null }, orderBy: [{ uses: 'desc' }, { createdAt: 'desc' }], take: 100 });
    const clients = await this.prisma.clientOrg.findMany({ where: { id: { in: rows.map((r) => r.clientOrgId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    return rows.map((h) => ({ id: h.id, text: h.text, tags: h.tags, client: clients.find((c) => c.id === h.clientOrgId)?.name ?? null, uses: h.uses, at: h.createdAt.toISOString() }));
  }

  async hooks(me: Me) {
    this.staffOnly(me);
    return this.hookViews(me.orgId, me.id);
  }

  async saveHook(me: Me, input: CraftHookInput, ip?: string) {
    this.staffOnly(me);
    if (input.clientOrgId && !(await this.prisma.clientOrg.findFirst({ where: { id: input.clientOrgId, orgId: me.orgId } }))) throw new BadRequestException('Unknown client');
    const dup = await this.prisma.craftHook.findFirst({ where: { orgId: me.orgId, userId: me.id, deletedAt: null, text: input.text } });
    if (dup) throw new BadRequestException('That hook is already in your library');
    const h = await this.prisma.craftHook.create({ data: { orgId: me.orgId, userId: me.id, text: input.text, tags: input.tags.map((t) => t.toLowerCase()), clientOrgId: input.clientOrgId } });
    await this.audit.log(me, 'craft.hook_saved', 'CraftHook', h.id, undefined, { text: h.text }, ip);
    return (await this.hookViews(me.orgId, me.id)).find((x) => x.id === h.id)!;
  }

  async useHook(me: Me, id: string) {
    this.staffOnly(me);
    const h = await this.prisma.craftHook.findFirst({ where: { id, orgId: me.orgId, userId: me.id, deletedAt: null } });
    if (!h) throw new NotFoundException('Hook not found');
    await this.prisma.craftHook.update({ where: { id }, data: { uses: { increment: 1 } } });
    return (await this.hookViews(me.orgId, me.id)).find((x) => x.id === id)!;
  }

  async deleteHook(me: Me, id: string, ip?: string) {
    this.staffOnly(me);
    const h = await this.prisma.craftHook.findFirst({ where: { id, orgId: me.orgId, userId: me.id, deletedAt: null } });
    if (!h) throw new NotFoundException('Hook not found');
    await this.prisma.craftHook.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log(me, 'craft.hook_deleted', 'CraftHook', id, { text: h.text }, undefined, ip);
    return { ok: true as const };
  }

  // Script drafts

  private async scriptViews(orgId: string, userId: string, id?: string): Promise<CraftScriptView[]> {
    const rows = await this.prisma.craftScript.findMany({ where: { orgId, authorId: userId, ...(id ? { id } : {}) }, orderBy: { updatedAt: 'desc' }, take: 50 });
    const dels = await this.prisma.deliverable.findMany({ where: { id: { in: rows.map((r) => r.deliverableId).filter((x): x is string => !!x) } }, select: { id: true, title: true } });
    return rows.map((s) => {
      const st = craftScriptStats(s.body);
      return { id: s.id, title: s.title, body: s.body, deliverableId: s.deliverableId, deliverableTitle: dels.find((d) => d.id === s.deliverableId)?.title ?? null, words: st.words, runtime: st.label, submittedVersionId: s.submittedVersionId, updatedAt: s.updatedAt.toISOString() };
    });
  }

  async scripts(me: Me) {
    this.staffOnly(me);
    return this.scriptViews(me.orgId, me.id);
  }

  private async assertScriptDeliverable(me: Me, deliverableId: string | null | undefined) {
    if (!deliverableId) return;
    const d = await this.prisma.deliverable.findFirst({ where: { id: deliverableId, orgId: me.orgId, tasks: { some: { ownerId: me.id } } } });
    if (!d) throw new BadRequestException('Link the script to a deliverable you are working on');
  }

  async createScript(me: Me, input: CraftScriptInput, ip?: string) {
    this.staffOnly(me);
    await this.assertScriptDeliverable(me, input.deliverableId);
    const s = await this.prisma.craftScript.create({ data: { orgId: me.orgId, authorId: me.id, title: input.title, body: input.body, deliverableId: input.deliverableId ?? null } });
    await this.audit.log(me, 'craft.script_created', 'CraftScript', s.id, undefined, { title: s.title }, ip);
    return (await this.scriptViews(me.orgId, me.id, s.id))[0];
  }

  async saveScript(me: Me, id: string, input: CraftScriptInput) {
    this.staffOnly(me);
    const s = await this.prisma.craftScript.findFirst({ where: { id, orgId: me.orgId, authorId: me.id } });
    if (!s) throw new NotFoundException('Script not found');
    await this.assertScriptDeliverable(me, input.deliverableId);
    await this.prisma.craftScript.update({ where: { id }, data: { title: input.title, body: input.body, deliverableId: input.deliverableId === undefined ? s.deliverableId : input.deliverableId } });
    return (await this.scriptViews(me.orgId, me.id, id))[0];
  }

  /** Marks the draft as submitted with the version the web app uploaded through the Review Studio endpoint. */
  async markScriptSubmitted(me: Me, id: string, versionId: string) {
    const s = await this.prisma.craftScript.findFirst({ where: { id, orgId: me.orgId, authorId: me.id } });
    if (!s) throw new NotFoundException('Script not found');
    const v = await this.prisma.version.findFirst({ where: { id: versionId, orgId: me.orgId, uploadedById: me.id, deliverableId: s.deliverableId ?? '__none__' } });
    if (!v) throw new BadRequestException('Version not found for this script');
    await this.prisma.craftScript.update({ where: { id }, data: { submittedVersionId: v.id } });
    return (await this.scriptViews(me.orgId, me.id, id))[0];
  }

  async scriptForSubmit(me: Me, id: string) {
    this.staffOnly(me);
    const s = await this.prisma.craftScript.findFirst({ where: { id, orgId: me.orgId, authorId: me.id } });
    if (!s) throw new NotFoundException('Script not found');
    if (!s.deliverableId) throw new BadRequestException('Link the script to a deliverable first');
    if (craftScriptStats(s.body).words < 5) throw new BadRequestException('Write the script before submitting it');
    return s;
  }

  // Checklists

  async saveChecklist(me: Me, deliverableId: string, kind: CraftChecklistKind, input: CraftChecklistInput, ip?: string): Promise<CraftChecklistView> {
    const d = await this.assertWorksOn(me, deliverableId);
    const items = input.items.map((i) => ({ label: i.label, done: i.done }));
    await this.prisma.craftChecklist.upsert({
      where: { deliverableId_kind: { deliverableId, kind } },
      update: { items, updatedById: me.id },
      create: { orgId: me.orgId, deliverableId, kind, items, updatedById: me.id },
    });
    await this.audit.log(me, 'craft.checklist_updated', 'Deliverable', deliverableId, undefined, { kind, done: items.filter((i) => i.done).length, total: items.length }, ip);
    const full = await this.prisma.deliverable.findUniqueOrThrow({ where: { id: d.id }, include: dInclude });
    const ctx = { dels: new Map([[d.id, full]]), checklists: new Map([[`${d.id}:${kind}`, items]]) } as Ctx;
    return this.checklist(ctx, full, kind);
  }

  // Brand kits

  private async assertClientAccess(me: Me, clientOrgId: string) {
    this.staffOnly(me);
    const client = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId, deletedAt: null }, select: { id: true, name: true, amUserId: true } });
    if (!client) throw new NotFoundException('Client not found');
    if (me.roles.some((r) => [...LEADS_ALL, 'department_head'].includes(r)) || client.amUserId === me.id) return client;
    const works = await this.prisma.task.count({ where: { ownerId: me.id, OR: [{ deliverable: { cycle: { engagement: { clientOrgId } } } }, { engagementId: { in: (await this.prisma.engagement.findMany({ where: { clientOrgId }, select: { id: true } })).map((e) => e.id) } }] } });
    if (!works) throw new ForbiddenException('You can only open brand kits of clients you work on');
    return client;
  }

  /** v16: the brand kit as a client sees it (their own account only; checked by the caller). */
  async brandKitView(clientOrgId: string): Promise<CraftBrandKitView> {
    const [client, kit, files] = await Promise.all([
      this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId }, select: { id: true, name: true } }),
      this.prisma.craftBrandKit.findUnique({ where: { clientOrgId } }),
      this.prisma.file.findMany({ where: { clientOrgId, tags: { has: 'brand' }, archivedAt: null }, orderBy: { createdAt: 'desc' } }),
    ]);
    return this.brandView(client, kit, files);
  }

  async brandKit(me: Me, clientOrgId: string): Promise<CraftBrandKitView> {
    const client = await this.assertClientAccess(me, clientOrgId);
    const [kit, files] = await Promise.all([
      this.prisma.craftBrandKit.findUnique({ where: { clientOrgId } }),
      this.prisma.file.findMany({ where: { clientOrgId, tags: { has: 'brand' } }, orderBy: { createdAt: 'desc' } }),
    ]);
    return this.brandView(client, kit, files);
  }

  async saveBrandKit(me: Me, clientOrgId: string, input: CraftBrandKitInput, ip?: string) {
    await this.assertClientAccess(me, clientOrgId);
    const colours = input.colours.map((c) => (/^[0-9a-fA-F]{3,8}$/.test(c) ? `#${c}` : c).toUpperCase());
    const before = await this.prisma.craftBrandKit.findUnique({ where: { clientOrgId } });
    // v16: tone, do and don't lists and competitors (left as they are when the form doesn't send them).
    const extra = {
      ...(input.tone !== undefined ? { tone: input.tone || null } : {}),
      ...(input.dos !== undefined ? { dos: input.dos } : {}),
      ...(input.donts !== undefined ? { donts: input.donts } : {}),
      ...(input.competitors !== undefined ? { competitors: input.competitors } : {}),
    };
    await this.prisma.craftBrandKit.upsert({
      where: { clientOrgId },
      update: { colours, fonts: input.fonts, notes: input.notes ?? null, ...extra, updatedById: me.id },
      create: { orgId: me.orgId, clientOrgId, colours, fonts: input.fonts, notes: input.notes ?? null, ...extra, updatedById: me.id },
    });
    await this.audit.log(me, 'craft.brand_kit_updated', 'ClientOrg', clientOrgId, before ? { colours: before.colours, fonts: before.fonts } : undefined, { colours, fonts: input.fonts }, ip);
    return this.brandKit(me, clientOrgId);
  }

  async addBrandFile(me: Me, clientOrgId: string, file: { path: string; originalname: string; mimetype: string; size: number } | undefined, storageRoot: string, ip?: string) {
    await this.assertClientAccess(me, clientOrgId);
    if (!file) throw new BadRequestException('Choose a file to upload');
    const kind = file.mimetype.startsWith('image/') ? 'image' : file.mimetype === 'application/pdf' ? 'pdf' : file.mimetype.startsWith('video/') ? 'video' : 'other';
    const f = await this.prisma.file.create({
      data: { orgId: me.orgId, clientOrgId, path: file.path.slice(storageRoot.length + 1), kind, name: file.originalname, mimeType: file.mimetype, sizeBytes: file.size, tags: ['brand'] },
    });
    await this.audit.log(me, 'craft.brand_file_added', 'ClientOrg', clientOrgId, undefined, { fileId: f.id, name: f.name }, ip);
    return this.brandKit(me, clientOrgId);
  }
}
