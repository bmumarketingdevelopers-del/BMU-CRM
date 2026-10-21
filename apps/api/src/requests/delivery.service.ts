import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { ClientFile, FinalDeliveryView, Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BillingService } from './billing.service.js';
import { ServiceBillingService } from '../service/service-billing.service.js';

const DONE_DELIVERABLE = ['approved', 'scheduled', 'published'];

/**
 * Gate 5, Final Delivery: written final sign-off AND final payment cleared.
 * Only then are final files released for download (acceptance criteria).
 */
@Injectable()
export class DeliveryService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
    private readonly notifications: NotificationsService,
    private readonly serviceBilling: ServiceBillingService,
  ) {}

  onModuleInit() {
    this.billing.onPaid(async (inv) => {
      if (inv.kind === 'project_balance' && inv.engagementId) await this.checkGate5(inv.engagementId);
    });
  }

  /** Called when every deliverable is approved (Gate 4). Projects get their 50% balance invoice. */
  async onGate4Passed(engagementId: string) {
    const e = await this.prisma.engagement.findUniqueOrThrow({ where: { id: engagementId }, include: { clientOrg: true, service: true } });
    if (e.billingType !== 'one_time') return;
    if (await this.prisma.invoice.findFirst({ where: { engagementId, kind: 'project_balance' } })) return;
    const balance = await this.balancePaise(e.id);
    if (balance <= 0) return;
    const inv = await this.prisma.$transaction((tx) =>
      this.billing.issue(tx, {
        orgId: e.orgId,
        clientOrgId: e.clientOrgId,
        engagementId: e.id,
        kind: 'project_balance',
        lines: [{ label: `${e.service.name} (${e.tier}): balance before handover`, amountPaise: balance }],
      }),
    );
    await this.audit.logSystem(e.orgId, 'invoice.issued', 'Invoice', inv.id, { kind: 'project_balance', totalPaise: inv.totalPaise });
    // Notice + email with the GST tax invoice to the client's owner and finance people.
    await this.serviceBilling.invoiceIssued(inv.id);
  }

  /** Remaining 50% from the accepted proposal line, or half the tier price when there is no proposal. */
  private async balancePaise(engagementId: string) {
    const e = await this.prisma.engagement.findUniqueOrThrow({ where: { id: engagementId }, include: { clientOrg: true, service: true } });
    if (e.clientOrg.leadId) {
      const p = await this.prisma.proposal.findFirst({ where: { leadId: e.clientOrg.leadId, status: 'accepted' }, orderBy: { acceptedAt: 'desc' } });
      const line = (p?.lines as { kind?: string; key?: string; netPaise?: number; dueNowPaise?: number }[] | undefined)?.find((l) => l.kind === 'service' && l.key === e.service.key);
      if (line?.netPaise !== undefined && line.dueNowPaise !== undefined) return line.netPaise - line.dueNowPaise;
    }
    const tier = await this.prisma.serviceTier.findUnique({ where: { serviceId_tier: { serviceId: e.serviceId, tier: e.tier } } });
    return Math.round((tier?.pricePaise ?? 0) / 2);
  }

  async checkGate5(engagementId: string) {
    const e = await this.prisma.engagement.findUniqueOrThrow({ where: { id: engagementId }, include: { cycles: { include: { deliverables: true } }, service: true } });
    const deliverables = e.cycles.flatMap((c) => c.deliverables);
    const allApproved = deliverables.length > 0 && deliverables.every((d) => DONE_DELIVERABLE.includes(d.status));
    const unpaid = await this.prisma.invoice.count({ where: { engagementId, kind: 'project_balance', status: { not: 'paid' } } });
    if (!allApproved || !e.finalSignedOffAt || unpaid > 0 || e.status === 'delivered') return false;
    const versionIds = deliverables.map((d) => d.approvedVersionId).filter((x): x is string => !!x);
    const versions = await this.prisma.version.findMany({ where: { id: { in: versionIds } }, select: { fileId: true } });
    await this.prisma.$transaction([
      this.prisma.file.updateMany({ where: { id: { in: versions.map((v) => v.fileId) } }, data: { released: true } }),
      this.prisma.engagement.update({ where: { id: engagementId }, data: { status: e.billingType === 'one_time' ? 'delivered' : 'active_retainer', currentGate: 'G5' } }),
    ]);
    await this.audit.logSystem(e.orgId, 'gate.G5.passed', 'Engagement', engagementId, { filesReleased: versions.length });
    await this.notifications.notify(e.orgId, [e.amId, ...(await this.notifications.clientDeciders(e.clientOrgId))], {
      kind: 'final_delivery',
      title: `${e.service.name}: final files released`,
      link: '/client/files',
    });
    return true;
  }

  private clientOrgId(me: Me) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    return me.clientOrg.id;
  }

  async clientDelivery(me: Me): Promise<FinalDeliveryView[]> {
    const rows = await this.prisma.engagement.findMany({
      where: { clientOrgId: this.clientOrgId(me), deletedAt: null, cycles: { some: { deliverables: { some: {} } } } },
      include: { service: true, cycles: { include: { deliverables: true } } },
    });
    const decider = me.clientOrg?.role === 'client_owner' || me.clientOrg?.role === 'client_approver';
    const out: FinalDeliveryView[] = [];
    for (const e of rows) {
      const ds = e.cycles.flatMap((c) => c.deliverables);
      const allApproved = ds.length > 0 && ds.every((d) => DONE_DELIVERABLE.includes(d.status));
      const inv = await this.prisma.invoice.findFirst({ where: { engagementId: e.id, kind: 'project_balance' }, include: { payments: true } });
      out.push({
        engagementId: e.id,
        serviceName: e.service.name,
        status: e.status,
        allApproved,
        signedOffAt: e.finalSignedOffAt?.toISOString() ?? null,
        balanceInvoice: inv ? { id: inv.id, number: inv.number, status: inv.status, totalPaise: inv.totalPaise, paidPaise: inv.payments.reduce((s, p) => s + p.amountPaise, 0) } : null,
        filesReleased: e.status === 'delivered' || (!!e.finalSignedOffAt && e.billingType !== 'one_time' && allApproved),
        can: { signOff: decider && allApproved && !e.finalSignedOffAt },
      });
    }
    return out;
  }

  async signOff(me: Me, engagementId: string, ip?: string) {
    const clientOrgId = this.clientOrgId(me);
    if (!(me.clientOrg?.role === 'client_owner' || me.clientOrg?.role === 'client_approver')) throw new ForbiddenException('Only the account owner or an approver can sign off');
    const e = await this.prisma.engagement.findFirst({ where: { id: engagementId, clientOrgId }, include: { cycles: { include: { deliverables: true } } } });
    if (!e) throw new NotFoundException('Service not found');
    const ds = e.cycles.flatMap((c) => c.deliverables);
    if (!ds.length || !ds.every((d) => DONE_DELIVERABLE.includes(d.status))) throw new BadRequestException('Approve every deliverable before the final sign-off');
    if (e.finalSignedOffAt) throw new BadRequestException('Already signed off');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.approval.create({ data: { orgId: e.orgId, targetType: 'engagement', targetId: e.id, gate: 'G5', userId: me.id, at: now } }),
      this.prisma.engagement.update({ where: { id: e.id }, data: { finalSignedOffAt: now } }),
    ]);
    await this.audit.log(me, 'engagement.final_sign_off', 'Engagement', e.id, undefined, { at: now.toISOString() }, ip);
    const released = await this.checkGate5(e.id);
    if (!released) {
      await this.notifications.notify(e.orgId, [e.amId], { kind: 'final_sign_off', title: `${me.name} signed off the final work`, body: 'Files release once the final invoice is paid.', link: `/team/projects/${e.id}` });
    }
    return this.clientDelivery(me);
  }

  async clientFiles(me: Me): Promise<ClientFile[]> {
    const versions = await this.prisma.version.findMany({
      where: { sentToClientAt: { not: null }, deliverable: { cycle: { engagement: { clientOrgId: this.clientOrgId(me) } } } },
      include: { file: true, deliverable: { include: { cycle: { include: { engagement: { include: { service: true } } } } } } },
      orderBy: { createdAt: 'desc' },
    });
    // One row per deliverable: the approved version, else the latest one sent (older drafts stay in Review Studio).
    const keep = new Map<string, (typeof versions)[number]>();
    for (const v of versions) {
      const cur = keep.get(v.deliverableId);
      const approved = v.deliverable.approvedVersionId === v.id;
      if (!cur || (approved && cur.deliverable.approvedVersionId !== cur.id)) keep.set(v.deliverableId, v);
    }
    return [...keep.values()].map((v) => ({
      id: v.file.id,
      name: v.file.name ?? v.deliverable.title,
      kind: v.file.kind,
      deliverable: v.deliverable.title,
      serviceName: v.deliverable.cycle.engagement.service.name,
      version: v.number,
      released: v.file.released,
      url: v.file.kind === 'link' ? v.file.path : `/api/files/${v.file.id}`,
      downloadUrl: v.file.released ? (v.file.kind === 'link' ? v.file.path : `/api/files/${v.file.id}?download=1`) : null,
      // v37: a one-time project before the final payment: view only.
      preview: !v.file.released && v.deliverable.cycle.engagement.billingType === 'one_time' && v.deliverable.cycle.engagement.status !== 'delivered',
    }));
  }
}
