// v11 core: ApprovalRequest. Sensitive actions create a request instead of applying; the approver (next rank up
// unless specified) decides in "Needs you" or the Command Centre Approvals queue. Approve runs the handler registered
// for the action with the stored payload. Requests expire after 72 working hours.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { addWorkingMinutes, CORE_APPROVAL_EXPIRY_WORKING_HOURS, type CoreApprovalStatus, type CoreApprovalView, type CoreDecideApproval, type Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { MeService } from '../auth/me.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { hasRole, PeopleDirectory } from './people.js';
import { ActionsRegistry, type ApprovalRow } from './registry.js';

export type CreateApproval = {
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  payload: Record<string, unknown>;
  reason?: string | null;
  /** Specific approver; default = next rank up from the requester. */
  approverId?: string | null;
  /** Anyone with one of these roles may decide (used when there is no single approver). */
  approverRoles?: string[];
  /** Before → after lines shown to the approver. */
  diff?: { field: string; before: string | null; after: string | null }[];
};

const isAdmin = (me: Me) => hasRole(me, 'founder', 'admin');
/** "task" → "Task", "client_am" → "ClientAm" (audit entity names are PascalCase). */
const pascal = (s: string) => s.replace(/(^|_)(\w)/g, (_, _u: string, c: string) => c.toUpperCase());

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly registry: ActionsRegistry,
    private readonly people: PeopleDirectory,
    private readonly meService: MeService,
  ) {}

  /** Audit entity for a target type: the reassign target's auditEntity when registered, else PascalCase. */
  private entity(targetType: string) {
    return this.registry.reassignTargets.get(targetType)?.auditEntity ?? pascal(targetType);
  }

  /** Creates a pending request (one per action + target at a time) and tells the approver. */
  async create(me: Me, input: CreateApproval, ip?: string): Promise<ApprovalRow> {
    if (!this.registry.approvalHandlers.has(input.action)) throw new Error(`No approval handler registered for ${input.action}`);
    const existing = await this.prisma.approvalRequest.findFirst({ where: { orgId: me.orgId, action: input.action, targetType: input.targetType, targetId: input.targetId, status: 'pending' } });
    if (existing) throw new BadRequestException(`This is already waiting for approval: ${existing.summary}`);
    let approverId = input.approverId === undefined ? await this.people.nextUp(me.orgId, me.id) : input.approverId;
    if (approverId === me.id) approverId = await this.people.nextUp(me.orgId, me.id);
    const approverRoles = input.approverRoles ?? [];
    if (!approverId && !approverRoles.length) approverRoles.push('admin', 'founder');
    const cal = await calendarFor(this.prisma, me.orgId);
    const expiresAt = addWorkingMinutes(new Date(), CORE_APPROVAL_EXPIRY_WORKING_HOURS * 60, cal);
    const req = await this.prisma.approvalRequest.create({
      data: {
        orgId: me.orgId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        payload: JSON.parse(JSON.stringify({ ...input.payload, _diff: input.diff ?? [] })),
        summary: input.summary,
        requestedById: me.id,
        approverId,
        approverRoles,
        reason: input.reason ?? null,
        expiresAt,
      },
    });
    await this.audit.log(me, 'approval.requested', this.entity(input.targetType), input.targetId, null, { approvalId: req.id, action: input.action, summary: input.summary, approverId }, ip);
    const handler = this.registry.approvalHandlers.get(input.action)!;
    // A named approver and approver roles can both be set (e.g. the HR Department Head and the Founders): tell all of them.
    const recipients = [...new Set([...(approverId ? [approverId] : []), ...(approverRoles.length ? await this.roleHolders(me.orgId, approverRoles) : [])])].filter((id) => id !== me.id);
    await this.notifications.notify(me.orgId, recipients, {
      kind: 'approval_needed',
      title: `${me.name} needs your approval: ${input.summary}`,
      body: [handler.label, input.reason].filter(Boolean).join(' · '),
      link: '/team/approvals',
      ref: req.id,
    });
    return req;
  }

  private async roleHolders(orgId: string, roles: string[]) {
    const rows = await this.prisma.user.findMany({ where: { orgId, type: 'staff', deletedAt: null, status: 'active', roles: { some: { role: { baseRole: { in: roles } } } } }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  private canDecide(me: Me, r: ApprovalRow) {
    if (r.status !== 'pending' || r.requestedById === me.id) return false;
    const only = this.registry.approvalHandlers.get(r.action)?.approvers;
    if (only) return only(me, r);
    if (r.approverId === me.id) return true;
    if (hasRole(me, ...r.approverRoles)) return true;
    return isAdmin(me);
  }

  private async view(me: Me, rows: ApprovalRow[]): Promise<CoreApprovalView[]> {
    const names = await this.people.names(rows.flatMap((r) => [r.requestedById, r.approverId, r.decidedById]));
    // v14: workflows ask for approval as "system:workflow".
    const ref = (id: string | null) => (id ? { id, name: id.startsWith('system:') ? 'Workflow' : (names.get(id) ?? 'Former member') } : null);
    return rows.map((r) => {
      const h = this.registry.approvalHandlers.get(r.action);
      const payload = (r.payload ?? {}) as { _diff?: CoreApprovalView['diff'] };
      return {
        id: r.id,
        action: r.action,
        actionLabel: h?.label ?? r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        targetHref: h?.href?.(r) ?? null,
        summary: r.summary,
        reason: r.reason,
        requestedBy: ref(r.requestedById)!,
        approver: ref(r.approverId),
        approverRoles: r.approverRoles,
        status: r.status as CoreApprovalStatus,
        decisionNote: r.decisionNote,
        decidedBy: ref(r.decidedById),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        approveNeeds: h?.approveNeeds ?? 'none',
        canDecide: this.canDecide(me, r),
        canCancel: r.status === 'pending' && r.requestedById === me.id,
        diff: payload._diff ?? [],
      };
    });
  }

  /** mine = waiting for me ("Needs you"); requested = what I asked for; all = Command Centre queue (founder/admin). */
  async list(me: Me, box: string | undefined, status?: string): Promise<CoreApprovalView[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    await this.expire(new Date(), me.orgId);
    let where: Prisma.ApprovalRequestWhereInput;
    if (box === 'all') {
      if (!isAdmin(me) && !hasRole(me, 'am_lead', 'department_head')) throw new ForbiddenException('The approvals queue is for founders, admins, CM leads and department heads');
      where = { orgId: me.orgId };
      // Department heads and CM leads see what is theirs to decide plus what their people asked for.
      if (!isAdmin(me)) where = { orgId: me.orgId, OR: [{ approverId: me.id }, { approverRoles: { hasSome: me.roles } }, { requestedById: me.id }] };
    } else if (box === 'requested') where = { orgId: me.orgId, requestedById: me.id };
    else where = { orgId: me.orgId, status: 'pending', requestedById: { not: me.id }, OR: [{ approverId: me.id }, { approverRoles: { hasSome: me.roles } }] };
    if (status && status !== 'any') where = { AND: [where, { status }] };
    const rows = await this.prisma.approvalRequest.findMany({ where, orderBy: [{ createdAt: 'desc' }], take: 200 });
    return this.view(me, rows);
  }

  async count(me: Me) {
    if (me.type !== 'staff') return { pending: 0 };
    const pending = await this.prisma.approvalRequest.count({
      where: { orgId: me.orgId, status: 'pending', expiresAt: { gt: new Date() }, requestedById: { not: me.id }, OR: [{ approverId: me.id }, { approverRoles: { hasSome: me.roles } }] },
    });
    return { pending };
  }

  private async load(me: Me, id: string) {
    const r = await this.prisma.approvalRequest.findFirst({ where: { id, orgId: me.orgId } });
    if (!r) throw new NotFoundException('Approval request not found');
    return r;
  }

  async get(me: Me, id: string) {
    const r = await this.load(me, id);
    if (r.requestedById !== me.id && r.decidedById !== me.id && !this.canDecide(me, r) && !isAdmin(me) && r.approverId !== me.id) throw new ForbiddenException("You can't see this approval");
    return (await this.view(me, [r]))[0];
  }

  async decide(me: Me, id: string, input: CoreDecideApproval, ip?: string): Promise<CoreApprovalView> {
    await this.expire(new Date(), me.orgId);
    const r = await this.load(me, id);
    if (r.status !== 'pending') throw new BadRequestException(`This request is already ${r.status}`);
    if (r.requestedById === me.id) throw new ForbiddenException("You can't approve your own request");
    if (!this.canDecide(me, r)) throw new ForbiddenException('This approval is waiting for someone else');
    if (input.decision === 'reject' && (input.note ?? '').trim().length < 3) throw new BadRequestException('Say why you are rejecting it, so they know what to change');
    const handler = this.registry.approvalHandlers.get(r.action);
    if (!handler) throw new BadRequestException('This kind of request can no longer be decided here');
    // Claim it first so two approvers can't both apply it.
    const claimed = await this.prisma.approvalRequest.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: input.decision === 'approve' ? 'approved' : 'rejected', decidedById: me.id, decidedAt: new Date(), decisionNote: input.note ?? null } });
    if (!claimed.count) throw new BadRequestException('Someone else just decided this');
    if (input.decision === 'approve') {
      try {
        const requester = r.requestedById.startsWith('system:') ? null : await this.meService.load(r.requestedById);
        const result = await handler.apply({ approver: me, requester, req: r, input: input.input });
        await this.prisma.approvalRequest.update({ where: { id: r.id }, data: { result: JSON.parse(JSON.stringify(result ?? null)) } });
      } catch (e) {
        // Put it back so the approver can fix the input or reject instead.
        await this.prisma.approvalRequest.update({ where: { id: r.id }, data: { status: 'pending', decidedById: null, decidedAt: null, decisionNote: null } });
        throw e;
      }
    } else if (handler.onReject) await handler.onReject({ approver: me, req: r });
    await this.audit.log(me, `approval.${input.decision === 'approve' ? 'approved' : 'rejected'}`, this.entity(r.targetType), r.targetId, { status: 'pending' }, { approvalId: r.id, action: r.action, note: input.note ?? null }, ip);
    if (!r.requestedById.startsWith('system:')) await this.notifications.notify(me.orgId, [r.requestedById], {
      kind: 'approval_decided',
      title: `${me.name} ${input.decision === 'approve' ? 'approved' : 'rejected'}: ${r.summary}`,
      body: input.note || undefined,
      link: handler.href?.(r) ?? '/team/approvals',
    });
    return this.get(me, r.id);
  }

  async cancel(me: Me, id: string, ip?: string) {
    const r = await this.load(me, id);
    if (r.requestedById !== me.id) throw new ForbiddenException('Only the person who asked can withdraw it');
    if (r.status !== 'pending') throw new BadRequestException(`This request is already ${r.status}`);
    await this.prisma.approvalRequest.update({ where: { id }, data: { status: 'cancelled', decidedAt: new Date() } });
    await this.audit.log(me, 'approval.cancelled', this.entity(r.targetType), r.targetId, null, { approvalId: r.id }, ip);
    return this.get(me, id);
  }

  /** Marks overdue pending requests expired and tells the requester. Runs on every list/decide and from the job. */
  async expire(now: Date, orgId?: string) {
    const rows = await this.prisma.approvalRequest.findMany({ where: { status: 'pending', expiresAt: { lt: now }, ...(orgId ? { orgId } : {}) }, take: 200 });
    for (const r of rows) {
      const done = await this.prisma.approvalRequest.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'expired', decidedAt: now } });
      if (!done.count) continue;
      await this.audit.logSystem(r.orgId, 'approval.expired', this.entity(r.targetType), r.targetId, { approvalId: r.id, summary: r.summary });
      if (!r.requestedById.startsWith('system:')) await this.notifications.notify(r.orgId, [r.requestedById], { kind: 'approval_decided', title: `Expired without a decision: ${r.summary}`, body: 'Nobody decided within 72 working hours. Ask again if it is still needed.', link: '/team/approvals' });
    }
    return rows.length;
  }

  /** Pending request for a target (to show "waiting for approval" on records). */
  pendingFor(orgId: string, targetType: string, targetIds: string[]) {
    return this.prisma.approvalRequest.findMany({ where: { orgId, targetType, targetId: { in: targetIds }, status: 'pending' } });
  }
}
