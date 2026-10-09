// v11 ops: the ONE place where a lead becomes a client by hand (convert_to_client, manual with payment proof).
//
// It reuses the existing onboarding path: the proposal is accepted offline (if it was only sent), which issues the
// first-payment invoice, then OnboardingService.recordFirstPayment creates the client account, owner login, AM,
// engagements at G1 with their requirement checklists and the client thread, and marks the lead won — exactly what
// an online payment does.
//
// A lead with no proposal goes through the clients area's ClientsCreateService.createClientFromLead instead.
import { BadRequestException } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { OnboardingService } from '../proposals/onboarding.service.js';
import type { ProposalsService } from '../proposals/proposals.service.js';

export async function opsCreateClientFromLead(
  deps: { prisma: PrismaService; proposals: ProposalsService; onboarding: OnboardingService },
  approver: Me,
  input: { leadId: string; proposalId: string; amountPaise: number; method: string; ref: string; paidOn: string; proofFileId: string; requestedByName: string },
): Promise<{ clientOrgId: string; invoiceId: string }> {
  const { prisma, proposals, onboarding } = deps;
  const p = await prisma.proposal.findFirst({ where: { id: input.proposalId, leadId: input.leadId, orgId: approver.orgId, deletedAt: null }, include: { lead: true, invoices: true } });
  if (!p) throw new BadRequestException('The proposal no longer exists');
  if (!['sent', 'accepted'].includes(p.status)) throw new BadRequestException(`The proposal is ${p.status}. Send a current version first.`);
  if (p.status === 'sent') {
    const c = (p.lead.contact ?? {}) as { name?: string; email?: string };
    await proposals.accept(p.publicToken, { signerName: c.name || 'Client', signerEmail: c.email || 'offline@bmu.local', signerDesignation: `Accepted offline, recorded by ${input.requestedByName}` });
  }
  const invoice = await prisma.invoice.findFirst({ where: { proposalId: p.id, kind: 'first_payment' } });
  if (!invoice) throw new BadRequestException('The first invoice could not be created for this proposal');
  const ref = `${input.ref} (${input.paidOn})`;
  const result = await onboarding.recordFirstPayment(invoice.id, input.amountPaise, input.method, ref);
  // Keep the proof with the payment so Finance can open it later.
  await prisma.payment.updateMany({ where: { invoiceId: invoice.id, ref }, data: { proofFileId: input.proofFileId, recordedById: approver.id } });
  return { clientOrgId: result.clientOrgId, invoiceId: invoice.id };
}
