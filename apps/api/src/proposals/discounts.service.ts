import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  sellApprovalChain,
  sellApprovalLevelLabels,
  type Me,
  type SellApprovalInbox,
  type SellApprovalItem,
  type SellApprovalLevel,
  type SellApprovalStep,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

const LEVEL_ROLES: Record<SellApprovalLevel, string[]> = {
  manager: ['sales_manager', 'admin', 'founder'],
  founder: ['founder'],
};

const contactName = (c: unknown) => {
  const x = (c ?? {}) as { company?: string; name?: string };
  return x.company || x.name || 'a client';
};

/**
 * Multi-step discount approval (v10): an extra discount above the creator's limit goes to a sales manager first,
 * then to the Founder when it is above the admin limit (settings.discountLimits). Each step is a row; the
 * proposal can be sent only once every step is approved.
 */
@Injectable()
export class DiscountApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  async limits(orgId: string): Promise<Record<string, number>> {
    return (await this.settings.get(orgId, 'discountLimits')) as Record<string, number>;
  }

  async chainFor(me: Me, pct: number): Promise<SellApprovalLevel[]> {
    return sellApprovalChain({ pct, creatorRoles: me.roles, limits: await this.limits(me.orgId) });
  }

  /** People who can decide a step at this level (never the person who made the proposal). */
  async approvers(orgId: string, level: SellApprovalLevel, excludeId?: string | null) {
    const users = await this.prisma.user.findMany({
      where: { orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: { in: LEVEL_ROLES[level] } } } }, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true, roles: { select: { role: { select: { baseRole: true } } } } },
    });
    // Notify the most specific people: sales managers for the manager step when there are any.
    if (level === 'manager') {
      const managers = users.filter((u) => u.roles.some((r) => r.role.baseRole === 'sales_manager'));
      if (managers.length) return managers.map((u) => u.id);
    }
    return users.map((u) => u.id);
  }

  /** Creates the steps for a new proposal and notifies the first approvers. */
  async start(orgId: string, proposalId: string, chain: SellApprovalLevel[], creatorId: string, summary: { client: string; pct: number; version: number }) {
    if (!chain.length) return;
    await this.prisma.discountApprovalStep.createMany({
      data: chain.map((level, i) => ({ orgId, proposalId, step: i + 1, level, status: i === 0 ? 'pending' : 'waiting' })),
    });
    await this.notifyLevel(orgId, chain[0], creatorId, proposalId, summary);
  }

  private async notifyLevel(orgId: string, level: SellApprovalLevel, creatorId: string | null, proposalId: string, s: { client: string; pct: number; version: number }) {
    await this.notifications.notify(orgId, await this.approvers(orgId, level, creatorId), {
      kind: 'discount_approval',
      title: `Approve a ${s.pct}% discount for ${s.client}`,
      body: `Proposal v${s.version} needs ${sellApprovalLevelLabels[level].toLowerCase()} approval before it can be sent.`,
      link: '/team/approvals',
      critical: true,
    });
  }

  canDecide(me: Me, level: SellApprovalLevel, creatorId: string | null) {
    return me.id !== creatorId && me.roles.some((r) => LEVEL_ROLES[level].includes(r));
  }

  async decide(me: Me, stepId: string, approve: boolean, note: string | undefined, ip?: string) {
    const step = await this.prisma.discountApprovalStep.findFirst({
      where: { id: stepId, orgId: me.orgId },
      include: { proposal: { include: { lead: true, discountSteps: { orderBy: { step: 'asc' } } } } },
    });
    if (!step) throw new NotFoundException('Approval not found');
    const p = step.proposal;
    if (step.status !== 'pending') throw new BadRequestException(step.status === 'waiting' ? 'An earlier approval step is still open' : `This step is already ${step.status}`);
    if (p.status !== 'draft') throw new BadRequestException('This proposal is no longer a draft');
    const level = step.level as SellApprovalLevel;
    if (!this.canDecide(me, level, p.createdById)) {
      throw new ForbiddenException(me.id === p.createdById ? "You can't approve your own discount" : `Only the ${sellApprovalLevelLabels[level].toLowerCase()} can decide this step`);
    }
    const now = new Date();
    const client = contactName(p.lead.contact);
    const next = p.discountSteps.find((s) => s.step === step.step + 1);
    await this.prisma.$transaction(async (tx) => {
      await tx.discountApprovalStep.update({ where: { id: step.id }, data: { status: approve ? 'approved' : 'rejected', deciderId: me.id, note: note || null, decidedAt: now } });
      if (!approve) {
        await tx.discountApprovalStep.updateMany({ where: { proposalId: p.id, status: 'waiting' }, data: { status: 'cancelled' } });
        await tx.proposal.update({ where: { id: p.id }, data: { discountStatus: 'rejected' } });
      } else if (next) {
        await tx.discountApprovalStep.update({ where: { id: next.id }, data: { status: 'pending' } });
      } else {
        await tx.proposal.update({ where: { id: p.id }, data: { discountStatus: 'approved', discountApprovedById: me.id } });
        await tx.approval.create({ data: { orgId: me.orgId, targetType: 'proposal_discount', targetId: p.id, userId: me.id } });
      }
    });
    await this.audit.log(me, approve ? 'proposal.discount_step_approved' : 'proposal.discount_rejected', 'Proposal', p.id, undefined, { step: step.step, level, note, extraDiscountPct: p.extraDiscountPct }, ip);
    if (approve && next) {
      await this.notifyLevel(me.orgId, next.level as SellApprovalLevel, p.createdById, p.id, { client, pct: p.extraDiscountPct, version: p.version });
      await this.notifications.notify(me.orgId, [p.createdById], {
        kind: 'discount_progress',
        title: `${me.name} approved the ${p.extraDiscountPct}% discount for ${client}`,
        body: 'It now goes to the Founder for final approval.',
        link: `/team/proposals/${p.id}`,
      });
    } else {
      if (approve) await this.audit.log(me, 'proposal.discount_approved', 'Proposal', p.id, undefined, { extraDiscountPct: p.extraDiscountPct }, ip);
      await this.notifications.notify(me.orgId, [p.createdById, p.lead.ownerId], {
        kind: approve ? 'discount_approved' : 'discount_rejected',
        title: approve ? `Discount approved for ${client}: you can send the proposal now` : `Discount rejected for ${client}`,
        body: approve ? `${p.extraDiscountPct}% approved by ${me.name}.` : `${me.name}: ${note ?? ''}`.trim(),
        link: `/team/proposals/${p.id}`,
        critical: !approve,
      });
    }
    return this.inbox(me);
  }

  /** Approve whichever step is open (kept for the old "Approve discount" button). */
  async approveCurrent(me: Me, proposalId: string, ip?: string) {
    const step = await this.prisma.discountApprovalStep.findFirst({ where: { proposalId, orgId: me.orgId, status: 'pending' }, orderBy: { step: 'asc' } });
    if (!step) throw new BadRequestException('This discount is within limits');
    await this.decide(me, step.id, true, undefined, ip);
  }

  async steps(proposalIds: string[]): Promise<Map<string, SellApprovalStep[]>> {
    const rows = proposalIds.length ? await this.prisma.discountApprovalStep.findMany({ where: { proposalId: { in: proposalIds } }, orderBy: { step: 'asc' } }) : [];
    const names = await this.names(rows.map((r) => r.deciderId));
    const out = new Map<string, SellApprovalStep[]>();
    for (const r of rows) {
      const list = out.get(r.proposalId) ?? [];
      list.push({ id: r.id, step: r.step, level: r.level as SellApprovalLevel, status: r.status as SellApprovalStep['status'], decider: r.deciderId ? (names.get(r.deciderId) ?? null) : null, note: r.note, decidedAt: r.decidedAt?.toISOString() ?? null });
      out.set(r.proposalId, list);
    }
    return out;
  }

  private async names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const users = unique.length ? await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name]));
  }

  async inbox(me: Me): Promise<SellApprovalInbox> {
    const myLevels = (Object.keys(LEVEL_ROLES) as SellApprovalLevel[]).filter((l) => me.roles.some((r) => LEVEL_ROLES[l].includes(r)));
    const limits = await this.limits(me.orgId);
    if (!myLevels.length) return { pending: [], decided: [], limits };
    const include = { proposal: { include: { lead: true } } } as const;
    const [pending, decided] = await Promise.all([
      this.prisma.discountApprovalStep.findMany({ where: { orgId: me.orgId, status: 'pending', level: { in: myLevels }, proposal: { deletedAt: null, status: 'draft' } }, include, orderBy: { createdAt: 'asc' } }),
      this.prisma.discountApprovalStep.findMany({ where: { orgId: me.orgId, deciderId: me.id, status: { in: ['approved', 'rejected'] } }, include, orderBy: { decidedAt: 'desc' }, take: 30 }),
    ]);
    const all = [...pending, ...decided];
    const steps = await this.steps([...new Set(all.map((s) => s.proposalId))]);
    const creators = await this.names(all.map((s) => s.proposal.createdById));
    const toItem = (s: (typeof all)[number]): SellApprovalItem => ({
      stepId: s.id,
      proposalId: s.proposalId,
      client: contactName(s.proposal.lead.contact),
      version: s.proposal.version,
      extraDiscountPct: s.proposal.extraDiscountPct,
      discountPaise: s.proposal.discountPaise,
      totalPaise: s.proposal.totalPaise,
      createdBy: s.proposal.createdById ? (creators.get(s.proposal.createdById) ?? null) : null,
      level: s.level as SellApprovalLevel,
      step: s.step,
      steps: steps.get(s.proposalId) ?? [],
      status: s.status as SellApprovalStep['status'],
      requestedAt: s.createdAt.toISOString(),
      decidedAt: s.decidedAt?.toISOString() ?? null,
      note: s.note,
      canDecide: s.status === 'pending' && this.canDecide(me, s.level as SellApprovalLevel, s.proposal.createdById),
    });
    return { pending: pending.map(toItem), decided: decided.map(toItem), limits };
  }
}
