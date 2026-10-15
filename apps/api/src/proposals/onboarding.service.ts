import { Injectable, Logger } from '@nestjs/common';
import { emptyGateTrack, normaliseIdentifier, SELL_RENEWAL_MONTHS } from '@bmu/shared';
import type { ProposalLine } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { logLeadActivity } from './lead-activity.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { defaultRequirements } from './requirements.js';

/**
 * Automation "Payment received → create client account, send agreement copy, assign CM, welcome".
 * Idempotent: a repeated payment callback for the same invoice does nothing.
 */
@Injectable()
export class OnboardingService {
  private readonly log = new Logger('Onboarding');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  async recordFirstPayment(invoiceId: string, amountPaise: number, method: string, ref: string | null) {
    // Requirement checklists from Command Centre settings: the service's own list, else the default list.
    const invoiceOrg = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, select: { orgId: true } });
    const checklists = invoiceOrg ? await this.settings.get(invoiceOrg.orgId, 'requirementChecklists') : {};
    const requirementsFor = (serviceKey: string) => {
      const list = checklists[serviceKey]?.length ? checklists[serviceKey] : checklists.default;
      return list?.length ? list : defaultRequirements(serviceKey);
    };
    const result = await this.prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { proposal: { include: { lead: true } }, payments: true },
      });
      if (invoice.status === 'paid') return { clientOrgId: invoice.clientOrgId!, created: false };
      const proposal = invoice.proposal!;
      const lead = proposal.lead;
      const contact = lead.contact as { name: string; email?: string; phone?: string; company?: string };
      const orgId = invoice.orgId;

      await tx.payment.create({ data: { orgId, invoiceId, amountPaise, method, ref } });

      // Client manager with the fewest active clients ("Auto CM assignment by load").
      const ams = await tx.user.findMany({
        where: { orgId, status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'account_manager' } } } },
        include: { _count: { select: { managedClients: true } } },
      });
      const am = ams.sort((a, b) => a._count.managedClients - b._count.managedClients)[0] ?? null;

      const renewal = proposal.kind === 'renewal' && proposal.renewalClientOrgId ? await tx.clientOrg.findUnique({ where: { id: proposal.renewalClientOrgId } }) : null;
      const clientOrg =
        renewal ??
        (await tx.clientOrg.findUnique({ where: { leadId: lead.id } })) ??
        (await tx.clientOrg.create({
          data: { orgId, leadId: lead.id, name: contact.company || contact.name, amUserId: am?.id, tenureStart: new Date() },
        }));

      const email = contact.email ? normaliseIdentifier(contact.email) : null;
      const phone = contact.phone ? normaliseIdentifier(contact.phone) : null;
      let owner = await tx.user.findFirst({
        where: { orgId, OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] },
      });
      // Renewals keep the client's existing owner when the contact on file is someone else.
      if (!owner && renewal) {
        const existingOwner = await tx.clientUser.findFirst({ where: { clientOrgId: clientOrg.id, clientRole: 'client_owner' }, include: { user: true } });
        owner = existingOwner?.user ?? null;
      }
      owner ??= await tx.user.create({
        data: { orgId, type: 'client', name: contact.name, email, phone, status: 'invited' },
      });
      const ownerRole = await tx.role.findFirstOrThrow({ where: { orgId, baseRole: 'client_owner', isCustom: false } });
      await tx.clientUser.upsert({
        where: { userId: owner.id },
        update: {},
        create: { userId: owner.id, orgId, clientOrgId: clientOrg.id, clientRole: 'client_owner', brandScope: [] },
      });
      await tx.userRole.upsert({
        where: { userId_roleId_scopeRef: { userId: owner.id, roleId: ownerRole.id, scopeRef: '' } },
        update: {},
        create: { userId: owner.id, roleId: ownerRole.id },
      });

      const book = await tx.priceBook.findUniqueOrThrow({ where: { id: proposal.priceBookId }, include: { services: true } });
      const now = new Date();
      const existing = renewal
        ? await tx.engagement.findMany({ where: { clientOrgId: clientOrg.id, deletedAt: null, status: { notIn: ['offboarding'] } }, include: { service: { select: { key: true } } }, orderBy: { createdAt: 'desc' } })
        : [];
      const renewed: string[] = [];
      for (const line of proposal.lines as unknown as ProposalLine[]) {
        if (line.kind !== 'service' || !line.tier) continue;
        const service = book.services.find((s) => s.key === line.key);
        if (!service) continue;
        // Renewal of a live retainer: extend it (new tier, new end date) instead of opening a duplicate.
        const current = existing.find((e) => e.service.key === service.key && e.billingType === 'monthly' && service.billingType === 'monthly' && !renewed.includes(e.id));
        if (current) {
          const base = current.endDate && current.endDate > now ? current.endDate : now;
          const endDate = new Date(base);
          endDate.setMonth(endDate.getMonth() + SELL_RENEWAL_MONTHS);
          await tx.engagement.update({ where: { id: current.id }, data: { tier: line.tier, endDate, renewedAt: now, renewalCount: { increment: 1 }, serviceId: service.id, amId: current.amId ?? am?.id } });
          renewed.push(current.id);
          continue;
        }
        const engagement = await tx.engagement.create({
          data: {
            orgId,
            clientOrgId: clientOrg.id,
            serviceId: service.id,
            tier: line.tier,
            billingType: service.billingType,
            status: 'onboarding',
            currentGate: 'G1',
            amId: clientOrg.amUserId ?? am?.id,
            startDate: now,
          },
        });
        await tx.cycle.create({
          data: {
            orgId,
            engagementId: engagement.id,
            period: service.billingType === 'monthly' ? now.toISOString().slice(0, 7) : 'project',
            status: 'onboarding',
            requirements: {
              create: requirementsFor(service.key).map((r) => ({ orgId, label: r.label, type: r.type, ownerId: clientOrg.amUserId ?? am?.id })),
            },
          },
        });
      }

      if (!(await tx.thread.findFirst({ where: { clientOrgId: clientOrg.id, type: 'client_am' } }))) {
        await tx.thread.create({ data: { orgId, clientOrgId: clientOrg.id, type: 'client_am' } });
      }
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'paid', clientOrgId: clientOrg.id } });
      const wasStage = lead.stage;
      await tx.lead.update({ where: { id: lead.id }, data: { stage: 'won' } });
      return {
        clientOrgId: clientOrg.id,
        created: true,
        orgId,
        amName: am?.name ?? null,
        amId: clientOrg.amUserId ?? am?.id ?? null,
        ownerEmail: email,
        ownerId: owner.id,
        leadId: lead.id,
        leadOwnerId: lead.ownerId,
        wasStage,
        renewal: !!renewal,
        renewed,
        clientName: clientOrg.name,
      };
    });

    if (result.created && 'orgId' in result) {
      await this.audit.logSystem(result.orgId!, 'client.onboarded', 'ClientOrg', result.clientOrgId, {
        invoiceId,
        amountPaise,
        method,
        accountManager: result.amName,
        gateTrack: emptyGateTrack(),
      });
      const r = result as Extract<typeof result, { orgId: string }>;
      if (r.wasStage !== 'won') await this.audit.logSystem(r.orgId, 'lead.won', 'Lead', r.leadId, { stage: 'won', before: r.wasStage });
      if (r.renewed.length) await this.audit.logSystem(r.orgId, 'engagement.renewed', 'ClientOrg', r.clientOrgId, { engagementIds: r.renewed, months: SELL_RENEWAL_MONTHS });
      await logLeadActivity(this.prisma, { orgId: r.orgId, leadId: r.leadId, kind: 'system', body: r.renewal ? `Renewal paid. ${r.renewed.length} retainer(s) extended by ${SELL_RENEWAL_MONTHS} months.` : `First payment received. Client account created${r.amName ? ` and ${r.amName} assigned as client manager` : ''}.` });
      await this.notifications.notify(r.orgId, [r.ownerId], {
        kind: r.renewal ? 'renewal_confirmed' : 'welcome',
        title: r.renewal ? 'Thank you for renewing with BMU' : 'Welcome to BMU! Your account is ready',
        body: r.renewal ? 'Your services continue without a break.' : `${r.amName ?? 'Your client manager'} will help you get started. First step: share the items on your onboarding checklist.`,
        link: r.renewal ? '/client' : '/client/onboarding',
      });
      await this.notifications.notify(r.orgId, [r.amId], {
        kind: r.renewal ? 'renewal_paid' : 'client_assigned',
        title: r.renewal ? `${r.clientName} renewed` : `New client: ${r.clientName} is yours`,
        body: r.renewal ? 'Retainers extended.' : 'First payment received. Start onboarding (Gate 1: requirements).',
        link: `/team/clients/${r.clientOrgId}`,
      });
      await this.notifications.notify(r.orgId, [r.leadOwnerId], { kind: 'deal_won', title: `${r.clientName} paid. Deal won!`, link: `/team/leads/${r.leadId}` });
      // Welcome email/WhatsApp with the agreement copy goes out here once messaging is connected.
      this.log.log(`Client account ${result.clientOrgId} ${r.renewal ? 'renewed' : 'created'}; welcome sent to ${result.ownerEmail ?? 'client'}`);
    }
    return result;
  }
}
