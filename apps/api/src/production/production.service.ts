import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  addWorkingDays,
  clientDeliverableLabels,
  DEFAULT_QC_CHECKLISTS,
  DELIVER_SOCIAL_TYPES,
  fileKindFromMime,
  istDate,
  reviewAnchorSchema,
  type ClientDeliverableDetail,
  type DeliverableDetail,
  type DeliverableStatus,
  type EodInput,
  type FileKind,
  type Me,
  type MyDayView,
  type QcQueueItem,
  type QcSubmit,
  type ReviewComment,
  type ReviewCommentInput,
  type ReviewListItem,
  type TaskStatus,
  type TaskView,
  type UpdateTask,
  type VersionView,
  leaveDecisionMessage,
  leaveTypeLabels,
  type LeaveType,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { ReassignService } from '../actions/reassign.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { DeliveryService } from '../requests/delivery.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isLeadership } from '../engagements/engagement-access.js';
import { approvalStatus, pendingUserIds } from '../deliver/approval-policy.js';
import { DeliverSlaService } from '../deliver/deliver-sla.service.js';
import { carryOpenComments, proofRounds, ProofingService } from '../creative/proofing.service.js';
import { AssetsService } from '../creative/assets.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { addDays, dayKind, dayLabel, dbDate, lateMinutes, leaveOn, loadWorkCalendar, nextWorkingDay } from '../admin-org/work-calendar.js';

const OPEN: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'];
const DONE: TaskStatus[] = ['done', 'cancelled'];

const taskInclude = {
  owner: { select: { id: true, name: true } },
  deliverable: {
    select: {
      id: true,
      title: true,
      type: true,
      status: true,
      cycle: { select: { engagementId: true, engagement: { select: { clientOrg: { select: { id: true, name: true } } } } } },
    },
  },
} satisfies Prisma.TaskInclude;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

const deliverableInclude = {
  cycle: { include: { engagement: { include: { clientOrg: { select: { id: true, name: true, publishNeedsApproval: true } }, service: true } } } },
  versions: { orderBy: { number: 'asc' as const }, include: { file: true, qcResults: { orderBy: { createdAt: 'asc' as const } } } },
  tasks: { orderBy: { sort: 'asc' as const }, include: taskInclude },
} satisfies Prisma.DeliverableInclude;
type DeliverableRow = Prisma.DeliverableGetPayload<{ include: typeof deliverableInclude }>;

export type UploadedFile = { path: string; originalname: string; mimetype: string; size: number };

@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly delivery: DeliveryService,
    private readonly notifications: NotificationsService,
    private readonly sla: DeliverSlaService,
    private readonly reassignEngine: ReassignService,
    private readonly ref: ModuleRef,
    private readonly settings: SettingsService,
  ) {}

  private readonly log = new Logger('Production');

  /** v16 creative services, looked up lazily (they live in the Creative module). */
  private creative() {
    return { proofing: this.ref.get(ProofingService, { strict: false }), assets: this.ref.get(AssetsService, { strict: false }) };
  }

  // -------------------------------------------------------------------------
  // Access

  private async myDepartment(me: Me) {
    return (await this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } }))?.departmentId ?? null;
  }

  /** Tasks a staff member can see: leadership all, department heads their department, CMs their clients, everyone their own. */
  private async taskScope(me: Me): Promise<Prisma.TaskWhereInput> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const base = { orgId: me.orgId };
    if (isLeadership(me)) return base;
    const or: Prisma.TaskWhereInput[] = [{ ownerId: me.id }];
    if (me.roles.includes('department_head')) {
      const dept = await this.myDepartment(me);
      if (dept) or.push({ departmentId: dept });
    }
    if (me.roles.includes('account_manager')) or.push({ deliverable: { cycle: { engagement: { amId: me.id } } } }, { engagementId: { in: (await this.prisma.engagement.findMany({ where: { amId: me.id }, select: { id: true } })).map((e) => e.id) } });
    if (me.roles.includes('qc_reviewer')) or.push({ kind: 'qc' });
    return { ...base, OR: or };
  }

  private async canSeeDeliverable(me: Me, d: DeliverableRow) {
    if (me.type !== 'staff' || d.orgId !== me.orgId) return false;
    if (isLeadership(me) || me.roles.includes('department_head') || me.roles.includes('qc_reviewer')) return true;
    if (d.cycle.engagement.amId === me.id) return true;
    return d.tasks.some((t) => t.ownerId === me.id);
  }

  private canManage(me: Me, d: DeliverableRow) {
    return isLeadership(me) || me.roles.includes('department_head') || d.cycle.engagement.amId === me.id;
  }

  private canUpload(me: Me, d: DeliverableRow) {
    return this.canManage(me, d) || d.tasks.some((t) => t.kind === 'work' && t.ownerId === me.id);
  }

  private canQc(me: Me) {
    return (me.permissions.qc_pass_fail?.scope ?? 'none') !== 'none';
  }

  private canSend(me: Me, d: DeliverableRow) {
    return isLeadership(me) || d.cycle.engagement.amId === me.id;
  }

  private async loadDeliverable(id: string, orgId: string) {
    const d = await this.prisma.deliverable.findFirst({ where: { id, orgId }, include: deliverableInclude });
    if (!d) throw new NotFoundException('Deliverable not found');
    return d;
  }

  private async staffDeliverable(me: Me, id: string) {
    const d = await this.loadDeliverable(id, me.orgId);
    if (!(await this.canSeeDeliverable(me, d))) throw new NotFoundException('Deliverable not found');
    return d;
  }

  private async holidays(orgId: string) {
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
    return ((org.settings ?? {}) as { holidays?: string[] }).holidays ?? [];
  }

  // -------------------------------------------------------------------------
  // Views

  private async toTasks(rows: TaskRow[]): Promise<TaskView[]> {
    const depIds = [...new Set(rows.flatMap((t) => t.dependsOn))];
    const deps = depIds.length ? await this.prisma.task.findMany({ where: { id: { in: depIds } }, select: { id: true, status: true } }) : [];
    const now = Date.now();
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      kind: t.kind as TaskView['kind'],
      status: t.status,
      flowStep: t.flowStep,
      role: t.role,
      owner: t.owner,
      deadline: t.deadline?.toISOString() ?? null,
      overdue: !!t.deadline && t.deadline.getTime() < now && !DONE.includes(t.status),
      blockedReason: t.blockedReason,
      timeLoggedMin: t.timeLoggedMin,
      dependsOn: t.dependsOn,
      ready: t.dependsOn.every((id) => deps.find((d) => d.id === id)?.status === 'done'),
      deliverable: t.deliverable ? { id: t.deliverable.id, title: t.deliverable.title, type: t.deliverable.type, status: t.deliverable.status } : null,
      client: t.deliverable?.cycle.engagement.clientOrg ?? null,
      engagementId: t.engagementId ?? t.deliverable?.cycle.engagementId ?? null,
    }));
  }

  private fileUrl(v: DeliverableRow['versions'][number]): { kind: FileKind; url: string } {
    if (v.file.kind === 'link') return { kind: 'link', url: v.file.path };
    return { kind: v.file.kind as FileKind, url: `/api/files/${v.file.id}` };
  }

  private async versionViews(d: DeliverableRow, opts: { client: boolean }): Promise<VersionView[]> {
    const versions = opts.client ? d.versions.filter((v) => v.sentToClientAt) : d.versions;
    const userIds = [...new Set(versions.flatMap((v) => [v.uploadedById, ...v.qcResults.map((q) => q.reviewerId)]))];
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
    const approvals = await this.prisma.approval.findMany({ where: { targetType: 'deliverable', targetId: d.id, gate: 'G4' } });
    const approvers = await this.prisma.user.findMany({ where: { id: { in: approvals.map((a) => a.userId) } }, select: { id: true, name: true } });
    const name = (id: string) => users.find((u) => u.id === id)?.name ?? '';
    return versions.map((v) => {
      const approval = approvals.find((a) => a.versionId === v.id);
      return {
        id: v.id,
        number: v.number,
        note: v.note,
        ...this.fileUrl(v),
        name: v.file.name,
        uploadedBy: opts.client ? 'BMU team' : name(v.uploadedById),
        at: v.createdAt.toISOString(),
        sentToClientAt: v.sentToClientAt?.toISOString() ?? null,
        // QC is internal (client_hidden_data): never sent to client accounts.
        qc: opts.client
          ? []
          : v.qcResults.map((q) => {
              const items = q.items as { list?: { label: string; ok: boolean; note?: string }[]; note?: string };
              return { id: q.id, result: q.result, items: items.list ?? [], note: items.note ?? null, reviewer: name(q.reviewerId), at: q.createdAt.toISOString() };
            }),
        approved: approval ? { by: approvers.find((a) => a.id === approval.userId)?.name ?? '', at: approval.at.toISOString() } : null,
      };
    });
  }

  private async comments(d: DeliverableRow, opts: { client: boolean }): Promise<ReviewComment[]> {
    const versionIds = d.versions.filter((v) => !opts.client || v.sentToClientAt).map((v) => v.id);
    const rows = await this.prisma.comment.findMany({
      where: { targetType: 'version', targetId: { in: versionIds }, ...(opts.client ? { isInternal: false } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    const authors = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.authorId) } }, select: { id: true, name: true, type: true } });
    // v16: comments carried over from an earlier version show which version they started on.
    const originIds = [...new Set(rows.map((r) => r.carriedFromId).filter((x): x is string => !!x))];
    const origins = originIds.length ? await this.prisma.comment.findMany({ where: { id: { in: originIds } }, select: { id: true, targetId: true } }) : [];
    const versionNo = (versionId?: string) => d.versions.find((v) => v.id === versionId)?.number ?? null;
    return rows.map((c) => {
      const a = authors.find((x) => x.id === c.authorId);
      const parsed = c.timestampOrPin ? reviewAnchorSchema.safeParse(JSON.parse(c.timestampOrPin)) : null;
      return {
        id: c.id,
        body: c.body,
        anchor: parsed?.success ? parsed.data : null,
        internal: c.isInternal,
        author: { name: a?.name ?? '', isClient: a?.type === 'client' },
        at: c.createdAt.toISOString(),
        versionId: c.targetId,
        carriedFrom: c.carriedFromId ? versionNo(origins.find((o) => o.id === c.carriedFromId)?.targetId) : null,
        resolvedAt: c.resolvedAt?.toISOString() ?? null,
      };
    });
  }

  private async includedRounds(d: DeliverableRow) {
    const tier = await this.prisma.serviceTier.findUnique({
      where: { serviceId_tier: { serviceId: d.cycle.engagement.serviceId, tier: d.cycle.engagement.tier } },
      select: { revisionRounds: true },
    });
    return tier?.revisionRounds ?? 2;
  }

  private async qcChecklist(orgId: string, flowKey: string | null) {
    const key = flowKey ?? 'general';
    const t =
      (await this.prisma.checklistTemplate.findFirst({ where: { orgId, kind: 'qc', key }, orderBy: { version: 'desc' } })) ??
      (await this.prisma.checklistTemplate.findFirst({ where: { orgId, kind: 'qc', key: 'general' }, orderBy: { version: 'desc' } }));
    if (t) return t.items as string[];
    return DEFAULT_QC_CHECKLISTS.find((c) => c.key === key)?.items ?? DEFAULT_QC_CHECKLISTS.at(-1)!.items;
  }

  /** v10: approval progress for the version currently with the client (or the approved one). */
  private async deliverableApproval(d: DeliverableRow) {
    const round = d.approvedVersionId ?? (d.status === 'ready_for_client' ? d.versions.at(-1)?.id : undefined);
    if (!round) return null;
    const final = d.approvedVersionId ? await this.prisma.approval.findFirst({ where: { targetType: 'deliverable', targetId: d.id, gate: 'G4', versionId: round } }) : null;
    return approvalStatus(this.prisma, { clientOrgId: d.cycle.engagement.clientOrgId, target: 'deliverable', targetId: d.id, round, finalApproverId: final?.userId, finalAt: final?.at });
  }

  private async certificateRef(deliverableId: string) {
    const c = await this.prisma.approvalCertificate.findFirst({ where: { deliverableId }, orderBy: { createdAt: 'desc' }, select: { id: true, code: true } });
    return c ?? null;
  }

  async deliverable(me: Me, id: string): Promise<DeliverableDetail> {
    const d = await this.staffDeliverable(me, id);
    return this.toDetail(me, d);
  }

  private async toDetail(me: Me, d: DeliverableRow): Promise<DeliverableDetail> {
    return {
      id: d.id,
      title: d.title,
      type: d.type,
      status: d.status,
      dueAt: d.dueAt?.toISOString() ?? null,
      client: { id: d.cycle.engagement.clientOrg.id, name: d.cycle.engagement.clientOrg.name },
      engagementId: d.cycle.engagementId,
      serviceName: d.cycle.engagement.service.name,
      revisionRounds: { used: d.revisionRoundsUsed, included: await this.includedRounds(d) },
      versions: await this.versionViews(d, { client: false }),
      comments: await this.comments(d, { client: false }),
      tasks: await this.toTasks(d.tasks),
      qcChecklist: await this.qcChecklist(d.orgId, d.flowKey),
      approvalStatus: await this.deliverableApproval(d),
      schedule: { scheduledAt: d.scheduledAt?.toISOString() ?? null, channel: d.channel, publishedAt: d.publishedAt?.toISOString() ?? null, liveUrl: d.liveUrl },
      rounds: await proofRounds(this.prisma, d, false),
      certificate: await this.certificateRef(d.id),
      caption: d.caption,
      can: {
        upload: this.canUpload(me, d) && !['approved', 'scheduled', 'published'].includes(d.status),
        qc: this.canQc(me) && d.status === 'in_qc',
        send: this.canSend(me, d) && d.status === 'qc_passed',
        comment: true,
        internal: true,
        approveForPublishing:
          !d.cycle.engagement.clientOrg.publishNeedsApproval && this.canSend(me, d) && ['qc_passed', 'ready_for_client'].includes(d.status) && (DELIVER_SOCIAL_TYPES as readonly string[]).includes(d.type),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Tasks

  async tasks(me: Me, view: 'mine' | 'team'): Promise<TaskView[]> {
    const where: Prisma.TaskWhereInput = view === 'mine' ? { orgId: me.orgId, ownerId: me.id } : await this.taskScope(me);
    const rows = await this.prisma.task.findMany({
      // Open work plus anything finished in the last 14 days (older history lives in analytics).
      where: { AND: [where, { status: { not: 'cancelled' } }, { OR: [{ status: { not: 'done' } }, { completedAt: null }, { completedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } }] }] },
      include: taskInclude,
      orderBy: [{ deadline: 'asc' }, { sort: 'asc' }],
      take: 500,
    });
    return this.toTasks(rows);
  }

  /** v20 sync: one task as the task list shows it (null when this person can't see it). */
  async taskView(me: Me, id: string): Promise<TaskView | null> {
    const t = await this.prisma.task.findFirst({ where: { AND: [{ id }, await this.taskScope(me)] }, include: taskInclude });
    return t ? (await this.toTasks([t]))[0] : null;
  }

  async updateTask(me: Me, id: string, input: UpdateTask, ip?: string): Promise<TaskView> {
    const task = await this.prisma.task.findFirst({ where: { AND: [{ id }, await this.taskScope(me)] }, include: taskInclude });
    if (!task) throw new NotFoundException('Task not found');
    const manager = isLeadership(me) || me.roles.includes('department_head') || me.roles.includes('account_manager');
    if (task.ownerId !== me.id && !manager) throw new ForbiddenException('Only the task owner or a manager can change this task');
    if (input.ownerId && !manager) throw new ForbiddenException('Only a manager can reassign tasks');
    if (input.status && ['in_progress', 'done'].includes(input.status) && task.dependsOn.length) {
      const deps = await this.prisma.task.findMany({ where: { id: { in: task.dependsOn } }, select: { status: true, title: true } });
      const open = deps.filter((d) => d.status !== 'done');
      if (open.length) throw new BadRequestException(`Waiting on: ${open.map((d) => d.title).join(', ')}`);
    }
    if (input.status === 'done' && task.kind === 'qc') throw new BadRequestException('QC tasks complete when the QC checklist is submitted');
    if (input.status === 'done' && task.kind === 'client_review') throw new BadRequestException('Client review completes when the client approves');
    // v11 core: a parent task can't be done while its subtasks are open; archived and draft tasks are frozen.
    if (task.archivedAt || task.isDraft) throw new BadRequestException(task.archivedAt ? 'Restore the task first' : 'Activate the draft first');
    if (input.status === 'done') {
      const openSubs = await this.prisma.task.count({ where: { parentId: id, status: { in: ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] }, archivedAt: null, isDraft: false } });
      if (openSubs) throw new BadRequestException(`${openSubs} subtask${openSubs > 1 ? 's are' : ' is'} still open. Finish or archive them first.`);
    }
    const now = new Date();
    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (input.status) {
      data.status = input.status;
      data.blockedReason = input.status === 'blocked' ? input.blockedReason : null;
      if (input.status === 'in_progress' && !task.startedAt) data.startedAt = now;
      if (input.status === 'done') data.completedAt = now;
    }
    if (input.logMinutes) data.timeLoggedMin = { increment: input.logMinutes };
    if (input.ownerId) {
      const owner = await this.prisma.user.findFirst({ where: { id: input.ownerId, orgId: me.orgId, type: 'staff' } });
      if (!owner) throw new BadRequestException('Unknown team member');
      data.ownerId = owner.id;
    }
    const updated = await this.prisma.task.update({ where: { id }, data, include: taskInclude });
    // v10 timesheets: every logged block is also a dated time entry for the person who logged it.
    if (input.logMinutes) {
      await this.prisma.timeEntry.create({
        data: { orgId: me.orgId, userId: me.id, date: new Date(`${istDate(now)}T00:00:00Z`), minutes: input.logMinutes, category: 'task', source: 'task_log', taskId: id, engagementId: task.engagementId ?? task.deliverable?.cycle?.engagementId ?? null },
      });
    }
    await this.audit.log(me, 'task.updated', 'Task', id, { status: task.status, ownerId: task.ownerId }, input, ip);
    if (input.ownerId && input.ownerId !== task.ownerId) await this.reassignEngine.record(me, 'task', [{ id, fromUserId: task.ownerId, toUserId: input.ownerId }], 'other', 'Changed on the task board');
    return (await this.toTasks([updated]))[0];
  }

  // -------------------------------------------------------------------------
  // Versions, QC, send to client

  async addVersion(me: Me, deliverableId: string, src: { file?: UploadedFile; url?: string; note?: string }, storageRoot: string, ip?: string) {
    const d = await this.staffDeliverable(me, deliverableId);
    if (!this.canUpload(me, d)) throw new ForbiddenException('Only the people working on this deliverable can upload versions');
    if (['approved', 'scheduled', 'published'].includes(d.status)) throw new BadRequestException('This deliverable is approved and locked');
    if (d.status === 'in_qc') throw new BadRequestException('The current version is waiting for QC');
    if (d.status === 'ready_for_client') throw new BadRequestException('The current version is with the client');
    let fileData: Prisma.FileUncheckedCreateInput;
    if (src.file) {
      const checksum = await new Promise<string>((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(src.file!.path).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
      });
      fileData = {
        orgId: me.orgId,
        clientOrgId: d.cycle.engagement.clientOrgId,
        path: src.file.path.slice(storageRoot.length + 1),
        kind: fileKindFromMime(src.file.mimetype),
        name: src.file.originalname,
        mimeType: src.file.mimetype,
        sizeBytes: src.file.size,
        checksum,
      };
    } else if (src.url) {
      fileData = { orgId: me.orgId, clientOrgId: d.cycle.engagement.clientOrgId, path: src.url, kind: 'link', name: src.url };
    } else throw new BadRequestException('Attach a file or paste a link');

    const number = (d.versions.at(-1)?.number ?? 0) + 1;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const file = await tx.file.create({ data: fileData });
      const created = await tx.version.create({ data: { orgId: me.orgId, deliverableId: d.id, fileId: file.id, number, uploadedById: me.id, note: src.note } });
      // v16: open comments on the previous version come along, so nothing asked for gets lost.
      const prev = d.versions.at(-1);
      if (prev) await carryOpenComments(tx, prev.id, created.id);
      await tx.deliverable.update({ where: { id: d.id }, data: { status: 'in_qc' } });
      // Making is done for this round; QC is next.
      await tx.task.updateMany({ where: { deliverableId: d.id, kind: 'work', status: { in: OPEN } }, data: { status: 'done', completedAt: now, blockedReason: null } });
      await tx.task.updateMany({ where: { deliverableId: d.id, kind: 'qc', status: { in: OPEN } }, data: { status: 'todo' } });
    });
    await this.audit.log(me, 'version.uploaded', 'Deliverable', d.id, undefined, { number, kind: fileData.kind }, ip);
    const qcOwners = d.tasks.filter((t) => t.kind === 'qc').map((t) => t.ownerId);
    await this.notifications.notify(d.orgId, qcOwners.filter((id) => id !== me.id), { kind: 'qc_waiting', title: `${d.title} v${number} is waiting for QC`, link: `/team/deliverables/${d.id}` });
    return this.deliverable(me, d.id);
  }

  async submitQc(me: Me, versionId: string, input: QcSubmit, ip?: string) {
    if (!this.canQc(me)) throw new ForbiddenException('Only QC reviewers and department heads can pass or fail QC');
    const v = await this.prisma.version.findFirst({ where: { id: versionId, orgId: me.orgId } });
    if (!v) throw new NotFoundException('Version not found');
    const d = await this.staffDeliverable(me, v.deliverableId);
    if (d.status !== 'in_qc' || d.versions.at(-1)?.id !== v.id) throw new BadRequestException('Only the latest version waiting for QC can be checked');
    if (v.uploadedById === me.id && !me.roles.includes('founder')) throw new ForbiddenException('You cannot QC your own work');
    const pass = input.items.every((i) => i.ok);
    const now = new Date();
    const checklist = await this.qcChecklist(d.orgId, d.flowKey);
    await this.prisma.$transaction(async (tx) => {
      await tx.qCResult.create({
        data: {
          orgId: me.orgId,
          versionId: v.id,
          checklistId: d.flowKey ?? 'general',
          items: { list: input.items, note: input.note ?? null, checklist },
          result: pass ? 'pass' : 'fail',
          reviewerId: me.id,
        },
      });
      await tx.deliverable.update({ where: { id: d.id }, data: { status: pass ? 'qc_passed' : 'qc_failed' } });
      if (pass) {
        await tx.task.updateMany({ where: { deliverableId: d.id, kind: 'qc', status: { in: OPEN } }, data: { status: 'done', completedAt: now } });
      } else {
        await tx.task.updateMany({ where: { deliverableId: d.id, kind: 'qc', status: { in: OPEN } }, data: { status: 'waiting' } });
        // Return to the maker: reopen the last making step with the QC notes.
        const last = [...d.tasks].reverse().find((t) => t.kind === 'work');
        if (last) await tx.task.update({ where: { id: last.id }, data: { status: 'in_progress', completedAt: null } });
        const notes = [input.note, ...input.items.filter((i) => !i.ok).map((i) => `${i.label}${i.note ? `: ${i.note}` : ''}`)].filter(Boolean).join('\n');
        await tx.comment.create({
          data: { orgId: me.orgId, targetType: 'version', targetId: v.id, body: `QC failed\n${notes}`, isInternal: true, authorId: me.id },
        });
      }
    });
    await this.audit.log(me, pass ? 'qc.passed' : 'qc.failed', 'Version', v.id, undefined, { items: input.items.length }, ip);
    await this.notifications.notify(
      d.orgId,
      pass ? [d.cycle.engagement.amId] : [v.uploadedById, [...d.tasks].reverse().find((t) => t.kind === 'work')?.ownerId],
      pass
        ? { kind: 'qc_passed', title: `${d.title} v${v.number} passed QC`, body: 'Ready to send to the client.', link: `/team/deliverables/${d.id}` }
        : { kind: 'qc_failed', title: `${d.title} v${v.number} failed QC`, body: input.note, link: `/team/deliverables/${d.id}`, critical: true },
    );
    return this.deliverable(me, d.id);
  }

  /** 'Send to client' requires a QC pass on that exact version (acceptance criteria). */
  async sendToClient(me: Me, versionId: string, ip?: string) {
    const v = await this.prisma.version.findFirst({ where: { id: versionId, orgId: me.orgId }, include: { qcResults: true } });
    if (!v) throw new NotFoundException('Version not found');
    const d = await this.staffDeliverable(me, v.deliverableId);
    if (!this.canSend(me, d)) throw new ForbiddenException("Only the client's Client Manager can send drafts");
    const lastQc = [...v.qcResults].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1);
    if (lastQc?.result !== 'pass') throw new BadRequestException('This version needs a QC pass before the client can see it');
    if (d.versions.at(-1)?.id !== v.id) throw new BadRequestException('Only the latest version can be sent');
    if (v.sentToClientAt) throw new BadRequestException('Already sent');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.version.update({ where: { id: v.id }, data: { sentToClientAt: now, sentById: me.id } }),
      this.prisma.deliverable.update({ where: { id: d.id }, data: { status: 'ready_for_client' } }),
      this.prisma.task.updateMany({ where: { deliverableId: d.id, kind: 'client_review', status: { in: OPEN } }, data: { status: 'in_progress', startedAt: now } }),
      this.prisma.engagement.update({ where: { id: d.cycle.engagementId }, data: { status: 'in_review' } }),
    ]);
    await this.audit.log(me, 'version.sent_to_client', 'Version', v.id, undefined, { number: v.number }, ip);
    // v16: each approver gets their own review email with a one-tap approve link (and WhatsApp when they have a phone).
    await this.creative().proofing.sendReviewLinks({ id: d.id, orgId: d.orgId, title: d.title, clientOrgId: d.cycle.engagement.clientOrgId }, v);
    return this.deliverable(me, d.id);
  }

  async comment(me: Me, deliverableId: string, input: ReviewCommentInput & { versionId: string }, ip?: string) {
    const d = me.type === 'client' ? await this.clientDeliverableRow(me, deliverableId) : await this.staffDeliverable(me, deliverableId);
    const v = d.versions.find((x) => x.id === input.versionId);
    if (!v || (me.type === 'client' && !v.sentToClientAt)) throw new NotFoundException('Version not found');
    if (me.type === 'client' && d.status !== 'ready_for_client') throw new BadRequestException('Comments open when a version is ready for your review');
    await this.prisma.comment.create({
      data: {
        orgId: d.orgId,
        targetType: 'version',
        targetId: v.id,
        body: input.body,
        timestampOrPin: input.anchor ? JSON.stringify(input.anchor) : null,
        isInternal: me.type === 'staff' ? input.internal : false,
        authorId: me.id,
      },
    });
    await this.audit.log(me, 'comment.added', 'Version', v.id, undefined, { internal: me.type === 'staff' && input.internal }, ip);
    return me.type === 'client' ? this.clientDeliverable(me, d.id) : this.deliverable(me, d.id);
  }

  async qcQueue(me: Me): Promise<QcQueueItem[]> {
    if (!this.canQc(me)) throw new ForbiddenException('QC reviewers only');
    const where: Prisma.DeliverableWhereInput = { orgId: me.orgId, status: 'in_qc' };
    if (me.roles.includes('department_head') && !isLeadership(me) && !me.roles.includes('qc_reviewer')) {
      where.departmentId = (await this.myDepartment(me)) ?? '__none__';
    }
    const rows = await this.prisma.deliverable.findMany({
      where,
      include: {
        cycle: { include: { engagement: { include: { clientOrg: true, service: true } } } },
        versions: { orderBy: { number: 'desc' }, take: 1 },
      },
    });
    const uploaders = await this.prisma.user.findMany({ where: { id: { in: rows.flatMap((r) => r.versions.map((v) => v.uploadedById)) } }, select: { id: true, name: true } });
    return rows
      .filter((r) => r.versions[0])
      .map((r) => ({
        deliverableId: r.id,
        title: r.title,
        type: r.type,
        client: r.cycle.engagement.clientOrg.name,
        serviceName: r.cycle.engagement.service.name,
        versionNumber: r.versions[0].number,
        uploadedBy: uploaders.find((u) => u.id === r.versions[0].uploadedById)?.name ?? '',
        waitingSince: r.versions[0].createdAt.toISOString(),
      }))
      .sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
  }

  // -------------------------------------------------------------------------
  // Client Review Studio

  private clientOrgId(me: Me) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    return me.clientOrg.id;
  }

  private async clientDeliverableRow(me: Me, id: string) {
    const d = await this.prisma.deliverable.findFirst({
      where: { id, cycle: { engagement: { clientOrgId: this.clientOrgId(me), deletedAt: null } }, versions: { some: { sentToClientAt: { not: null } } } },
      include: deliverableInclude,
    });
    if (!d) throw new NotFoundException('Not found');
    return d;
  }

  private canDecide(me: Me) {
    return me.permissions.plan_and_calendar?.rule === 'approve' || me.clientOrg?.role === 'client_owner' || me.clientOrg?.role === 'client_approver';
  }

  async clientReviews(me: Me): Promise<ReviewListItem[]> {
    const rows = await this.prisma.deliverable.findMany({
      where: { cycle: { engagement: { clientOrgId: this.clientOrgId(me), deletedAt: null } }, status: { not: 'planned' } },
      include: { cycle: { include: { engagement: { include: { service: true } } } }, versions: { where: { sentToClientAt: { not: null } }, orderBy: { number: 'desc' }, take: 1 } },
      orderBy: { dueAt: 'asc' },
    });
    const myVotes = await this.prisma.approval.findMany({
      where: { targetType: 'deliverable_vote', userId: me.id, versionId: { in: rows.map((r) => r.versions[0]?.id).filter((x): x is string => !!x) } },
      select: { versionId: true },
    });
    const voted = new Set(myVotes.map((v) => v.versionId));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      status: r.status,
      statusLabel: r.status === 'ready_for_client' && voted.has(r.versions[0]?.id ?? '') ? 'You approved, waiting for others' : clientDeliverableLabels[r.status as DeliverableStatus],
      serviceName: r.cycle.engagement.service.name,
      latestVersion: r.versions[0]?.number ?? null,
      waitingOnYou: r.status === 'ready_for_client' && this.canDecide(me) && !voted.has(r.versions[0]?.id ?? ''),
    }));
  }

  async clientDeliverable(me: Me, id: string): Promise<ClientDeliverableDetail> {
    const d = await this.clientDeliverableRow(me, id);
    const latestSent = d.versions.at(-1);
    const myVote =
      d.status === 'ready_for_client' && latestSent
        ? await this.prisma.approval.findFirst({ where: { targetType: 'deliverable_vote', targetId: d.id, versionId: latestSent.id, userId: me.id } })
        : null;
    const decide = this.canDecide(me) && d.status === 'ready_for_client';
    return {
      id: d.id,
      title: d.title,
      type: d.type,
      status: d.status,
      dueAt: d.dueAt?.toISOString() ?? null,
      client: { id: d.cycle.engagement.clientOrg.id, name: d.cycle.engagement.clientOrg.name },
      engagementId: d.cycle.engagementId,
      serviceName: d.cycle.engagement.service.name,
      revisionRounds: { used: d.revisionRoundsUsed, included: await this.includedRounds(d) },
      versions: await this.versionViews(d, { client: true }),
      comments: await this.comments(d, { client: true }),
      approvalStatus: await this.deliverableApproval(d),
      schedule: { scheduledAt: d.scheduledAt?.toISOString() ?? null, channel: d.channel, publishedAt: d.publishedAt?.toISOString() ?? null, liveUrl: d.liveUrl },
      rounds: await proofRounds(this.prisma, d, true),
      certificate: await this.certificateRef(d.id),
      caption: d.caption,
      can: { approve: decide && !myVote, requestChanges: decide, comment: d.status === 'ready_for_client' },
    };
  }

  /** Gate 4 for this deliverable: written approval of a specific version, stored immutably. */
  async clientApprove(me: Me, id: string, versionId: string, ip?: string, via: 'portal' | 'email' | 'whatsapp' = 'portal') {
    if (!this.canDecide(me)) throw new ForbiddenException('Only the account owner or an approver can approve work');
    const d = await this.clientDeliverableRow(me, id);
    const v = d.versions.at(-1);
    if (d.status !== 'ready_for_client' || !v || v.id !== versionId || !v.sentToClientAt) throw new BadRequestException('Approve the latest version sent to you');
    // v10: the client's approval rule (any one / owner must / all approvers). Each approval is recorded immutably.
    if (await this.prisma.approval.findFirst({ where: { targetType: 'deliverable_vote', targetId: d.id, versionId: v.id, userId: me.id } })) {
      throw new BadRequestException('You have already approved this version');
    }
    await this.prisma.approval.create({ data: { orgId: d.orgId, targetType: 'deliverable_vote', targetId: d.id, userId: me.id, versionId: v.id, via, ip: ip ?? null } });
    const rule = await approvalStatus(this.prisma, { clientOrgId: d.cycle.engagement.clientOrgId, target: 'deliverable', targetId: d.id, round: v.id });
    if (!rule.satisfied) {
      await this.audit.log(me, 'deliverable.approval_recorded', 'Deliverable', d.id, undefined, { versionId: v.id, number: v.number, pending: rule.pending }, ip);
      await this.notifications.notify(d.orgId, [d.cycle.engagement.amId], {
        kind: 'approval_partial',
        title: `${me.name} approved ${d.title} v${v.number}`,
        body: rule.summary,
        link: `/team/deliverables/${d.id}`,
      });
      await this.notifications.notify(d.orgId, pendingUserIds(rule).filter((id) => id !== me.id), {
        kind: 'approval_needed',
        title: `${d.title} v${v.number} needs your approval too`,
        body: rule.summary,
        link: `/client/reviews/${d.id}`,
        critical: true,
      });
      return this.clientDeliverable(me, d.id);
    }
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.approval.create({ data: { orgId: d.orgId, targetType: 'deliverable', targetId: d.id, gate: 'G4', userId: me.id, at: now, versionId: v.id, via, ip: ip ?? null } }),
      this.prisma.deliverable.update({ where: { id: d.id }, data: { status: 'approved', approvedVersionId: v.id } }),
      this.prisma.task.updateMany({ where: { deliverableId: d.id, status: { in: OPEN } }, data: { status: 'done', completedAt: now } }),
    ]);
    await this.audit.log(me, 'deliverable.approved', 'Deliverable', d.id, undefined, { versionId: v.id, number: v.number, via }, ip);
    // v16: seal the approval in a certificate and put the approved file in the client's asset library.
    try {
      await this.creative().proofing.issueCertificate(d.id, v.id);
      await this.creative().assets.fromApprovedDeliverable(d.id);
    } catch (e) {
      this.log.error(`After-approval steps failed for ${d.id}: ${(e as Error).message}`);
    }
    await this.notifications.notify(d.orgId, [d.cycle.engagement.amId], { kind: 'draft_approved', title: `${d.cycle.engagement.clientOrg.name} approved ${d.title} v${v.number}`, link: `/team/deliverables/${d.id}` });
    await this.afterClientDecision(d.cycleId, d.cycle.engagementId, d.orgId);
    return this.clientDeliverable(me, d.id);
  }

  async clientRequestChanges(me: Me, id: string, comment: string | undefined, ip?: string, via: 'portal' | 'email' | 'whatsapp' = 'portal') {
    if (!this.canDecide(me)) throw new ForbiddenException('Only the account owner or an approver can request changes');
    const d = await this.clientDeliverableRow(me, id);
    const v = d.versions.at(-1);
    if (d.status !== 'ready_for_client' || !v) throw new BadRequestException('Nothing is waiting for your review');
    const hasFeedback = comment || (await this.prisma.comment.count({ where: { targetType: 'version', targetId: v.id, isInternal: false, authorId: me.id } }));
    if (!hasFeedback) throw new BadRequestException('Add at least one comment so the team knows what to change');
    const included = await this.includedRounds(d);
    const last = [...d.tasks].reverse().find((t) => t.kind === 'work');
    await this.prisma.$transaction(async (tx) => {
      if (comment) await tx.comment.create({ data: { orgId: d.orgId, targetType: 'version', targetId: v.id, body: comment, authorId: me.id } });
      await tx.deliverable.update({ where: { id: d.id }, data: { status: 'changes_requested', revisionRoundsUsed: { increment: 1 } } });
      await tx.task.updateMany({ where: { deliverableId: d.id, kind: 'client_review', status: { in: OPEN } }, data: { status: 'waiting' } });
      await tx.task.updateMany({ where: { deliverableId: d.id, kind: 'qc' }, data: { status: 'todo', completedAt: null } });
      if (last) {
        const holidays = await this.holidays(d.orgId);
        await tx.task.update({ where: { id: last.id }, data: { status: 'in_progress', completedAt: null, deadline: addWorkingDays(new Date(), 2, holidays) } });
      }
    });
    await this.audit.log(me, 'deliverable.changes_requested', 'Deliverable', d.id, undefined, { round: d.revisionRoundsUsed + 1, included, via }, ip);
    await this.notifications.notify(d.orgId, [d.cycle.engagement.amId, last?.ownerId], {
      kind: 'changes_requested',
      title: `${d.cycle.engagement.clientOrg.name} asked for changes on ${d.title}`,
      body: d.revisionRoundsUsed + 1 > included ? `Round ${d.revisionRoundsUsed + 1} is beyond the ${included} included.` : undefined,
      link: `/team/deliverables/${d.id}`,
      critical: d.revisionRoundsUsed + 1 > included,
    });
    await this.afterClientDecision(d.cycleId, d.cycle.engagementId, d.orgId);
    return this.clientDeliverable(me, d.id);
  }

  /** Engagement status follows its deliverables; all approved → Gate 4 passed. */
  async afterClientDecision(cycleId: string, engagementId: string, orgId: string) {
    const all = await this.prisma.deliverable.findMany({ where: { cycleId }, select: { status: true } });
    const engagement = await this.prisma.engagement.findUniqueOrThrow({ where: { id: engagementId } });
    // v10: an earlier retainer month finishing must not move the gate of the month now running.
    const latest = await this.prisma.cycle.findFirst({ where: { engagementId }, orderBy: { period: 'desc' }, select: { id: true } });
    if (latest && latest.id !== cycleId) {
      if (all.length && all.every((d) => ['approved', 'scheduled', 'published'].includes(d.status))) {
        await this.audit.logSystem(orgId, 'cycle.completed', 'Engagement', engagementId, { cycleId });
      }
      return;
    }
    if (all.length && all.every((d) => ['approved', 'scheduled', 'published'].includes(d.status))) {
      await this.prisma.engagement.update({
        where: { id: engagementId },
        data: { currentGate: 'G5', status: engagement.billingType === 'one_time' ? 'awaiting_final_payment' : 'active_retainer' },
      });
      await this.audit.logSystem(orgId, 'gate.G4.passed', 'Engagement', engagementId, { deliverables: all.length });
      await this.delivery.onGate4Passed(engagementId);
    } else {
      const inReview = all.some((d) => d.status === 'ready_for_client');
      await this.prisma.engagement.update({ where: { id: engagementId }, data: { status: inReview ? 'in_review' : 'in_production' } });
    }
  }

  // -------------------------------------------------------------------------
  // Files

  /** Staff of the org may open any file they can reach; clients only files of versions sent to them. */
  async fileFor(me: Me, id: string) {
    const file = await this.prisma.file.findFirst({ where: { id, orgId: me.orgId }, include: { versions: { include: { deliverable: { include: deliverableInclude } } } } });
    if (!file) throw new NotFoundException('File not found');
    if (me.type === 'client') {
      // Versions sent to them, or files they uploaded themselves (onboarding items, no versions).
      const ok =
        file.versions.some((v) => v.sentToClientAt && v.deliverable.cycle.engagement.clientOrgId === me.clientOrg?.id) ||
        (file.versions.length === 0 &&
          !!file.clientOrgId &&
          file.clientOrgId === me.clientOrg?.id &&
          // v11 ops: team uploads stay internal until released (only "From client", brand assets and released finals show).
          (!file.uploadedById || file.folder === 'from_client' || file.folder === 'brand' || (file.folder === 'final' && file.released)) &&
          !file.archivedAt) ||
        // v16: files of assets shared with the client in their asset library.
        (!!file.clientOrgId &&
          file.clientOrgId === me.clientOrg?.id &&
          (await this.prisma.assetVersion.count({ where: { fileId: file.id, asset: { clientOrgId: me.clientOrg?.id, clientVisible: true, archivedAt: null } } })) > 0);
      if (!ok) throw new NotFoundException('File not found');
    } else {
      const reachable = await Promise.all(file.versions.map((v) => this.canSeeDeliverable(me, v.deliverable)));
      if (file.versions.length && !reachable.some(Boolean)) throw new NotFoundException('File not found');
    }
    return file;
  }

  // -------------------------------------------------------------------------
  // My Day

  private today() {
    return new Date(`${istDate(new Date())}T00:00:00Z`);
  }

  async myDay(me: Me): Promise<MyDayView> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const date = this.today();
    const [att, eod, mine] = await Promise.all([
      this.prisma.attendance.findUnique({ where: { userId_date: { userId: me.id, date } } }),
      this.prisma.eODReport.findUnique({ where: { userId_date: { userId: me.id, date } } }),
      this.tasks(me, 'mine'),
    ]);
    const open = mine.filter((t) => !DONE.includes(t.status));
    const todayStr = istDate(new Date());
    const dueToday = (t: TaskView) => !!t.deadline && istDate(new Date(t.deadline)) === todayStr;
    const qcWaiting = this.canQc(me) ? (await this.qcQueue(me)).length : 0;
    const sendToClientWaiting = await this.prisma.deliverable.count({
      where: { orgId: me.orgId, status: 'qc_passed', ...(isLeadership(me) ? {} : { cycle: { engagement: { amId: me.id } } }) },
    });
    const doneToday = await this.prisma.task.findMany({
      where: { ownerId: me.id, status: 'done', completedAt: { gte: new Date(`${todayStr}T00:00:00+05:30`) } },
      select: { title: true },
    });
    // v30: check-in once a day on working days; after check-out it opens again on the next working day.
    const cal = await loadWorkCalendar(this.settings, me.orgId);
    const workday = dayKind(todayStr, cal);
    const missed = await this.prisma.attendance.findFirst({
      where: { userId: me.id, date: { gte: dbDate(addDays(todayStr, -7)), lt: date }, checkIn: { not: null }, checkOut: null },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    const missedAsked = missed ? await this.prisma.attendanceCorrection.count({ where: { userId: me.id, date: missed.date, status: { in: ['pending', 'approved'] } } }) : 0;
    // v31: on approved leave check-in is closed like a holiday; work from home checks in as usual.
    const leave = await leaveOn(this.prisma, me.id, todayStr);
    const wfh = await this.prisma.leaveRequest.count({ where: { userId: me.id, status: 'approved', type: 'wfh', from: { lte: date }, to: { gte: date } } });
    const leaveUntil = leave ? leave.to.toISOString().slice(0, 10) : null;
    // v31: the final decision on the latest request, worded for its type (never who decided), for 3 days.
    const decided = await this.prisma.leaveRequest.findFirst({
      where: { userId: me.id, status: { in: ['approved', 'rejected'] }, decidedAt: { gte: new Date(Date.now() - 3 * 86_400_000) } },
      orderBy: { decidedAt: 'desc' },
    });
    const range = (f: Date, t: Date) => (f.getTime() === t.getTime() ? dayLabel(f.toISOString().slice(0, 10)) : `${dayLabel(f.toISOString().slice(0, 10))} to ${dayLabel(t.toISOString().slice(0, 10))}`);
    const notice = decided
      ? { status: decided.status as 'approved' | 'rejected', type: decided.type, ...leaveDecisionMessage(decided.type, decided.status as 'approved' | 'rejected', range(decided.from, decided.to), decided.paidDays !== null && decided.unpaidDays !== null ? { paid: decided.paidDays, unpaid: decided.unpaidDays } : undefined) }
      : null;
    return {
      date: todayStr,
      checkIn: att?.checkIn?.toISOString() ?? null,
      checkOut: att?.checkOut?.toISOString() ?? null,
      workday,
      canCheckIn: workday.kind === 'working' && !leave && !att?.checkIn,
      canCheckOut: !leave && !!att?.checkIn && !att.checkOut,
      nextCheckIn: leaveUntil ? nextWorkingDay(leaveUntil, cal) : workday.kind !== 'working' || att?.checkOut ? nextWorkingDay(todayStr, cal) : null,
      onLeave: leave ? { type: leave.type, label: leaveTypeLabels[leave.type as LeaveType] ?? 'Leave', until: leaveUntil! } : null,
      wfh: wfh > 0,
      leaveNotice: notice,
      late: lateMinutes(att?.checkIn, cal) > 0,
      workingHours: { start: cal.start, end: cal.end, graceMinutes: cal.graceMinutes },
      missedCheckOut: missed && !missedAsked ? missed.date.toISOString().slice(0, 10) : null,
      tasks: {
        overdue: open.filter((t) => t.overdue && t.status !== 'blocked'),
        today: open.filter((t) => !t.overdue && dueToday(t) && t.status !== 'blocked'),
        upcoming: open.filter((t) => !t.overdue && !dueToday(t) && t.status !== 'blocked').slice(0, 10),
        blocked: open.filter((t) => t.status === 'blocked'),
      },
      qcWaiting,
      sendToClientWaiting,
      deliverSla: (await this.sla.view(me, { mine: true })).items.slice(0, 12),
      eod: eod
        ? { completed: eod.completed, pending: eod.pending, blocked: eod.blocked, waiting: eod.waiting, submitted: true }
        : {
            // Pre-filled from today's tasks; the person edits before submitting.
            completed: doneToday.map((t) => t.title),
            pending: open.filter((t) => ['todo', 'in_progress'].includes(t.status) && (t.overdue || dueToday(t))).map((t) => t.title),
            blocked: open.filter((t) => t.status === 'blocked').map((t) => `${t.title} (${t.blockedReason})`),
            waiting: open.filter((t) => t.status === 'waiting').map((t) => t.title),
            submitted: false,
          },
    };
  }

  async checkIn(me: Me, out: boolean) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const date = this.today();
    const now = new Date();
    const existing = await this.prisma.attendance.findUnique({ where: { userId_date: { userId: me.id, date } } });
    // v30: only on working days (Holidays & Working Hours, set by the Founder), one check-in and one check-out a day.
    const cal = await loadWorkCalendar(this.settings, me.orgId);
    const todayStr = istDate(now);
    const kind = dayKind(todayStr, cal);
    const next = nextWorkingDay(todayStr, cal);
    const opens = next ? ` Check-in opens on ${dayLabel(next)}.` : '';
    if (!out && kind.kind !== 'working') throw new BadRequestException(`Today is ${kind.kind === 'holiday' ? `a holiday (${kind.label})` : 'a weekly off'}. No check-in is needed.${opens}`);
    // v31: approved leave closes check-in and check-out like a holiday (work from home checks in as usual).
    const leave = await leaveOn(this.prisma, me.id, todayStr);
    if (leave) {
      const back = nextWorkingDay(leave.to.toISOString().slice(0, 10), cal);
      throw new BadRequestException(`You are on ${leaveTypeLabels[leave.type as LeaveType] ?? 'leave'} today. No check-in is needed.${back ? ` Check-in opens on ${dayLabel(back)}.` : ''}`);
    }
    if (!out && existing?.checkOut) throw new BadRequestException(`You have already checked in and out today.${opens}`);
    if (!out && existing?.checkIn) throw new BadRequestException('Already checked in today');
    if (out && !existing?.checkIn) throw new BadRequestException('Check in first');
    if (out && existing?.checkOut) throw new BadRequestException(`Already checked out today.${opens}`);
    await this.prisma.attendance.upsert({
      where: { userId_date: { userId: me.id, date } },
      update: out ? { checkOut: now } : { checkIn: now },
      create: { userId: me.id, date, orgId: me.orgId, checkIn: now },
    });
    return this.myDay(me);
  }

  async submitEod(me: Me, input: EodInput) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const date = this.today();
    await this.prisma.eODReport.upsert({
      where: { userId_date: { userId: me.id, date } },
      update: input,
      create: { userId: me.id, date, orgId: me.orgId, ...input },
    });
    return this.myDay(me);
  }
}
