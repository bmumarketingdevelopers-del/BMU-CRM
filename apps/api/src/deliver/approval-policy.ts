// v10 deliver: multi-approver client approvals ("any one approver | owner must approve | all approvers").
// Each person's approval is an immutable Approval row (targetType "<target>_vote", versionId = the round).
// The final gate Approval (G2 plan / G4 deliverable) is only written once the client's rule is satisfied.
import { DELIVER_APPROVAL_MODES, deliverApprovalModeLabels, type DeliverApprovalMode, type DeliverApprovalStatus } from '@bmu/shared';
import type { PrismaService } from '../prisma/prisma.service.js';

type Db = Pick<PrismaService, 'clientOrg' | 'clientUser' | 'approval' | 'user'>;

export const asApprovalMode = (v: string | null | undefined): DeliverApprovalMode =>
  (DELIVER_APPROVAL_MODES as readonly string[]).includes(v ?? '') ? (v as DeliverApprovalMode) : 'any';

/** Owners and approvers of a client account who can still sign in. */
export async function clientDecidersOf(db: Db, clientOrgId: string) {
  const rows = await db.clientUser.findMany({
    where: { clientOrgId, clientRole: { in: ['client_owner', 'client_approver'] }, user: { deletedAt: null, status: { not: 'suspended' } } },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { clientRole: 'desc' },
  });
  return rows.map((r) => ({ userId: r.user.id, name: r.user.name, role: (r.clientRole === 'client_owner' ? 'owner' : 'approver') as 'owner' | 'approver' }));
}

/** The plan's current presentation round: the latest internal "approve and send" for this plan. */
export async function planRound(db: Pick<PrismaService, 'approval'>, planId: string) {
  const sent = await db.approval.findFirst({ where: { targetType: 'plan_internal', targetId: planId }, orderBy: { at: 'desc' } });
  return sent?.id ?? planId;
}

const join = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * Who has approved this round and who is still needed under the client's rule.
 * `finalApproverId` marks a round already approved under the old single-approver flow.
 */
export async function approvalStatus(
  db: Db,
  input: { clientOrgId: string; target: 'deliverable' | 'plan'; targetId: string; round: string; finalApproverId?: string | null; finalAt?: Date | null },
): Promise<DeliverApprovalStatus> {
  const org = await db.clientOrg.findUnique({ where: { id: input.clientOrgId }, select: { approvalMode: true } });
  const mode = asApprovalMode(org?.approvalMode);
  const deciders = await clientDecidersOf(db, input.clientOrgId);
  const votes = await db.approval.findMany({ where: { targetType: `${input.target}_vote`, targetId: input.targetId, versionId: input.round }, orderBy: { at: 'asc' } });
  const votedAt = new Map(votes.map((v) => [v.userId, v.at]));
  if (input.finalApproverId && !votedAt.has(input.finalApproverId)) votedAt.set(input.finalApproverId, input.finalAt ?? new Date());
  // People who voted but are no longer listed (e.g. left the account) still count as approvals on record.
  const extra = [...votedAt.keys()].filter((id) => !deciders.some((d) => d.userId === id));
  const extraUsers = extra.length ? await db.user.findMany({ where: { id: { in: extra } }, select: { id: true, name: true } }) : [];
  const people = [...deciders, ...extraUsers.map((u) => ({ userId: u.id, name: u.name, role: 'approver' as const }))];

  const approvers = people.map((p) => ({
    ...p,
    required: mode === 'all' ? deciders.some((d) => d.userId === p.userId) : mode === 'owner' ? p.role === 'owner' : false,
    approvedAt: votedAt.get(p.userId)?.toISOString() ?? null,
  }));
  const approvedNames = approvers.filter((a) => a.approvedAt).map((a) => a.name);
  let satisfied: boolean;
  let pending: string[];
  if (mode === 'all') {
    pending = approvers.filter((a) => a.required && !a.approvedAt).map((a) => a.name);
    satisfied = approvedNames.length > 0 && pending.length === 0;
  } else if (mode === 'owner') {
    const ownerApproved = approvers.some((a) => a.role === 'owner' && a.approvedAt);
    satisfied = ownerApproved;
    const owners = approvers.filter((a) => a.role === 'owner').map((a) => a.name);
    pending = ownerApproved ? [] : owners.length > 1 ? [`one owner (${join(owners)})`] : owners;
  } else {
    satisfied = approvedNames.length > 0;
    pending = satisfied ? [] : ['any one approver'];
  }
  if (input.finalApproverId) satisfied = true;
  const summary = [
    approvedNames.length ? `Approved by ${join(approvedNames)}.` : 'No approvals yet.',
    !satisfied && pending.length ? `Waiting for ${join(pending)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { mode, modeLabel: deliverApprovalModeLabels[mode].label, satisfied, approvers, pending: satisfied ? [] : pending, summary };
}

/** User ids still needed for the round (for reminders). In "any" mode everyone who hasn't approved is reminded. */
export function pendingUserIds(status: DeliverApprovalStatus) {
  if (status.satisfied) return [];
  if (status.mode === 'any') return status.approvers.filter((a) => !a.approvedAt).map((a) => a.userId);
  if (status.mode === 'owner') return status.approvers.filter((a) => a.role === 'owner' && !a.approvedAt).map((a) => a.userId);
  return status.approvers.filter((a) => a.required && !a.approvedAt).map((a) => a.userId);
}
