// v37 manual hand-off. When the client approves the plan, the deliverables' steps get no people automatically (only the
// Client Manager's client-review step). The Client Manager sends each deliverable to a Department Head with the
// requirements; the Department Head picks people from their own department for the making steps and a QC reviewer (or
// themselves) for QC, never the maker. Production starts (Gate 3) once every step has a person. A Department Head who
// has not assigned within a working day is reminded once, and the Client Manager is told. Later months of the same
// project reuse the same people (production/generate.ts).
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  addWorkingDays,
  handoffAssignSchema,
  handoffSendSchema,
  type HandoffDeliverable,
  type HandoffInbox,
  type HandoffOptions,
  type HandoffPerson,
  type HandoffStatus,
  type HandoffStep,
  type Me,
  type ProjectHandoffView,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { isLeadership } from '../engagements/engagement-access.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor, passGate3IfReady } from '../production/generate.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

/** Steps a Department Head fills (the client-review step is always the Client Manager's). */
const ASSIGNABLE = ['work', 'qc'];
const CLOSED = ['done', 'cancelled'];
const DONE_DELIVERABLE = ['approved', 'scheduled', 'published'];

const include = {
  tasks: { orderBy: { sort: 'asc' as const }, select: { id: true, title: true, flowStep: true, kind: true, ownerId: true, deadline: true, status: true } },
  cycle: { select: { engagement: { select: { id: true, amId: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } } } },
} satisfies Prisma.DeliverableInclude;
type Row = Prisma.DeliverableGetPayload<{ include: typeof include }>;

@Injectable()
export class HandoffService implements OnModuleInit, OnModuleDestroy {
  private job?: JobHandle;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'deliver.handoff_reminders', hint: 'Reminds Department Heads who have not picked their team for work sent to them', everyMs: 30 * 60_000, run: () => this.remind() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  // ------------------------------------------------------------------------------------------------ views

  private assertStaff(me: Me) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
  }

  private async headedDepartments(me: Me) {
    return (await this.prisma.department.findMany({ where: { orgId: me.orgId, headUserId: me.id, deletedAt: null }, select: { id: true } })).map((d) => d.id);
  }

  private status(d: Row): HandoffStatus {
    const open = d.tasks.filter((t) => ASSIGNABLE.includes(t.kind) && !CLOSED.includes(t.status));
    if (open.every((t) => !!t.ownerId)) return 'assigned';
    return d.handoffAt ? 'waiting' : 'not_sent';
  }

  private async views(me: Me, rows: Row[]): Promise<HandoffDeliverable[]> {
    const userIds = [...new Set(rows.flatMap((d) => [d.handoffHeadId, d.handoffById, d.cycle.engagement.amId, ...d.tasks.map((t) => t.ownerId)]).filter((x): x is string => !!x))];
    const deptIds = [...new Set(rows.map((d) => d.departmentId).filter((x): x is string => !!x))];
    const [users, depts, headed] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
      this.prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true, headUserId: true } }),
      this.headedDepartments(me),
    ]);
    const person = (id: string | null | undefined) => (id ? (users.find((u) => u.id === id) ?? { id, name: 'Someone' }) : null);
    const lead = isLeadership(me);
    return rows.map((d) => {
      const dept = depts.find((x) => x.id === d.departmentId) ?? null;
      const e = d.cycle.engagement;
      const status = this.status(d);
      const done = DONE_DELIVERABLE.includes(d.status) || !!d.archivedAt;
      return {
        id: d.id,
        title: d.title,
        type: d.type,
        deliverableStatus: d.status,
        dueAt: d.dueAt?.toISOString() ?? null,
        project: { id: e.id, client: e.clientOrg.name, service: e.service.name, cm: person(e.amId) },
        department: dept ? { id: dept.id, name: dept.name } : null,
        head: person(d.handoffHeadId ?? dept?.headUserId),
        status,
        sentAt: d.handoffAt?.toISOString() ?? null,
        sentBy: person(d.handoffById),
        note: d.handoffNote,
        assignedAt: d.handoffAssignedAt?.toISOString() ?? null,
        steps: d.tasks.map(
          (t): HandoffStep => ({
            taskId: t.id,
            key: t.flowStep,
            name: t.title.split(':')[0] || t.title,
            kind: t.kind as HandoffStep['kind'],
            owner: person(t.ownerId),
            deadline: t.deadline?.toISOString() ?? null,
            status: t.status,
          }),
        ),
        can: {
          send: !done && status !== 'assigned' && (lead || e.amId === me.id),
          assign: !done && (lead || (!!d.departmentId && headed.includes(d.departmentId))),
        },
      };
    });
  }

  /** The hand-off of one project: every deliverable of its current month, by department, with who is on each step. */
  async project(me: Me, engagementId: string): Promise<ProjectHandoffView> {
    this.assertStaff(me);
    const e = await this.prisma.engagement.findFirst({ where: { id: engagementId, orgId: me.orgId, deletedAt: null }, select: { id: true, amId: true } });
    if (!e) throw new NotFoundException('Project not found');
    const latest = await this.prisma.cycle.findFirst({ where: { engagementId }, orderBy: { period: 'desc' }, select: { id: true } });
    const rows = latest ? await this.prisma.deliverable.findMany({ where: { cycleId: latest.id }, include, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }] }) : [];
    const headed = await this.headedDepartments(me);
    const sender = isLeadership(me) || e.amId === me.id;
    if (!sender && !rows.some((d) => d.departmentId && headed.includes(d.departmentId))) throw new NotFoundException('Project not found');
    const depts = await this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null, headUserId: { not: null } }, select: { id: true, name: true, headUserId: true }, orderBy: { name: 'asc' } });
    const heads = await this.prisma.user.findMany({ where: { id: { in: depts.map((d) => d.headUserId!) } }, select: { id: true, name: true } });
    // A Department Head sees only their own department's deliverables of the project.
    const visible = sender ? rows : rows.filter((d) => d.departmentId && headed.includes(d.departmentId));
    return {
      engagementId,
      deliverables: await this.views(me, visible),
      departments: depts.map((d) => ({ id: d.id, name: d.name, head: heads.find((h) => h.id === d.headUserId) ?? null })),
      canSend: sender,
    };
  }

  /** The Work hand-off page: what this Department Head must assign; what this Client Manager is waiting for or has not sent. */
  async inbox(me: Me): Promise<HandoffInbox> {
    this.assertStaff(me);
    const headed = await this.headedDepartments(me);
    const lead = isLeadership(me);
    const live: Prisma.DeliverableWhereInput = { orgId: me.orgId, archivedAt: null, status: { notIn: DONE_DELIVERABLE as never }, tasks: { some: { kind: { in: ASSIGNABLE }, ownerId: null, status: { notIn: CLOSED as never } } } };
    const mine: Prisma.DeliverableWhereInput = lead ? {} : { cycle: { engagement: { amId: me.id } } };
    const sender = lead || (await this.prisma.engagement.count({ where: { orgId: me.orgId, amId: me.id, deletedAt: null } })) > 0;
    const [toAssign, waiting, notSent] = await Promise.all([
      headed.length ? this.prisma.deliverable.findMany({ where: { ...live, handoffAt: { not: null }, OR: [{ handoffHeadId: me.id }, { departmentId: { in: headed } }] }, include, orderBy: { handoffAt: 'asc' }, take: 200 }) : [],
      sender ? this.prisma.deliverable.findMany({ where: { ...live, ...mine, handoffAt: { not: null } }, include, orderBy: { handoffAt: 'asc' }, take: 200 }) : [],
      sender ? this.prisma.deliverable.findMany({ where: { ...live, ...mine, handoffAt: null }, include, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: 200 }) : [],
    ]);
    return { toAssign: await this.views(me, toAssign), waitingForHeads: await this.views(me, waiting), notSent: await this.views(me, notSent), isHead: headed.length > 0, isSender: sender };
  }

  // ------------------------------------------------------------------------------------------------ send

  /** The Client Manager sends deliverables (with the requirements) to their departments' heads. */
  async send(me: Me, engagementId: string, body: unknown, ip?: string): Promise<ProjectHandoffView> {
    this.assertStaff(me);
    const input = parse(handoffSendSchema, body);
    const e = await this.prisma.engagement.findFirst({ where: { id: engagementId, orgId: me.orgId, deletedAt: null }, select: { id: true, amId: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } });
    if (!e) throw new NotFoundException('Project not found');
    if (!isLeadership(me) && e.amId !== me.id) throw new ForbiddenException("Only the project's Client Manager (or the CM Lead) sends work to departments");
    const ids = [...new Set(input.items.map((i) => i.deliverableId))];
    const rows = await this.prisma.deliverable.findMany({ where: { id: { in: ids }, orgId: me.orgId, cycle: { engagementId } }, include });
    if (rows.length !== ids.length) throw new BadRequestException('Pick deliverables of this project');
    const depts = await this.prisma.department.findMany({ where: { id: { in: [...new Set(input.items.map((i) => i.departmentId))] }, orgId: me.orgId, deletedAt: null }, select: { id: true, name: true, headUserId: true } });
    const now = new Date();
    const byHead = new Map<string, string[]>();
    for (const item of input.items) {
      const d = rows.find((r) => r.id === item.deliverableId)!;
      if (DONE_DELIVERABLE.includes(d.status) || d.archivedAt) throw new BadRequestException(`"${d.title}" is already finished`);
      if (this.status(d) === 'assigned') throw new BadRequestException(`"${d.title}" already has its team`);
      const dept = depts.find((x) => x.id === item.departmentId);
      if (!dept) throw new BadRequestException('Department not found');
      if (!dept.headUserId) throw new BadRequestException(`${dept.name} has no Department Head yet. Set one in Admin → Departments & Teams.`);
      if (d.departmentId !== dept.id) {
        // Moved to another department: its open steps (not the Client Manager's review) go with it, without people.
        await this.prisma.task.updateMany({ where: { deliverableId: d.id, kind: { in: ASSIGNABLE }, status: { notIn: CLOSED as never } }, data: { departmentId: dept.id, ownerId: null } });
      }
      await this.prisma.deliverable.update({ where: { id: d.id }, data: { departmentId: dept.id, handoffHeadId: dept.headUserId, handoffById: me.id, handoffAt: now, handoffNote: input.note || null, handoffRemindedAt: null, handoffAssignedAt: null } });
      byHead.set(dept.headUserId, [...(byHead.get(dept.headUserId) ?? []), d.title]);
    }
    await this.audit.log(me, 'handoff.sent', 'Engagement', engagementId, undefined, { items: input.items, note: input.note ?? null }, ip);
    for (const [headId, titles] of byHead) {
      if (headId === me.id) continue;
      await this.notifications.notify(me.orgId, [headId], {
        kind: 'task_assigned',
        title: `${me.name} sent you work: ${e.clientOrg.name} · ${e.service.name}`,
        body: `${titles.length} deliverable${titles.length === 1 ? '' : 's'}: ${titles.slice(0, 3).join(', ')}${titles.length > 3 ? '…' : ''}.${input.note ? ` "${input.note.slice(0, 200)}"` : ''} Pick your team on Work hand-off.`,
        link: '/team/handoff',
      });
    }
    return this.project(me, engagementId);
  }

  // ------------------------------------------------------------------------------------------------ assign

  private async loadForHead(me: Me, deliverableId: string) {
    this.assertStaff(me);
    const d = await this.prisma.deliverable.findFirst({ where: { id: deliverableId, orgId: me.orgId }, include });
    if (!d) throw new NotFoundException('Deliverable not found');
    const headed = await this.headedDepartments(me);
    if (!isLeadership(me) && !(d.departmentId && headed.includes(d.departmentId))) throw new ForbiddenException("Only the deliverable's Department Head picks its team");
    if (!d.departmentId) throw new BadRequestException('This deliverable has no department yet. The Client Manager sends it to one first.');
    return d;
  }

  private async people(orgId: string, where: Prisma.UserWhereInput, why: (u: { id: string }) => string | null): Promise<HandoffPerson[]> {
    const today = new Date(`${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)}T00:00:00Z`);
    const rows = await this.prisma.user.findMany({ where: { orgId, type: 'staff', status: 'active', deletedAt: null, ...where }, select: { id: true, name: true, specialty: true }, orderBy: { name: 'asc' } });
    const ids = rows.map((u) => u.id);
    const [load, leave] = await Promise.all([
      this.prisma.task.groupBy({ by: ['ownerId'], where: { ownerId: { in: ids }, status: { in: ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] }, archivedAt: null }, _count: { _all: true } }),
      this.prisma.leaveRequest.findMany({ where: { userId: { in: ids }, status: 'approved', from: { lte: today }, to: { gte: today } }, select: { userId: true } }),
    ]);
    return rows.map((u) => ({ id: u.id, name: u.name, specialty: u.specialty, openTasks: load.find((l) => l.ownerId === u.id)?._count._all ?? 0, onLeaveToday: leave.some((l) => l.userId === u.id), why: why(u) }));
  }

  /** People the Department Head can put on the steps: their department for making; QC reviewers or themselves for QC. */
  async options(me: Me, deliverableId: string): Promise<HandoffOptions> {
    const d = await this.loadForHead(me, deliverableId);
    const head = (await this.prisma.department.findUnique({ where: { id: d.departmentId! }, select: { headUserId: true } }))?.headUserId ?? null;
    const [makers, qc] = await Promise.all([
      this.people(me.orgId, { departmentId: d.departmentId }, (u) => (u.id === head ? 'Department Head' : null)),
      this.people(me.orgId, { OR: [{ roles: { some: { role: { baseRole: 'qc_reviewer' } } } }, ...(head ? [{ id: head }] : [])] }, (u) => (u.id === head ? 'Department Head' : 'QC reviewer')),
    ]);
    return { makers, qc };
  }

  async assign(me: Me, deliverableId: string, body: unknown, ip?: string): Promise<HandoffDeliverable> {
    const d = await this.loadForHead(me, deliverableId);
    if (DONE_DELIVERABLE.includes(d.status) || d.archivedAt) throw new BadRequestException('This deliverable is already finished');
    const input = parse(handoffAssignSchema, body);
    const opts = await this.options(me, deliverableId);
    const owners = new Map(d.tasks.map((t) => [t.id, t.ownerId]));
    for (const s of input.steps) {
      const t = d.tasks.find((x) => x.id === s.taskId);
      if (!t) throw new BadRequestException('Pick steps of this deliverable');
      if (!ASSIGNABLE.includes(t.kind)) throw new BadRequestException('The client review is always the Client Manager\'s');
      if (CLOSED.includes(t.status)) throw new BadRequestException(`"${t.title}" is already finished`);
      const pool = t.kind === 'qc' ? opts.qc : opts.makers;
      if (!pool.some((p) => p.id === s.ownerId)) {
        throw new BadRequestException(t.kind === 'qc' ? 'QC goes to a QC reviewer or the Department Head' : 'Pick people from your own department');
      }
      owners.set(t.id, s.ownerId);
    }
    // QC is never done by the person who makes it.
    const makers = new Set(d.tasks.filter((t) => t.kind === 'work').map((t) => owners.get(t.id)).filter(Boolean));
    for (const t of d.tasks.filter((x) => x.kind === 'qc')) {
      const o = owners.get(t.id);
      if (o && makers.has(o)) throw new BadRequestException('QC must be done by someone other than the person making it');
    }
    const changed = input.steps.filter((s) => d.tasks.find((t) => t.id === s.taskId)?.ownerId !== s.ownerId);
    for (const s of changed) await this.prisma.task.update({ where: { id: s.taskId }, data: { ownerId: s.ownerId } });
    const allOwned = d.tasks.filter((t) => ASSIGNABLE.includes(t.kind) && !CLOSED.includes(t.status)).every((t) => !!owners.get(t.id));
    const now = new Date();
    await this.prisma.deliverable.update({
      where: { id: d.id },
      data: { handoffAssignedAt: allOwned ? (d.handoffAssignedAt ?? now) : null, handoffAt: d.handoffAt ?? now, handoffHeadId: d.handoffHeadId ?? me.id },
    });
    await this.audit.log(me, 'handoff.assigned', 'Deliverable', d.id, Object.fromEntries(d.tasks.map((t) => [t.id, t.ownerId])), Object.fromEntries(owners), ip);

    const e = d.cycle.engagement;
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set([...owners.values()].filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const stepName = (taskId: string) => (d.tasks.find((t) => t.id === taskId)?.title.split(':')[0] ?? 'A step').trim();
    const byPerson = new Map<string, string[]>();
    for (const s of changed) if (s.ownerId !== me.id) byPerson.set(s.ownerId, [...(byPerson.get(s.ownerId) ?? []), stepName(s.taskId)]);
    for (const [userId, steps] of byPerson) {
      await this.notifications.notify(me.orgId, [userId], { kind: 'task_assigned', title: `${me.name} put you on ${e.clientOrg.name}: ${d.title}`, body: `${steps.join(', ')} · ${e.service.name}.`, link: `/team/deliverables/${d.id}` });
    }
    if (changed.length && e.amId && e.amId !== me.id) {
      const team = d.tasks.filter((t) => ASSIGNABLE.includes(t.kind)).map((t) => `${stepName(t.id)}: ${owners.get(t.id) ? names.get(owners.get(t.id)!) : 'not picked yet'}`);
      await this.notifications.notify(me.orgId, [e.amId], { kind: 'task_assigned', title: `${me.name} ${allOwned ? 'assigned the team for' : 'started picking the team for'} ${d.title}`, body: `${e.clientOrg.name} · ${team.join(' · ')}`, link: `/team/projects/${e.id}` });
    }
    // Production starts once every step of the project has its person.
    if (allOwned && (await passGate3IfReady(this.prisma, e.id, now))) {
      await this.audit.logSystem(me.orgId, 'gate.G3.passed', 'Engagement', e.id, { reason: 'every step assigned' });
      await this.notifications.notify(me.orgId, [e.amId], { kind: 'production_released', title: `Production started: ${e.clientOrg.name} · ${e.service.name}`, body: 'Every step now has a person.', link: `/team/projects/${e.id}` });
    }
    const fresh = await this.prisma.deliverable.findUniqueOrThrow({ where: { id: d.id }, include });
    return (await this.views(me, [fresh]))[0];
  }

  // ------------------------------------------------------------------------------------------------ reminder

  /** Work sent to a Department Head and still without its people after a working day: remind once, tell the CM. */
  async remind(now = new Date()) {
    const due = await this.prisma.deliverable.findMany({
      where: { handoffAt: { not: null, lte: new Date(now.getTime() - 20 * 3_600_000) }, handoffAssignedAt: null, handoffRemindedAt: null, archivedAt: null, status: { notIn: DONE_DELIVERABLE as never } },
      include,
      take: 100,
    });
    const calendars = new Map<string, Awaited<ReturnType<typeof calendarFor>>>();
    let sent = 0;
    for (const d of due) {
      if (this.status(d) === 'assigned') {
        await this.prisma.deliverable.update({ where: { id: d.id }, data: { handoffAssignedAt: now } });
        continue;
      }
      if (!calendars.has(d.orgId)) calendars.set(d.orgId, await calendarFor(this.prisma, d.orgId));
      if (addWorkingDays(d.handoffAt!, 1, calendars.get(d.orgId)!).getTime() > now.getTime()) continue;
      const claimed = await this.prisma.deliverable.updateMany({ where: { id: d.id, handoffRemindedAt: null }, data: { handoffRemindedAt: now } });
      if (!claimed.count) continue;
      const e = d.cycle.engagement;
      const head = d.handoffHeadId ?? (d.departmentId ? (await this.prisma.department.findUnique({ where: { id: d.departmentId }, select: { headUserId: true } }))?.headUserId : null);
      if (head) await this.notifications.notify(d.orgId, [head], { kind: 'task_assigned', title: `Reminder: pick the team for ${d.title}`, body: `${e.clientOrg.name} · ${e.service.name}. Sent to you a working day ago.`, link: '/team/handoff', critical: true });
      const headName = head ? (await this.prisma.user.findUnique({ where: { id: head }, select: { name: true } }))?.name : null;
      if (e.amId) await this.notifications.notify(d.orgId, [e.amId], { kind: 'task_assigned', title: `${headName ?? 'The Department Head'} has not picked the team for ${d.title} yet`, body: `${e.clientOrg.name} · ${e.service.name}. We reminded them.`, link: `/team/projects/${e.id}` });
      sent++;
    }
    return sent;
  }
}
