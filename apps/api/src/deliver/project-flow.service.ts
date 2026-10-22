// v40 project flow.
// 1. The Client Manager asks one or more Department Heads when their department will finish the project's work.
// 2. Each Department Head talks to the team and gives a finish date; the Client Manager is told.
// 3. The Client Manager shares the dates with the client (to inform them; no approval needed). The heads assign the work
//    on Work hand-off, with hours per step (those hours fill each person's 45h week on Workload).
// v41 (simpler): the request carries the requirement documents, and Department Heads give tasks to their team straight
//    from the project page (title, person, hours, deadline), including the plan's steps; no Work hand-off needed.
// 4. When a big part is finished (login page, product design, first video draft) the Department Head shares it with the
//    client as a demo link or files. The client approves it or asks for changes, which become a task for the head.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  addWorkingDays,
  estimateRequestSchema,
  estimateSubmitSchema,
  fileKindFromMime,
  milestoneCreateSchema,
  milestoneDecisionSchema,
  projectTaskAssignSchema,
  projectTaskCreateSchema,
  sentLinkName,
  sentLinkSchema,
  type ClientProgressView,
  type EstimateInboxRow,
  type EstimateStatus,
  type Me,
  type MilestoneStatus,
  type ProjectEstimateRow,
  type ProjectFlowView,
  type ProjectMilestoneRow,
  type ProjectTaskRow,
  type SentFile,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { isLeadership } from '../engagements/engagement-access.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { relPath, sha256, type OpsUpload } from '../ops-actions/ops-util.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor, passGate3IfReady } from '../production/generate.js';

type Estimate = Awaited<ReturnType<PrismaService['projectEstimate']['findMany']>>[number];
type Milestone = Awaited<ReturnType<PrismaService['projectMilestone']['findMany']>>[number];

const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
/** IST calendar date of a timestamp. */
const istYmd = (d: Date | null) => (d ? new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10) : null);
const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'];
/** Tags of files staged on the project page: requirement documents (v41) and demos of finished parts (v40). */
const STAGE_TAG = { brief: 'project-brief', milestone: 'milestone' } as const;

@Injectable()
export class ProjectFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private assertStaff(me: Me) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
  }

  private async headed(me: Me) {
    return this.prisma.department.findMany({ where: { orgId: me.orgId, headUserId: me.id, deletedAt: null }, select: { id: true, name: true } });
  }

  private async project(me: Me, engagementId: string) {
    const e = await this.prisma.engagement.findFirst({
      where: { id: engagementId, orgId: me.orgId, deletedAt: null },
      select: { id: true, amId: true, clientOrgId: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } },
    });
    if (!e) throw new NotFoundException('Project not found');
    return e;
  }

  /** The project's Client Manager, or leadership. */
  private isSender(me: Me, e: { amId: string | null }) {
    return isLeadership(me) || e.amId === me.id;
  }

  private async clientUserIds(clientOrgId: string) {
    return (await this.prisma.clientUser.findMany({ where: { clientOrgId }, select: { userId: true } })).map((c) => c.userId);
  }

  // ------------------------------------------------------------------------------------------------ views

  private estimateStatus(e: Estimate): EstimateStatus {
    return e.sharedAt ? 'shared' : e.finishBy ? 'estimated' : 'waiting';
  }

  private async estimateRows(me: Me, rows: Estimate[], sender: boolean): Promise<ProjectEstimateRow[]> {
    const docIds = [...new Set(rows.flatMap((r) => r.docFileIds))];
    const [depts, users, headed, docs] = await Promise.all([
      this.prisma.department.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.departmentId))] } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.headId, r.requestedById]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
      this.headed(me),
      docIds.length ? this.prisma.file.findMany({ where: { id: { in: docIds } }, select: { id: true, name: true, kind: true, path: true, mimeType: true } }) : [],
    ]);
    const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? null) : null);
    return rows.map((r) => ({
      id: r.id,
      department: { id: r.departmentId, name: depts.find((d) => d.id === r.departmentId)?.name ?? 'Department' },
      head: r.headId ? { id: r.headId, name: name(r.headId) ?? 'Department Head' } : null,
      requestedBy: name(r.requestedById),
      requestNote: r.requestNote,
      docs: r.docFileIds
        .map((id) => docs.find((f) => f.id === id))
        .filter((f): f is NonNullable<typeof f> => !!f)
        .map((f) => ({ id: f.id, name: f.name ?? 'file', url: f.kind === 'link' ? f.path : `/api/files/${f.id}`, kind: f.kind, mimeType: f.mimeType })),
      requestedAt: r.requestedAt.toISOString(),
      finishBy: ymd(r.finishBy),
      headNote: r.headNote,
      estimatedAt: r.estimatedAt?.toISOString() ?? null,
      sharedAt: r.sharedAt?.toISOString() ?? null,
      status: this.estimateStatus(r),
      can: { estimate: isLeadership(me) || headed.some((d) => d.id === r.departmentId), share: sender && !!r.finishBy },
    }));
  }

  private async milestoneRows(rows: Milestone[]): Promise<ProjectMilestoneRow[]> {
    const fileIds = [...new Set(rows.flatMap((m) => m.fileIds))];
    const [files, depts, users] = await Promise.all([
      fileIds.length ? this.prisma.file.findMany({ where: { id: { in: fileIds } }, select: { id: true, name: true, kind: true, path: true, mimeType: true } }) : [],
      this.prisma.department.findMany({ where: { id: { in: [...new Set(rows.map((m) => m.departmentId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((m) => [m.sharedById, m.decidedById]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
    ]);
    const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? null) : null);
    return rows.map((m) => ({
      id: m.id,
      title: m.title,
      note: m.note,
      department: m.departmentId ? { id: m.departmentId, name: depts.find((d) => d.id === m.departmentId)?.name ?? 'Department' } : null,
      sharedBy: name(m.sharedById),
      sharedAt: m.sharedAt.toISOString(),
      status: m.status as MilestoneStatus,
      files: m.fileIds
        .map((id) => files.find((f) => f.id === id))
        .filter((f): f is NonNullable<typeof f> => !!f)
        .map((f) => ({ id: f.id, name: f.name ?? 'file', url: f.kind === 'link' ? f.path : `/api/files/${f.id}`, kind: f.kind, mimeType: f.mimeType })),
      clientComment: m.clientComment,
      decidedAt: m.decidedAt?.toISOString() ?? null,
      decidedBy: name(m.decidedById),
      changeTaskId: m.changeTaskId,
    }));
  }

  async view(me: Me, engagementId: string): Promise<ProjectFlowView> {
    this.assertStaff(me);
    const e = await this.project(me, engagementId);
    const sender = this.isSender(me, e);
    const [estimates, milestones, depts, headed] = await Promise.all([
      this.prisma.projectEstimate.findMany({ where: { engagementId }, orderBy: { requestedAt: 'asc' } }),
      this.prisma.projectMilestone.findMany({ where: { engagementId }, orderBy: { sharedAt: 'desc' } }),
      this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null, headUserId: { not: null } }, select: { id: true, name: true, headUserId: true }, orderBy: { name: 'asc' } }),
      this.headed(me),
    ]);
    const heads = await this.prisma.user.findMany({ where: { id: { in: depts.map((d) => d.headUserId!) } }, select: { id: true, name: true } });
    const shareFor = isLeadership(me) ? depts.map((d) => ({ id: d.id, name: d.name })) : headed;
    return {
      tasks: await this.taskRows(engagementId),
      teams: await this.teams(me.orgId, isLeadership(me) ? [] : headed.map((d) => d.id), me.id),
      engagementId,
      client: e.clientOrg.name,
      service: e.service.name,
      estimates: await this.estimateRows(me, estimates, sender),
      milestones: await this.milestoneRows(milestones),
      departments: depts.map((d) => ({ id: d.id, name: d.name, head: heads.find((h) => h.id === d.headUserId) ?? null })),
      can: { request: sender, shareFor },
    };
  }

  /** The project's tasks: open ones, and those finished in the last 30 days (made by departments, not client review). */
  private async taskRows(engagementId: string): Promise<ProjectTaskRow[]> {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await this.prisma.task.findMany({
      where: {
        archivedAt: null,
        isDraft: false,
        kind: { in: ['work', 'qc'] },
        AND: [{ OR: [{ engagementId }, { deliverable: { cycle: { engagementId } } }] }, { OR: [{ status: { in: OPEN_TASK as never } }, { status: 'done', completedAt: { gte: since } }] }],
      },
      select: { id: true, title: true, departmentId: true, ownerId: true, estimateMin: true, deadline: true, status: true, deliverableId: true },
      orderBy: [{ deadline: 'asc' }, { createdAt: 'asc' }],
      take: 300,
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((t) => t.ownerId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      departmentId: t.departmentId,
      owner: t.ownerId ? (users.find((u) => u.id === t.ownerId) ?? { id: t.ownerId, name: 'Someone' }) : null,
      hours: t.estimateMin ? Math.round((t.estimateMin / 60) * 10) / 10 : null,
      deadline: istYmd(t.deadline),
      status: t.status,
      fromPlan: !!t.deliverableId,
    }));
  }

  /** People a Department Head can give tasks to: their department's team and themselves, with their open task hours. */
  private async teams(orgId: string, deptIds: string[], headId: string) {
    if (!deptIds.length) return [];
    const today = new Date(`${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)}T00:00:00Z`);
    const people = await this.prisma.user.findMany({ where: { orgId, type: 'staff', status: 'active', deletedAt: null, OR: [{ departmentId: { in: deptIds } }, { id: headId }] }, select: { id: true, name: true, departmentId: true }, orderBy: { name: 'asc' } });
    const ids = people.map((p) => p.id);
    const [load, leave] = await Promise.all([
      this.prisma.task.groupBy({ by: ['ownerId'], where: { ownerId: { in: ids }, status: { in: OPEN_TASK as never }, archivedAt: null }, _sum: { estimateMin: true } }),
      this.prisma.leaveRequest.findMany({ where: { userId: { in: ids }, status: 'approved', type: { not: 'wfh' }, from: { lte: today }, to: { gte: today } }, select: { userId: true } }),
    ]);
    return deptIds.map((d) => ({
      departmentId: d,
      people: people
        .filter((p) => p.departmentId === d || p.id === headId)
        .map((p) => ({ id: p.id, name: p.name, openHours: Math.round(((load.find((l) => l.ownerId === p.id)?._sum.estimateMin ?? 0) / 60) * 10) / 10, onLeaveToday: leave.some((l) => l.userId === p.id) })),
    }));
  }

  /** The person must be in the head's team for that department (or the head); leadership may pick anyone in it. */
  private async assertTeamMember(me: Me, departmentId: string, ownerId: string) {
    const headed = await this.headed(me);
    if (!isLeadership(me) && !headed.some((d) => d.id === departmentId)) throw new ForbiddenException('Only the Department Head gives tasks to their team');
    const u = await this.prisma.user.findFirst({ where: { id: ownerId, orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null }, select: { id: true, name: true, departmentId: true } });
    if (!u || (u.departmentId !== departmentId && u.id !== me.id)) throw new BadRequestException('Pick someone from your department');
    return u;
  }

  /** v41: the Department Head adds a task for someone in their team on this project. */
  async addTask(me: Me, engagementId: string, body: unknown, ip?: string) {
    this.assertStaff(me);
    const input = parse(projectTaskCreateSchema, body);
    const e = await this.project(me, engagementId);
    const owner = await this.assertTeamMember(me, input.departmentId, input.ownerId);
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    if (input.deadline < today) throw new BadRequestException('The deadline is in the past');
    const t = await this.prisma.task.create({
      data: {
        orgId: me.orgId,
        title: input.title,
        description: input.note || null,
        engagementId,
        departmentId: input.departmentId,
        ownerId: owner.id,
        createdById: me.id,
        estimateMin: Math.round(input.hours * 60),
        // 6 pm IST on the deadline day
        deadline: new Date(`${input.deadline}T12:30:00Z`),
        kind: 'work',
        status: 'todo',
      },
    });
    await this.audit.log(me, 'task.created', 'Task', t.id, undefined, { title: t.title, ownerId: owner.id, engagementId, hours: input.hours, deadline: input.deadline, source: 'project_page' }, ip);
    if (owner.id !== me.id) {
      await this.notifications.notify(me.orgId, [owner.id], { kind: 'task_assigned', title: `${me.name} gave you a task: ${t.title}`, body: `${e.clientOrg.name} · ${e.service.name} · ${input.hours}h · due ${input.deadline}`, link: `/team/tasks/${t.id}` });
    }
    return this.view(me, engagementId);
  }

  /** v41: the Department Head gives a task of the project (e.g. a step from the approved plan) a person and hours. */
  async assignTask(me: Me, taskId: string, body: unknown, ip?: string) {
    this.assertStaff(me);
    const input = parse(projectTaskAssignSchema, body);
    const t = await this.prisma.task.findFirst({
      where: { id: taskId, orgId: me.orgId, archivedAt: null },
      select: { id: true, title: true, ownerId: true, departmentId: true, kind: true, status: true, engagementId: true, deliverableId: true, deliverable: { select: { cycle: { select: { engagementId: true } }, tasks: { select: { id: true, kind: true, ownerId: true } } } } },
    });
    if (!t) throw new NotFoundException('Task not found');
    const engagementId = t.engagementId ?? t.deliverable?.cycle.engagementId;
    if (!engagementId) throw new BadRequestException('This task is not on a project');
    if (!t.departmentId) throw new BadRequestException('This task has no department yet');
    if (!OPEN_TASK.includes(t.status)) throw new BadRequestException('This task is already finished');
    if (!['work', 'qc'].includes(t.kind)) throw new BadRequestException("The client review is the Client Manager's");
    const owner = await this.assertTeamMember(me, t.departmentId, input.ownerId);
    // QC is never done by the person who made it.
    const others = t.deliverable?.tasks.filter((x) => x.id !== t.id) ?? [];
    if (t.kind === 'qc' && others.some((x) => x.kind === 'work' && x.ownerId === owner.id)) throw new BadRequestException('QC must be done by someone other than the person making it');
    if (t.kind === 'work' && others.some((x) => x.kind === 'qc' && x.ownerId === owner.id)) throw new BadRequestException('This person does the QC of this work; pick someone else');
    await this.prisma.task.update({ where: { id: t.id }, data: { ownerId: owner.id, estimateMin: Math.round(input.hours * 60) } });
    await this.audit.log(me, 'task.assigned', 'Task', t.id, { ownerId: t.ownerId }, { ownerId: owner.id, hours: input.hours, source: 'project_page' }, ip);
    const e = await this.project(me, engagementId);
    if (owner.id !== me.id && owner.id !== t.ownerId) {
      await this.notifications.notify(me.orgId, [owner.id], { kind: 'task_assigned', title: `${me.name} gave you a task: ${t.title}`, body: `${e.clientOrg.name} · ${e.service.name} · ${input.hours}h`, link: `/team/tasks/${t.id}` });
    }
    // A plan's steps all have a person: production starts (Gate 3).
    if (t.deliverableId && (await passGate3IfReady(this.prisma, engagementId))) {
      await this.audit.logSystem(me.orgId, 'gate.G3.passed', 'Engagement', engagementId, { reason: 'every step assigned' });
      if (e.amId) await this.notifications.notify(me.orgId, [e.amId], { kind: 'production_released', title: `Production started: ${e.clientOrg.name} · ${e.service.name}`, body: 'Every step now has a person.', link: `/team/projects/${engagementId}` });
    }
    return this.view(me, engagementId);
  }

  // ------------------------------------------------------------------------------------------------ estimates

  /** The Client Manager asks Department Heads for their finish date (asking again resets the date). */
  async requestEstimates(me: Me, engagementId: string, body: unknown, ip?: string) {
    this.assertStaff(me);
    const input = parse(estimateRequestSchema, body);
    const e = await this.project(me, engagementId);
    if (!this.isSender(me, e)) throw new ForbiddenException("Only the project's Client Manager (or leadership) asks Department Heads for dates");
    const depts = await this.prisma.department.findMany({ where: { id: { in: [...new Set(input.departmentIds)] }, orgId: me.orgId, deletedAt: null }, select: { id: true, name: true, headUserId: true } });
    if (depts.length !== new Set(input.departmentIds).size) throw new BadRequestException('Department not found');
    const noHead = depts.find((d) => !d.headUserId);
    if (noHead) throw new BadRequestException(`${noHead.name} has no Department Head yet. Set one in Admin → Departments & Teams.`);
    // v41: requirement documents this person staged for the project.
    const docIds = [...new Set(input.fileIds)];
    if (docIds.length && (await this.prisma.file.count({ where: { id: { in: docIds }, orgId: me.orgId, engagementId, tags: { has: STAGE_TAG.brief } } })) !== docIds.length) {
      throw new BadRequestException('One of the documents could not be found. Add it again.');
    }
    const now = new Date();
    for (const d of depts) {
      const reset = { headId: d.headUserId, requestedById: me.id, requestNote: input.note || null, docFileIds: docIds, requestedAt: now, finishBy: null, headNote: null, estimatedAt: null, estimatedById: null, sharedAt: null, sharedById: null };
      await this.prisma.projectEstimate.upsert({ where: { engagementId_departmentId: { engagementId, departmentId: d.id } }, create: { orgId: me.orgId, engagementId, departmentId: d.id, ...reset }, update: reset });
      if (d.headUserId && d.headUserId !== me.id) {
        await this.notifications.notify(me.orgId, [d.headUserId], {
          kind: 'estimate_requested',
          title: `${me.name} needs your finish date: ${e.clientOrg.name} · ${e.service.name}`,
          body: `Read the requirements${docIds.length ? ` (${docIds.length} document${docIds.length === 1 ? '' : 's'})` : ''}, talk to your team and give the date ${d.name} will finish this work.${input.note ? ` "${input.note.slice(0, 200)}"` : ''}`,
          link: `/team/projects/${engagementId}`,
        });
      }
    }
    await this.audit.log(me, 'estimate.requested', 'Engagement', engagementId, undefined, { departments: depts.map((d) => d.name), note: input.note ?? null, documents: docIds.length }, ip);
    return this.view(me, engagementId);
  }

  /** The Department Head gives the date their department will finish (the Client Manager is told). */
  async submitEstimate(me: Me, id: string, body: unknown, ip?: string) {
    this.assertStaff(me);
    const input = parse(estimateSubmitSchema, body);
    const row = await this.prisma.projectEstimate.findFirst({ where: { id, orgId: me.orgId } });
    if (!row) throw new NotFoundException('Request not found');
    const headed = await this.headed(me);
    if (!isLeadership(me) && !headed.some((d) => d.id === row.departmentId)) throw new ForbiddenException("Only the department's head gives its finish date");
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    if (input.finishBy < today) throw new BadRequestException('The finish date is in the past');
    await this.prisma.projectEstimate.update({
      where: { id },
      data: { finishBy: new Date(`${input.finishBy}T00:00:00Z`), headNote: input.note || null, estimatedAt: new Date(), estimatedById: me.id, sharedAt: null, sharedById: null },
    });
    await this.audit.log(me, 'estimate.given', 'Engagement', row.engagementId, { finishBy: ymd(row.finishBy) }, { finishBy: input.finishBy, note: input.note ?? null }, ip);
    const e = await this.project(me, row.engagementId);
    const dept = await this.prisma.department.findUnique({ where: { id: row.departmentId }, select: { name: true } });
    const to = [...new Set([e.amId, row.requestedById].filter((x): x is string => !!x && x !== me.id))];
    if (to.length) {
      await this.notifications.notify(me.orgId, to, {
        kind: 'estimate_given',
        title: `${dept?.name ?? 'The department'} will finish by ${input.finishBy}: ${e.clientOrg.name}`,
        body: `${me.name} gave the date for ${e.service.name}.${input.note ? ` "${input.note.slice(0, 200)}"` : ''} Share it with the client on the project page.`,
        link: `/team/projects/${row.engagementId}`,
      });
    }
    return this.view(me, row.engagementId);
  }

  /** The Client Manager shares the finish dates with the client (to inform them). */
  async shareEstimates(me: Me, engagementId: string, body: unknown, ip?: string) {
    this.assertStaff(me);
    const raw = (body as { ids?: unknown } | null)?.ids;
    const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    const e = await this.project(me, engagementId);
    if (!this.isSender(me, e)) throw new ForbiddenException("Only the project's Client Manager (or leadership) shares dates with the client");
    const rows = await this.prisma.projectEstimate.findMany({ where: { engagementId, finishBy: { not: null }, ...(ids.length ? { id: { in: ids } } : {}) } });
    if (!rows.length) throw new BadRequestException('No finish dates to share yet');
    const now = new Date();
    await this.prisma.projectEstimate.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { sharedAt: now, sharedById: me.id } });
    const depts = await this.prisma.department.findMany({ where: { id: { in: rows.map((r) => r.departmentId) } }, select: { id: true, name: true } });
    const lines = rows.map((r) => `${depts.find((d) => d.id === r.departmentId)?.name ?? 'Team'}: ${ymd(r.finishBy)}`);
    await this.notifications.notify(me.orgId, await this.clientUserIds(e.clientOrgId), { kind: 'estimate_shared', title: `Expected finish dates for ${e.service.name}`, body: lines.join(' · '), link: '/client/progress' });
    await this.audit.log(me, 'estimate.shared', 'Engagement', engagementId, undefined, { dates: lines }, ip);
    return this.view(me, engagementId);
  }

  /** A Department Head's date requests that still need a date. */
  async inbox(me: Me): Promise<EstimateInboxRow[]> {
    this.assertStaff(me);
    const headed = await this.headed(me);
    if (!headed.length) return [];
    const rows = await this.prisma.projectEstimate.findMany({ where: { orgId: me.orgId, departmentId: { in: headed.map((d) => d.id) }, finishBy: null }, orderBy: { requestedAt: 'asc' }, take: 100 });
    const views = await this.estimateRows(me, rows, false);
    const engs = await this.prisma.engagement.findMany({ where: { id: { in: rows.map((r) => r.engagementId) } }, select: { id: true, amId: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } });
    const cms = await this.prisma.user.findMany({ where: { id: { in: engs.map((x) => x.amId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    return views.map((v, i) => {
      const e = engs.find((x) => x.id === rows[i].engagementId);
      return { ...v, project: { id: rows[i].engagementId, client: e?.clientOrg.name ?? '', service: e?.service.name ?? '', cm: cms.find((c) => c.id === e?.amId)?.name ?? null } };
    });
  }

  // ------------------------------------------------------------------------------------------------ finished parts

  private async assertCanShare(me: Me, departmentId: string) {
    if (isLeadership(me)) return;
    const headed = await this.headed(me);
    if (!headed.some((d) => d.id === departmentId)) throw new ForbiddenException("Only the Department Head shares their department's finished parts");
  }

  /** A file for the project page: a requirement document (v41) or a demo of a finished part (only its uploader sees it until it is sent). */
  async stageFile(me: Me, engagementId: string, file: OpsUpload | undefined, ip?: string, purpose: keyof typeof STAGE_TAG = 'milestone'): Promise<SentFile> {
    this.assertStaff(me);
    if (!file) throw new BadRequestException('Choose a file');
    const e = await this.project(me, engagementId);
    const f = await this.prisma.file.create({
      data: { orgId: me.orgId, clientOrgId: e.clientOrgId, engagementId, path: relPath(file.path), kind: fileKindFromMime(file.mimetype), name: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, checksum: await sha256(file.path), folder: 'general', tags: [STAGE_TAG[purpose]], uploadedById: me.id },
    });
    await this.audit.log(me, `${purpose}.file_staged`, 'File', f.id, undefined, { name: f.name, engagementId }, ip);
    return { id: f.id, name: f.name ?? 'file', url: `/api/files/${f.id}`, mimeType: f.mimeType, sizeBytes: f.sizeBytes, kind: f.kind };
  }

  /** A link for the project page: a requirement document (v41) or a demo (staging site, Figma, Drive) of a finished part. */
  async stageLink(me: Me, engagementId: string, body: unknown, ip?: string, purpose: keyof typeof STAGE_TAG = 'milestone'): Promise<SentFile> {
    this.assertStaff(me);
    const input = parse(sentLinkSchema, body);
    const e = await this.project(me, engagementId);
    const f = await this.prisma.file.create({ data: { orgId: me.orgId, clientOrgId: e.clientOrgId, engagementId, path: input.url, kind: 'link', name: (input.name || sentLinkName(input.url)).slice(0, 200), folder: 'general', tags: [STAGE_TAG[purpose]], uploadedById: me.id } });
    await this.audit.log(me, `${purpose}.link_staged`, 'File', f.id, undefined, { name: f.name, engagementId }, ip);
    return { id: f.id, name: f.name ?? 'link', url: f.path, mimeType: null, sizeBytes: null, kind: 'link' };
  }

  /** The Department Head shares a finished part with the client (and the Client Manager is told). */
  async shareMilestone(me: Me, engagementId: string, body: unknown, ip?: string) {
    this.assertStaff(me);
    const input = parse(milestoneCreateSchema, body);
    const e = await this.project(me, engagementId);
    await this.assertCanShare(me, input.departmentId);
    const ids = [...new Set(input.fileIds)];
    const files = await this.prisma.file.findMany({ where: { id: { in: ids }, orgId: me.orgId, engagementId, uploadedById: me.id, tags: { has: 'milestone' } }, select: { id: true } });
    if (files.length !== ids.length) throw new BadRequestException('One of the files could not be found. Add it again.');
    const dept = await this.prisma.department.findFirst({ where: { id: input.departmentId, orgId: me.orgId }, select: { id: true, name: true } });
    if (!dept) throw new BadRequestException('Department not found');
    // The demo files belong to the department in Files (the client and the project's team see them).
    await this.prisma.file.updateMany({ where: { id: { in: ids } }, data: { departmentId: dept.id } });
    const m = await this.prisma.projectMilestone.create({ data: { orgId: me.orgId, engagementId, clientOrgId: e.clientOrgId, departmentId: dept.id, title: input.title, note: input.note || null, fileIds: ids, sharedById: me.id } });
    await this.audit.log(me, 'milestone.shared', 'Engagement', engagementId, undefined, { milestoneId: m.id, title: m.title, department: dept.name, files: ids.length }, ip);
    await this.notifications.notify(me.orgId, await this.clientUserIds(e.clientOrgId), {
      kind: 'milestone_shared',
      title: `Ready for you to look at: ${input.title}`,
      body: `${e.service.name}: ${dept.name} finished this part. Open it, then approve it or ask for changes.`,
      link: '/client/progress',
    });
    if (e.amId && e.amId !== me.id) {
      await this.notifications.notify(me.orgId, [e.amId], { kind: 'milestone_shared', title: `${me.name} shared "${input.title}" with ${e.clientOrg.name}`, body: `${dept.name} · ${e.service.name}. The client can approve it or ask for changes.`, link: `/team/projects/${engagementId}`, noEmail: true });
    }
    return this.view(me, engagementId);
  }

  // ------------------------------------------------------------------------------------------------ client

  async clientProgress(me: Me): Promise<ClientProgressView> {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('Client accounts only');
    const clientOrgId = me.clientOrg.id;
    const engs = await this.prisma.engagement.findMany({ where: { clientOrgId, deletedAt: null }, select: { id: true, service: { select: { name: true } } }, orderBy: { createdAt: 'desc' } });
    const [estimates, milestones] = await Promise.all([
      this.prisma.projectEstimate.findMany({ where: { engagementId: { in: engs.map((x) => x.id) }, sharedAt: { not: null }, finishBy: { not: null } }, orderBy: { finishBy: 'asc' } }),
      this.prisma.projectMilestone.findMany({ where: { clientOrgId }, orderBy: { sharedAt: 'desc' } }),
    ]);
    const depts = await this.prisma.department.findMany({ where: { id: { in: estimates.map((x) => x.departmentId) } }, select: { id: true, name: true } });
    const rows = await this.milestoneRows(milestones);
    return {
      projects: engs
        .map((x) => ({
          engagementId: x.id,
          service: x.service.name,
          estimates: estimates
            .filter((r) => r.engagementId === x.id)
            .map((r) => ({ department: depts.find((d) => d.id === r.departmentId)?.name ?? 'Team', finishBy: ymd(r.finishBy)!, note: r.headNote, sharedAt: r.sharedAt!.toISOString() })),
          milestones: rows.filter((_, i) => milestones[i].engagementId === x.id).map((m) => ({ ...m, canDecide: m.status === 'shared' })),
        }))
        .filter((p) => p.estimates.length || p.milestones.length),
    };
  }

  /** The client approves a finished part, or asks for changes (a task for the Department Head; the CM is told). */
  async decide(me: Me, id: string, body: unknown, ip?: string): Promise<ClientProgressView> {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('Client accounts only');
    const input = parse(milestoneDecisionSchema, body);
    const m = await this.prisma.projectMilestone.findFirst({ where: { id, clientOrgId: me.clientOrg.id } });
    if (!m) throw new NotFoundException('Not found');
    if (m.status !== 'shared') throw new BadRequestException('You already answered this one');
    const e = await this.prisma.engagement.findUniqueOrThrow({ where: { id: m.engagementId }, select: { id: true, amId: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } });
    const head = m.departmentId ? (await this.prisma.department.findUnique({ where: { id: m.departmentId }, select: { headUserId: true } }))?.headUserId : null;
    const now = new Date();
    let changeTaskId: string | null = null;
    if (input.decision === 'changes') {
      const cal = await calendarFor(this.prisma, m.orgId);
      const task = await this.prisma.task.create({
        data: {
          orgId: m.orgId,
          title: `Changes: ${m.title}`.slice(0, 200),
          description: `${e.clientOrg.name} asked for changes to "${m.title}":\n${input.comment}`,
          engagementId: m.engagementId,
          departmentId: m.departmentId,
          ownerId: head ?? m.sharedById,
          createdById: m.sharedById,
          deadline: addWorkingDays(now, 2, cal),
          priority: 'high',
          kind: 'work',
          status: 'todo',
        },
      });
      changeTaskId = task.id;
    }
    await this.prisma.projectMilestone.update({ where: { id }, data: { status: input.decision === 'approve' ? 'approved' : 'changes_requested', decidedAt: now, decidedById: me.id, clientComment: input.comment || null, changeTaskId } });
    await this.audit.log(me, input.decision === 'approve' ? 'milestone.approved' : 'milestone.changes_requested', 'Engagement', m.engagementId, undefined, { milestoneId: id, title: m.title, comment: input.comment ?? null }, ip);
    const to = [...new Set([head, m.sharedById, e.amId].filter((x): x is string => !!x))];
    await this.notifications.notify(m.orgId, to, {
      kind: input.decision === 'approve' ? 'milestone_approved' : 'milestone_changes',
      title: input.decision === 'approve' ? `${e.clientOrg.name} approved "${m.title}"` : `${e.clientOrg.name} asked for changes to "${m.title}"`,
      body: input.decision === 'approve' ? `${e.service.name}${input.comment ? `: "${input.comment.slice(0, 200)}"` : ''}` : `"${(input.comment ?? '').slice(0, 200)}" A task was added for the Department Head.`,
      link: changeTaskId ? `/team/tasks/${changeTaskId}` : `/team/projects/${m.engagementId}`,
      critical: input.decision === 'changes',
    });
    return this.clientProgress(me);
  }
}
