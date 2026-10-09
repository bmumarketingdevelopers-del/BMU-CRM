// v11 clients: building engagements for a client by hand (new onboarding at G1 with its requirement checklist, or an
// existing client migrated in at its current gate with the earlier gates recorded as "migrated" approvals).
import { BadRequestException } from '@nestjs/common';
import { CLIENTS_GATES, type ClientsGate } from '@bmu/shared';
import type { EngagementStatus, Prisma, Tier } from '../generated/prisma/client.js';
import { defaultRequirements } from '../proposals/requirements.js';
import type { SettingsService } from '../settings/settings.service.js';
import { istMonth } from './clients-access.js';

type Tx = Prisma.TransactionClient;

export const gateIndex = (g: string) => CLIENTS_GATES.indexOf(g as ClientsGate);

/** Engagement status that matches a gate for a migrated service. */
export function statusForGate(gate: ClientsGate, billingType: string): EngagementStatus {
  switch (gate) {
    case 'G1':
      return 'onboarding';
    case 'G2':
      return 'planning';
    case 'G3':
      return billingType === 'monthly' ? 'active_retainer' : 'in_production';
    case 'G4':
      return billingType === 'monthly' ? 'active_retainer' : 'in_review';
    case 'G5':
      return billingType === 'monthly' ? 'active_retainer' : 'awaiting_final_payment';
  }
}

/** The requirement checklist for a service: Command Centre's list for that service, else the default list. */
export async function requirementsFor(settings: SettingsService, orgId: string, serviceKey: string) {
  const checklists = await settings.get(orgId, 'requirementChecklists');
  const list = checklists[serviceKey]?.length ? checklists[serviceKey] : checklists.default;
  return list?.length ? list : defaultRequirements(serviceKey);
}

export type NewEngagement = {
  orgId: string;
  clientOrgId: string;
  service: { id: string; key: string; billingType: string };
  tier: Tier;
  amId: string | null;
  startMonth?: string | null;
  /** Migration: the gate it is at today and why. */
  migrate?: { gate: ClientsGate; reason: string } | null;
  paymentPending: boolean;
  requirements: { label: string; type: string }[];
  byUserId: string;
};

/** Creates the engagement + its first cycle (and migrated approvals). Returns the engagement id. */
export async function createEngagementTx(tx: Tx, e: NewEngagement): Promise<string> {
  const now = new Date();
  const monthly = e.service.billingType === 'monthly';
  const gate: ClientsGate = e.migrate?.gate ?? 'G1';
  if (gateIndex(gate) < 0) throw new BadRequestException('Pick a gate from G1 to G5');
  const started = gateIndex(gate) > 0;
  const startMonth = e.startMonth ?? istMonth(now);
  const engagement = await tx.engagement.create({
    data: {
      orgId: e.orgId,
      clientOrgId: e.clientOrgId,
      serviceId: e.service.id,
      tier: e.tier,
      billingType: e.service.billingType as never,
      status: e.migrate ? statusForGate(gate, e.service.billingType) : 'onboarding',
      currentGate: gate,
      amId: e.amId,
      startDate: started ? now : new Date(`${startMonth}-01T00:00:00+05:30`) > now ? new Date(`${startMonth}-01T00:00:00+05:30`) : now,
      startMonth,
      paymentPending: e.paymentPending,
      migrated: !!e.migrate,
      migrationReason: e.migrate?.reason ?? null,
    },
  });
  await tx.cycle.create({
    data: {
      orgId: e.orgId,
      engagementId: engagement.id,
      period: monthly ? (started ? istMonth(now) : startMonth) : 'project',
      status: !started ? 'onboarding' : gate === 'G2' ? 'planning' : 'production',
      rcdAt: started ? now : null,
      startedBy: e.migrate ? 'migrated' : null,
      requirements: started ? undefined : { create: e.requirements.map((r) => ({ orgId: e.orgId, label: r.label, type: r.type, ownerId: e.amId })) },
    },
  });
  // Historical approvals for the gates already passed before the client moved in, marked "migrated".
  if (e.migrate && started) {
    await tx.approval.createMany({
      data: CLIENTS_GATES.slice(0, gateIndex(gate)).map((g) => ({ orgId: e.orgId, targetType: 'engagement', targetId: engagement.id, gate: g, userId: e.byUserId, at: now, migrated: true })),
    });
  }
  return engagement.id;
}
