import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TEAM_ACTIVITY_ENTITIES, type Me, type TeamActivityEntity, type TeamActivityFeed, type TeamActivityItem } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { visibleEngagementWhere } from '../engagements/engagement-access.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TaskAccess } from '../actions/tasks/task-access.js';
import { capable, hasRole, isStaff } from './access.js';

const ENTITY_WORDS: Record<string, string> = {
  ClientOrg: 'the client',
  Lead: 'the lead',
  Proposal: 'a proposal',
  Engagement: 'the engagement',
  Invoice: 'an invoice',
  Payment: 'a payment',
  Request: 'a request',
  Deliverable: 'a deliverable',
  Version: 'a version',
  Plan: 'the plan',
  RequirementItem: 'a requirement',
  Task: 'a task',
  User: 'the account',
  LeaveRequest: 'a leave request',
  Timesheet: 'a timesheet',
  CreditNote: 'a credit note',
  CreatorBrief: 'a creator brief',
  Thread: 'the conversation',
  Creator: 'the creator',
  File: 'the file',
};

const PHRASES: Record<string, string> = {
  'lead.contacted': 'marked the lead as contacted',
  'lead.discovery': 'moved the lead to discovery',
  'lead.won': 'marked the lead as won',
  'lead.lost': 'marked the lead as lost',
  'lead.updated': 'updated the lead',
  'proposal.created': 'created a proposal',
  'proposal.sent': 'sent the proposal',
  'proposal.viewed': 'opened the proposal',
  'proposal.accepted': 'accepted the proposal',
  'proposal.discount_approved': 'approved the proposal discount',
  'client.onboarded': 'set up the client account',
  'client.am_reassigned': 'changed the client manager',
  'client.data_exported': 'exported the client data (DPDP)',
  'client.personal_data_deleted': 'deleted client personal data (DPDP)',
  'invoice.issued': 'issued an invoice',
  'invoice.paid': 'recorded full payment of an invoice',
  'invoice.cancelled': 'cancelled an invoice',
  'payment.recorded': 'recorded a payment',
  'plan.submitted': 'submitted the plan for approval',
  'plan.sent_to_client': 'sent the plan to the client',
  'plan.changes_requested': 'asked for changes to the plan',
  'requirement.received': 'marked a requirement as received',
  'deliverable.approved': 'approved a deliverable',
  'deliverable.changes_requested': 'asked for changes to a deliverable',
  'version.sent_to_client': 'sent a version to the client',
  'engagement.final_sign_off': 'signed off the final delivery',
  'user.invited': 'invited the person',
  'user.updated': 'updated the account',
  'user.suspended': 'suspended access',
  'onboarding.started': 'started onboarding',
  'offboarding.started': 'started offboarding',
  'offboarding.work_reassigned': 'handed over work',
  // v11 core
  'task.created': 'created the task',
  'task.drafted': 'saved the task as a draft',
  'task.edited': 'edited the task',
  'task.assigned': 'assigned the task',
  'task.reassigned': 'reassigned the task',
  'task.deadline_changed': 'changed the deadline',
  'task.archived': 'archived the task',
  'task.restored': 'restored the task',
  'task.duplicated': 'duplicated a task',
  'task.blocked': 'marked the task blocked',
  'task.completed': 'marked the task done',
  'task.status_changed': 'changed the status',
  'task.activated': 'activated the draft',
  'task.undone': 'undid a change',
  'task.dependency_added': 'added a dependency',
  'task.dependency_removed': 'removed a dependency',
  'approval.requested': 'asked for approval',
  'approval.approved': 'approved a request',
  'approval.rejected': 'rejected a request',
  'approval.cancelled': 'withdrew a request',
  'approval.expired': 'let a request expire',
  'record.tagged': 'changed the tags',
};

const short = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 80);
};

/** Who did what, when: AuditEvent rows for a record and the records that belong to it. */
@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskAccess: TaskAccess,
  ) {}

  private async clientVisible(me: Me, clientOrgId: string) {
    if (hasRole(me, 'founder', 'admin', 'am_lead', 'finance', 'department_head')) return true;
    const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId }, select: { amUserId: true, am: { select: { teamId: true } } } });
    if (!c) return false;
    if (c.amUserId === me.id) return true;
    if (hasRole(me, 'strategist')) {
      const self = await this.prisma.user.findUnique({ where: { id: me.id }, select: { teamId: true } });
      return !!self?.teamId && self.teamId === c.am?.teamId;
    }
    return false;
  }

  private leadWhere(me: Me): Prisma.LeadWhereInput | null {
    const scope = me.permissions.leads_pipeline?.scope ?? 'none';
    if (scope === 'none') return null;
    return { orgId: me.orgId, deletedAt: null, ...(scope === 'own' ? { ownerId: me.id } : {}) };
  }

  /** The record itself plus its children, as (entity, ids) pairs. Throws if `me` may not see the record. */
  private async targets(me: Me, entity: TeamActivityEntity, id: string): Promise<[string, string[]][]> {
    const deny = () => new ForbiddenException("You don't have access to this record's history");
    switch (entity) {
      case 'ClientOrg': {
        const c = await this.prisma.clientOrg.findFirst({ where: { id, orgId: me.orgId }, select: { id: true, leadId: true } });
        if (!c) throw new NotFoundException('Client not found');
        if (!(await this.clientVisible(me, id))) throw deny();
        const [engs, invoices, requests, users, proposals] = await Promise.all([
          this.prisma.engagement.findMany({ where: { clientOrgId: id }, select: { id: true } }),
          capable(me, 'invoices_payments') || hasRole(me, 'account_manager', 'am_lead') ? this.prisma.invoice.findMany({ where: { clientOrgId: id }, select: { id: true } }) : [],
          this.prisma.request.findMany({ where: { engagement: { clientOrgId: id } }, select: { id: true } }),
          this.prisma.clientUser.findMany({ where: { clientOrgId: id }, select: { userId: true } }),
          c.leadId ? this.prisma.proposal.findMany({ where: { leadId: c.leadId }, select: { id: true } }) : [],
        ]);
        return [
          ['ClientOrg', [id]],
          ['Engagement', engs.map((e) => e.id)],
          ['Invoice', invoices.map((i) => i.id)],
          ['Request', requests.map((r) => r.id)],
          ['User', users.map((u) => u.userId)],
          ...(c.leadId ? ([['Lead', [c.leadId]]] as [string, string[]][]) : []),
          ['Proposal', proposals.map((p) => p.id)],
        ];
      }
      case 'Lead': {
        const where = this.leadWhere(me);
        if (!where) throw deny();
        const l = await this.prisma.lead.findFirst({ where: { ...where, id }, select: { id: true } });
        if (!l) throw new NotFoundException('Lead not found');
        const proposals = await this.prisma.proposal.findMany({ where: { leadId: id }, select: { id: true } });
        return [
          ['Lead', [id]],
          ['Proposal', proposals.map((p) => p.id)],
        ];
      }
      case 'Proposal': {
        const where = this.leadWhere(me);
        if (!where) throw deny();
        const p = await this.prisma.proposal.findFirst({ where: { id, lead: where }, select: { id: true } });
        if (!p) throw new NotFoundException('Proposal not found');
        return [['Proposal', [id]]];
      }
      case 'Engagement': {
        const e = await this.prisma.engagement.findFirst({ where: { AND: [await visibleEngagementWhere(this.prisma, me), { id }] }, select: { id: true } });
        if (!e) throw new NotFoundException('Engagement not found');
        const [cycles, requests] = await Promise.all([
          this.prisma.cycle.findMany({ where: { engagementId: id }, select: { deliverables: { select: { id: true, versions: { select: { id: true } } } }, plans: { select: { id: true } }, requirements: { select: { id: true } } } }),
          this.prisma.request.findMany({ where: { engagementId: id }, select: { id: true } }),
        ]);
        return [
          ['Engagement', [id]],
          ['Deliverable', cycles.flatMap((c) => c.deliverables.map((d) => d.id))],
          ['Version', cycles.flatMap((c) => c.deliverables.flatMap((d) => d.versions.map((v) => v.id)))],
          ['Plan', cycles.flatMap((c) => c.plans.map((p) => p.id))],
          ['RequirementItem', cycles.flatMap((c) => c.requirements.map((r) => r.id))],
          ['Request', requests.map((r) => r.id)],
        ];
      }
      case 'Invoice': {
        const i = await this.prisma.invoice.findFirst({ where: { id, orgId: me.orgId }, select: { id: true, clientOrgId: true, payments: { select: { id: true } } } });
        if (!i) throw new NotFoundException('Invoice not found');
        const am = i.clientOrgId ? await this.prisma.clientOrg.findFirst({ where: { id: i.clientOrgId, amUserId: me.id } }) : null;
        if (!capable(me, 'invoices_payments') && !am) throw deny();
        return [
          ['Invoice', [id]],
          ['Payment', i.payments.map((p) => p.id)],
        ];
      }
      case 'Task': {
        // v11 core: a task's history includes its subtasks.
        await this.taskAccess.load(me, id);
        const subs = await this.prisma.task.findMany({ where: { parentId: id }, select: { id: true } });
        return [['Task', [id, ...subs.map((s) => s.id)]]];
      }
      // v11 ops: creator profiles (with their briefs) and files.
      case 'Creator': {
        if (!hasRole(me, 'founder', 'admin', 'am_lead', 'account_manager', 'department_head')) throw deny();
        const c = await this.prisma.creator.findFirst({ where: { id, orgId: me.orgId }, select: { id: true } });
        if (!c) throw new NotFoundException('Creator not found');
        const briefs = await this.prisma.creatorBrief.findMany({ where: { creatorId: id }, select: { id: true } });
        return [
          ['Creator', [id]],
          ['CreatorBrief', briefs.map((b) => b.id)],
        ];
      }
      case 'File': {
        const f = await this.prisma.file.findFirst({ where: { id, orgId: me.orgId }, select: { id: true, clientOrgId: true, uploadedById: true } });
        if (!f) throw new NotFoundException('File not found');
        if (f.uploadedById !== me.id && !(f.clientOrgId && (await this.clientVisible(me, f.clientOrgId))) && !hasRole(me, 'producer', 'strategist', 'qc_reviewer')) throw deny();
        return [['File', [id]]];
      }
      case 'User': {
        const peopleAdmin = hasRole(me, 'founder', 'admin', 'hr_ops', 'department_head') && capable(me, 'users_roles_hierarchy');
        if (!peopleAdmin && id !== me.id) throw deny();
        const u = await this.prisma.user.findFirst({ where: { id, orgId: me.orgId }, select: { id: true } });
        if (!u) throw new NotFoundException('Person not found');
        return [['User', [id]]];
      }
    }
  }

  async feed(me: Me, entityRaw: string | undefined, id: string | undefined, actor?: string, takeRaw?: string): Promise<TeamActivityFeed> {
    if (!isStaff(me)) throw new ForbiddenException('Team accounts only');
    if (!entityRaw || !(TEAM_ACTIVITY_ENTITIES as readonly string[]).includes(entityRaw)) throw new BadRequestException('Unknown record type');
    if (!id) throw new BadRequestException('Which record?');
    const targets = (await this.targets(me, entityRaw as TeamActivityEntity, id)).filter(([, ids]) => ids.length);
    const where: Prisma.AuditEventWhereInput = { orgId: me.orgId, OR: targets.map(([entity, ids]) => ({ entity, entityId: { in: ids } })) };
    const take = Math.min(200, Math.max(10, Number(takeRaw) || 100));
    const [rows, total, actorRows] = await Promise.all([
      this.prisma.auditEvent.findMany({ where: { ...where, ...(actor ? { actorId: actor === 'system' ? null : actor } : {}) }, orderBy: { at: 'desc' }, take }),
      this.prisma.auditEvent.count({ where }),
      this.prisma.auditEvent.findMany({ where, distinct: ['actorId'], select: { actorId: true } }),
    ]);
    const ids = [...new Set([...rows.map((r) => r.actorId), ...actorRows.map((a) => a.actorId)].filter((x): x is string => !!x))];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const name = (aid: string | null) => (aid ? (users.find((u) => u.id === aid)?.name ?? 'Former member') : null);
    const items: TeamActivityItem[] = rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actor: name(r.actorId),
      action: r.action,
      summary: `${name(r.actorId) ?? 'BMU Hub'} ${this.phrase(r.action, r.entity)}`,
      entity: r.entity,
      entityId: r.entityId,
      changes: this.changes(r.before, r.after),
    }));
    return { items, total, actors: users.map((u) => `${u.id}|${u.name}`) };
  }

  private phrase(action: string, entity: string) {
    if (PHRASES[action]) return PHRASES[action];
    const gate = /^gate\.(G\d)\.passed$/.exec(action);
    if (gate) return `passed ${gate[1]}`;
    const verb = action.split('.').slice(1).join(' ').replace(/_/g, ' ') || 'changed';
    const noun = ENTITY_WORDS[entity] ?? entity.toLowerCase();
    // "created the invoice" reads fine; "offboarding check the engagement" does not, so say what changed instead.
    const last = verb.split(' ').pop() ?? '';
    return /(ed|sent|paid|won|lost|made|done|set)$/.test(last) ? `${verb} ${noun}` : `updated ${noun} (${verb})`;
  }

  private changes(before: unknown, after: unknown) {
    const b = before && typeof before === 'object' && !Array.isArray(before) ? (before as Record<string, unknown>) : {};
    const a = after && typeof after === 'object' && !Array.isArray(after) ? (after as Record<string, unknown>) : {};
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !['id', 'orgId', 'body', 'items', 'config'].includes(k));
    return keys
      .map((field) => ({ field, before: short(b[field]), after: short(a[field]) }))
      .filter((c) => c.before !== c.after)
      .slice(0, 8);
  }
}
