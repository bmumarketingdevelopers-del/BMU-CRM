// v10 deliver: the client's approval rule, reminders for pending approvers, and client file uploads for onboarding items.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { addWorkingDays, deliverApprovalModeLabels, fileKindFromMime, type DeliverApprovalMode, type DeliverApprovalSettings, type Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isLeadership } from '../engagements/engagement-access.js';
import { approvalStatus, asApprovalMode, clientDecidersOf, pendingUserIds, planRound } from './approval-policy.js';

export type ClientUpload = { path: string; originalname: string; mimetype: string; size: number };

@Injectable()
export class DeliverApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async settingsFor(clientOrgId: string, canEdit: boolean): Promise<DeliverApprovalSettings> {
    const org = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId }, select: { approvalMode: true } });
    return { clientOrgId, mode: asApprovalMode(org.approvalMode), approvers: (await clientDecidersOf(this.prisma, clientOrgId)).map(({ userId, name, role }) => ({ userId, name, role })), canEdit };
  }

  private async staffClient(me: Me, clientOrgId: string) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId, deletedAt: null } });
    if (!c) throw new NotFoundException('Client not found');
    const canEdit = isLeadership(me) || c.amUserId === me.id;
    const canSee = canEdit || me.roles.some((r) => ['department_head', 'strategist', 'finance'].includes(r));
    if (!canSee) throw new NotFoundException('Client not found');
    return { c, canEdit };
  }

  async clientSettings(me: Me) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    return this.settingsFor(me.clientOrg.id, me.clientOrg.role === 'client_owner');
  }

  async saveClientSettings(me: Me, mode: DeliverApprovalMode, ip?: string) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    if (me.clientOrg.role !== 'client_owner') throw new ForbiddenException('Only the account owner can change who approves');
    return this.setMode(me, me.clientOrg.id, mode, ip, true);
  }

  async staffSettings(me: Me, clientOrgId: string) {
    const { canEdit } = await this.staffClient(me, clientOrgId);
    return this.settingsFor(clientOrgId, canEdit);
  }

  async saveStaffSettings(me: Me, clientOrgId: string, mode: DeliverApprovalMode, ip?: string) {
    const { canEdit } = await this.staffClient(me, clientOrgId);
    if (!canEdit) throw new ForbiddenException("Only the client's Client Manager or leadership can change the approval rule");
    return this.setMode(me, clientOrgId, mode, ip, canEdit);
  }

  private async setMode(me: Me, clientOrgId: string, mode: DeliverApprovalMode, ip: string | undefined, canEdit: boolean) {
    const before = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId } });
    if (mode === 'all' && (await clientDecidersOf(this.prisma, clientOrgId)).length === 0) throw new BadRequestException('Add an approver first');
    await this.prisma.clientOrg.update({ where: { id: clientOrgId }, data: { approvalMode: mode } });
    await this.audit.log(me, 'client.approval_mode_changed', 'ClientOrg', clientOrgId, { approvalMode: before.approvalMode }, { approvalMode: mode }, ip);
    const notify = me.type === 'client' ? [before.amUserId] : await this.notifications.clientDeciders(clientOrgId);
    await this.notifications.notify(me.orgId, notify.filter((x) => x !== me.id), {
      kind: 'approval_rule',
      title: `Approvals now need: ${deliverApprovalModeLabels[mode].label.toLowerCase()}`,
      body: `${me.name} changed the approval rule for ${before.name}.`,
      link: me.type === 'client' ? `/team/clients/${clientOrgId}` : '/client/team',
    });
    return this.settingsFor(clientOrgId, canEdit);
  }

  /** Pending approvers of a plan or draft and whether the round is open. */
  private async pendingFor(target: 'deliverable' | 'plan', id: string, orgId: string) {
    if (target === 'deliverable') {
      const d = await this.prisma.deliverable.findFirst({
        where: { id, orgId },
        include: { versions: { orderBy: { number: 'desc' }, take: 1 }, cycle: { include: { engagement: { include: { clientOrg: true } } } } },
      });
      if (!d) throw new NotFoundException('Deliverable not found');
      if (d.status !== 'ready_for_client' || !d.versions[0]) throw new BadRequestException('Nothing is waiting for the client on this deliverable');
      const st = await approvalStatus(this.prisma, { clientOrgId: d.cycle.engagement.clientOrgId, target, targetId: d.id, round: d.versions[0].id });
      return { st, engagement: d.cycle.engagement, title: `${d.title} v${d.versions[0].number}`, link: `/client/reviews/${d.id}` };
    }
    const plan = await this.prisma.plan.findFirst({ where: { id, orgId }, include: { cycle: { include: { engagement: { include: { clientOrg: true, service: true } } } } } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.status !== 'sent_to_client') throw new BadRequestException('This plan is not waiting for the client');
    const st = await approvalStatus(this.prisma, { clientOrgId: plan.cycle.engagement.clientOrgId, target, targetId: plan.id, round: await planRound(this.prisma, plan.id) });
    return { st, engagement: plan.cycle.engagement, title: `the ${plan.cycle.engagement.service.name} plan`, link: '/client/approvals' };
  }

  /** CM (or a client owner/approver) nudges whoever still has to approve. */
  async remind(me: Me, target: 'deliverable' | 'plan', id: string, ip?: string) {
    const { st, engagement, title, link } = await this.pendingFor(target, id, me.orgId);
    if (me.type === 'client') {
      if (engagement.clientOrgId !== me.clientOrg?.id) throw new NotFoundException('Not found');
    } else if (!(isLeadership(me) || engagement.amId === me.id)) {
      throw new ForbiddenException("Only the client's Client Manager can send reminders");
    }
    const ids = pendingUserIds(st).filter((x) => x !== me.id);
    if (!ids.length) throw new BadRequestException('Nobody is pending');
    await this.notifications.notify(me.orgId, ids, { kind: 'approval_reminder', title: `Reminder: ${title} is waiting for your approval`, body: st.summary, link, critical: true });
    await this.audit.log(me, 'approval.reminded', target === 'plan' ? 'Plan' : 'Deliverable', id, undefined, { to: ids.length }, ip);
    return { reminded: st.approvers.filter((a) => ids.includes(a.userId)).map((a) => a.name) };
  }

  /** Job: once per working day, remind people still pending on a round that is older than one working day. */
  async autoRemind(now = new Date()) {
    let sent = 0;
    const orgs = await this.prisma.organisation.findMany({ where: { deletedAt: null }, select: { id: true, settings: true } });
    for (const org of orgs) {
      const holidays = ((org.settings ?? {}) as { holidays?: string[] }).holidays ?? [];
      const candidates = [
        ...(await this.prisma.deliverable.findMany({ where: { orgId: org.id, status: 'ready_for_client' }, select: { id: true, versions: { orderBy: { number: 'desc' }, take: 1, select: { sentToClientAt: true } } } })).map((d) => ({
          target: 'deliverable' as const,
          id: d.id,
          since: d.versions[0]?.sentToClientAt ?? null,
        })),
        ...(await this.prisma.plan.findMany({ where: { orgId: org.id, status: 'sent_to_client' }, select: { id: true } })).map((p) => ({ target: 'plan' as const, id: p.id, since: null as Date | null })),
      ];
      for (const c of candidates) {
        let since = c.since;
        if (c.target === 'plan') since = (await this.prisma.approval.findFirst({ where: { targetType: 'plan_internal', targetId: c.id }, orderBy: { at: 'desc' } }))?.at ?? null;
        if (!since || addWorkingDays(since, 1, holidays) > now) continue;
        const last = await this.prisma.auditEvent.findFirst({ where: { orgId: org.id, entityId: c.id, action: { in: ['approval.reminded', 'approval.auto_reminded'] } }, orderBy: { at: 'desc' } });
        if (last && addWorkingDays(last.at, 1, holidays) > now) continue;
        try {
          const { st, title, link } = await this.pendingFor(c.target, c.id, org.id);
          // Only rounds where someone has approved but others are still needed, or nobody has approved at all.
          const ids = pendingUserIds(st);
          if (!ids.length) continue;
          await this.notifications.notify(org.id, ids, { kind: 'approval_reminder', title: `Reminder: ${title} is waiting for your approval`, body: st.summary, link });
          await this.audit.logSystem(org.id, 'approval.auto_reminded', c.target === 'plan' ? 'Plan' : 'Deliverable', c.id, { to: ids.length });
          sent++;
        } catch {
          // round closed meanwhile
        }
      }
    }
    return { sent };
  }

  /** Client uploads a file for an onboarding item; the CM then checks it and marks it received. */
  async uploadRequirement(me: Me, itemId: string, file: ClientUpload | undefined, note: string | undefined, root: string, ip?: string) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    if (!file) throw new BadRequestException('Choose a file to upload');
    const item = await this.prisma.requirementItem.findFirst({ where: { id: itemId, cycle: { engagement: { clientOrgId: me.clientOrg.id } } }, include: { cycle: { include: { engagement: { include: { clientOrg: true } } } } } });
    if (!item) throw new NotFoundException('Item not found');
    if (item.status === 'received') throw new BadRequestException('Already received. Thank you!');
    const checksum = await new Promise<string>((res, rej) => {
      const h = createHash('sha256');
      createReadStream(file.path).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
    });
    const stored = await this.prisma.file.create({
      data: { orgId: me.orgId, clientOrgId: me.clientOrg.id, path: file.path.slice(root.length + 1), kind: fileKindFromMime(file.mimetype), name: file.originalname, mimeType: file.mimetype, sizeBytes: file.size, checksum, folder: 'from_client', uploadedById: me.id, engagementId: item.cycle.engagementId },
    });
    const body = `${note ? `${note} · ` : ''}File: ${file.originalname} /api/files/${stored.id}`;
    await this.prisma.$transaction([
      this.prisma.requirementItem.update({ where: { id: itemId }, data: { status: 'waiting', waitingFor: 'BMU to review', blockedReason: null } }),
      this.prisma.comment.create({ data: { orgId: me.orgId, targetType: 'requirement', targetId: itemId, body, authorId: me.id } }),
    ]);
    await this.audit.log(me, 'requirement.submitted_by_client', 'RequirementItem', itemId, { status: item.status }, { status: 'waiting', fileId: stored.id }, ip);
    await this.notifications.notify(me.orgId, [item.cycle.engagement.amId], {
      kind: 'requirement_sent',
      title: `${item.cycle.engagement.clientOrg.name} uploaded "${item.label}"`,
      body: 'Check the file and mark it received.',
      link: `/team/projects/${item.cycle.engagementId}`,
    });
  }
}
