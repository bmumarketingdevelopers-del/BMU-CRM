// v11 ops: finance actions. Manual invoice (service lines with GST, pass-through lines for ad spend / creator fees
// at cost), drafts, offline payment with proof, due-date extension (> 7 days needs Branch Manager approval) and creator payout
// proposals (the UGC coordinator proposes, Finance approves). Credit notes with Branch Manager approval live in FinanceService.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  financialYear,
  formatINR,
  OPS_DUE_EXTENSION_FREE_DAYS,
  opsCanFinance,
  opsCanManageCreators,
  opsDueDateSchema,
  opsInvoiceCreateSchema,
  opsInvoiceLineKindLabels,
  opsInvoiceTotals,
  opsIsPassThrough,
  opsOfflinePaymentSchema,
  opsPayoutProposeSchema,
  type Me,
  type OpsMaybeApproval,
} from '@bmu/shared';
import { ApprovalsService } from '../actions/approvals.service.js';
import { ActionsRegistry } from '../actions/registry.js';
import { UndoService } from '../actions/undo.service.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { FinanceService } from '../insights/finance.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ServiceBillingService } from '../service/service-billing.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { day, isFounderAdmin, istDay, todayIst } from './ops-util.js';

const TDS_RATE = 0.1;
const DAY = 86_400_000;
const OPEN = ['draft', 'issued', 'partially_paid', 'overdue'];

@Injectable()
export class OpsFinanceService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly registry: ActionsRegistry,
    private readonly approvals: ApprovalsService,
    private readonly undo: UndoService,
    private readonly settings: SettingsService,
    private readonly finance: FinanceService,
    private readonly billing: ServiceBillingService,
  ) {}

  onModuleInit() {
    this.registry.registerUndoModel('invoice');
    this.registry.registerApprovalHandler({
      action: 'invoice.due_extension',
      label: 'Payment due date extension',
      href: (r) => `/admin/finance/invoices/${r.targetId}`,
      apply: async ({ approver, req }) => {
        const p = req.payload as { dueDate: string; reason: string };
        return this.applyDueDate(approver, req.targetId, p.dueDate, `${p.reason} (approved)`);
      },
    });
    this.registry.registerApprovalHandler({
      action: 'payout.create',
      label: 'Creator payout',
      href: () => '/admin/finance/payouts',
      apply: async ({ approver, req }) => {
        const p = req.payload as { creatorId: string; briefId: string; amountPaise: number; note: string | null };
        return this.createPayout(approver, p, req.requestedById);
      },
    });
  }

  private assertFinance(me: Me) {
    if (!opsCanFinance(me)) throw new ForbiddenException('Only Founder, Branch Manager and Finance can do this');
  }

  // -------------------------------------------------------------------------
  // Manual invoice

  async options(me: Me) {
    this.assertFinance(me);
    const [clients, gst] = await Promise.all([
      this.prisma.clientOrg.findMany({
        where: { orgId: me.orgId, deletedAt: null, archivedAt: null },
        select: { id: true, name: true, gstin: true, engagements: { where: { deletedAt: null }, select: { id: true, service: { select: { name: true } } } } },
        orderBy: { name: 'asc' },
      }),
      this.settings.get(me.orgId, 'gst'),
    ]);
    return { clients: clients.map((c) => ({ id: c.id, name: c.name, gstin: c.gstin, engagements: c.engagements.map((e) => ({ id: e.id, name: e.service.name })) })), gstRatePct: gst.ratePct };
  }

  private async nextNumber(tx: Pick<PrismaService, 'invoice'>, orgId: string) {
    const fy = financialYear(new Date());
    const prefix = `BMU/${fy}/`;
    const last = await tx.invoice.findMany({ where: { orgId, number: { startsWith: prefix } }, select: { number: true } });
    const max = last.reduce((m, i) => Math.max(m, Number(i.number.slice(prefix.length)) || 0), 0);
    return `${prefix}${String(max + 1).padStart(4, '0')}`;
  }

  async createInvoice(me: Me, body: unknown, ip?: string) {
    this.assertFinance(me);
    const input = parse(opsInvoiceCreateSchema, body);
    const client = await this.prisma.clientOrg.findFirst({ where: { id: input.clientOrgId, orgId: me.orgId, deletedAt: null } });
    if (!client) throw new BadRequestException('Pick a client');
    if (client.archivedAt) throw new BadRequestException(`${client.name} is archived. Restore the client first.`);
    if (input.engagementId) {
      const e = await this.prisma.engagement.findFirst({ where: { id: input.engagementId, clientOrgId: client.id, deletedAt: null } });
      if (!e) throw new BadRequestException('That service does not belong to this client');
    }
    if (input.dueDate < todayIst()) throw new BadRequestException('The due date is in the past');
    // Pass-through items (ad spend, creator fees) must be their own lines, never mixed into a service line.
    for (const l of input.lines) {
      if (l.kind === 'service' && /\b(ad ?spend|ads? budget|boost|creator fee|influencer fee)\b/i.test(l.label)) {
        throw new BadRequestException(`"${l.label}" looks like a pass-through cost. Put ad spend and creator fees on their own pass-through line.`);
      }
    }
    const gst = await this.settings.get(me.orgId, 'gst');
    const totals = opsInvoiceTotals(input.lines, gst.ratePct);
    const lines = input.lines.map((l) => {
      const pass = opsIsPassThrough(l.kind);
      const label = pass ? `${l.label} (${opsInvoiceLineKindLabels[l.kind].replace(/ \(pass-through\)/, '')}, at cost, no GST)` : l.label;
      return { label, name: label, amountPaise: l.amountPaise, kind: l.kind, passThrough: pass };
    });
    const inv = await this.prisma.$transaction(async (tx) =>
      tx.invoice.create({
        data: {
          orgId: me.orgId,
          clientOrgId: client.id,
          engagementId: input.engagementId || null,
          number: await this.nextNumber(tx, me.orgId),
          lines,
          subtotalPaise: totals.subtotalPaise,
          gstPaise: totals.gstPaise,
          totalPaise: totals.totalPaise,
          dueDate: istDay(input.dueDate),
          status: input.issue ? 'issued' : 'draft',
          kind: 'standard',
          createdById: me.id,
          notes: input.notes || null,
        },
      }),
    );
    await this.audit.log(me, input.issue ? 'invoice.issued' : 'invoice.drafted', 'Invoice', inv.id, undefined, { number: inv.number, clientOrgId: client.id, totalPaise: inv.totalPaise, passThroughPaise: totals.passThroughPaise, gstPaise: totals.gstPaise, dueDate: input.dueDate, manual: true }, ip);
    if (input.issue) await this.billing.invoiceIssued(inv.id);
    return { id: inv.id, number: inv.number, status: inv.status, totalPaise: inv.totalPaise, message: input.issue ? `Invoice ${inv.number} issued for ${formatINR(inv.totalPaise)}. The client has been told.` : `Draft invoice ${inv.number} saved. Issue it when ready.` };
  }

  async drafts(me: Me) {
    this.assertFinance(me);
    const rows = await this.prisma.invoice.findMany({ where: { orgId: me.orgId, status: 'draft' }, include: { clientOrg: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } });
    return rows.map((i) => ({ id: i.id, number: i.number, client: i.clientOrg?.name ?? 'No client yet', clientId: i.clientOrgId, totalPaise: i.totalPaise, dueDate: i.dueDate.toISOString(), createdAt: i.createdAt.toISOString() }));
  }

  async issue(me: Me, id: string, ip?: string) {
    this.assertFinance(me);
    const inv = await this.prisma.invoice.findFirst({ where: { id, orgId: me.orgId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status !== 'draft') throw new BadRequestException('Only draft invoices can be issued');
    if (!inv.clientOrgId) throw new BadRequestException('Pick a client for this invoice first');
    const due = inv.dueDate < new Date() ? istDay(new Date(Date.now() + 7 * DAY + 5.5 * 3_600_000).toISOString().slice(0, 10)) : inv.dueDate;
    await this.prisma.invoice.update({ where: { id }, data: { status: 'issued', dueDate: due, createdAt: new Date() } });
    await this.audit.log(me, 'invoice.issued', 'Invoice', id, { status: 'draft' }, { status: 'issued', dueDate: due }, ip);
    await this.billing.invoiceIssued(id);
    return { id, message: `Invoice ${inv.number} issued` };
  }

  // -------------------------------------------------------------------------
  // Offline payment with proof

  async offlinePayment(me: Me, id: string, body: unknown, ip?: string) {
    this.assertFinance(me);
    const input = parse(opsOfflinePaymentSchema, body);
    const proof = await this.prisma.file.findFirst({ where: { id: input.proofFileId, orgId: me.orgId } });
    if (!proof) throw new BadRequestException('Upload the proof again');
    const view = await this.finance.recordPayment(me, id, { amountPaise: input.amountPaise, method: input.method, ref: input.ref, at: input.at, tdsPaise: input.tdsPaise }, ip);
    await this.prisma.payment.updateMany({ where: { invoiceId: id, ref: input.ref.trim() }, data: { proofFileId: proof.id, recordedById: me.id } });
    await this.prisma.file.update({ where: { id: proof.id }, data: { clientOrgId: view.clientId ?? undefined, folder: 'general', tags: { push: 'payment-proof' } } });
    return view;
  }

  // -------------------------------------------------------------------------
  // Due date

  async changeDueDate(me: Me, id: string, body: unknown, ip?: string): Promise<OpsMaybeApproval & { undo?: unknown }> {
    this.assertFinance(me);
    const input = parse(opsDueDateSchema, body);
    const inv = await this.prisma.invoice.findFirst({ where: { id, orgId: me.orgId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (!OPEN.includes(inv.status)) throw new BadRequestException('Only unpaid invoices can get a new due date');
    const next = istDay(input.dueDate);
    if (input.dueDate < todayIst()) throw new BadRequestException('The new due date is in the past');
    const days = Math.round((next.getTime() - inv.dueDate.getTime()) / DAY);
    if (days <= 0) throw new BadRequestException(`Pick a date after the current due date (${day(inv.dueDate)})`);
    if (days > OPS_DUE_EXTENSION_FREE_DAYS && !isFounderAdmin(me)) {
      const req = await this.approvals.create(
        me,
        {
          action: 'invoice.due_extension',
          targetType: 'invoice',
          targetId: id,
          summary: `Move the due date of ${inv.number} by ${days} days`,
          payload: { dueDate: input.dueDate, reason: input.reason },
          reason: input.reason,
          approverId: null,
          approverRoles: ['admin'],
          diff: [{ field: 'Due date', before: day(inv.dueDate), after: day(next) }],
        },
        ip,
      );
      return { applied: false, approvalId: req.id, message: `More than ${OPS_DUE_EXTENSION_FREE_DAYS} days: sent to a Branch Manager for approval` };
    }
    const r = await this.applyDueDate(me, id, input.dueDate, input.reason, ip);
    return { applied: true, approvalId: null, message: r.message, undo: r.undo };
  }

  private async applyDueDate(me: Me, id: string, dueDate: string, reason: string, ip?: string) {
    const inv = await this.prisma.invoice.findFirstOrThrow({ where: { id, orgId: me.orgId } });
    const next = istDay(dueDate);
    await this.prisma.invoice.update({ where: { id }, data: { dueDate: next, dueDateChanges: { increment: 1 }, ...(inv.status === 'overdue' ? { status: 'issued' } : {}) } });
    await this.audit.log(me, 'invoice.due_date_changed', 'Invoice', id, { dueDate: inv.dueDate }, { dueDate: next, reason }, ip);
    if (inv.clientOrgId && inv.status !== 'draft') {
      await this.notifications.notify(me.orgId, await this.notifications.clientBilling(inv.clientOrgId), { kind: 'invoice_reminder', title: `New due date for invoice ${inv.number}`, body: `It is now due on ${day(next)}.`, link: `/client/billing/${id}`, noEmail: true });
    }
    const undo = await this.undo.create(me, `Due date of ${inv.number} changed`, [{ model: 'invoice', id, data: { dueDate: inv.dueDate.toISOString(), dueDateChanges: inv.dueDateChanges, status: inv.status } }]);
    return { message: `Due date moved to ${day(next)}`, undo };
  }

  // -------------------------------------------------------------------------
  // Creator payouts

  async proposePayout(me: Me, body: unknown, ip?: string): Promise<OpsMaybeApproval> {
    if (!opsCanManageCreators(me) && !opsCanFinance(me)) throw new ForbiddenException('Only the UGC coordinator or Finance can propose creator payouts');
    const input = parse(opsPayoutProposeSchema, body);
    const { brief, creator } = await this.checkPayout(me, input);
    if (opsCanFinance(me)) {
      const r = await this.createPayout(me, { ...input, note: input.note ?? null }, me.id, ip);
      return { applied: true, approvalId: null, id: r.id, message: `Payout of ${formatINR(input.amountPaise)} booked for ${creator.user.name}` };
    }
    const req = await this.approvals.create(
      me,
      {
        action: 'payout.create',
        targetType: 'creator_brief',
        targetId: brief.id,
        summary: `Pay ${creator.user.name} ${formatINR(input.amountPaise)} for "${brief.title}"`,
        payload: { ...input, note: input.note ?? null },
        reason: input.note || `Brief fee ${formatINR(brief.feePaise)}`,
        approverId: null,
        approverRoles: ['finance'],
        diff: [{ field: 'Payout', before: null, after: `${formatINR(input.amountPaise)} (TDS ${formatINR(Math.round(input.amountPaise * TDS_RATE))})` }],
      },
      ip,
    );
    return { applied: false, approvalId: req.id, message: 'Sent to Finance for approval' };
  }

  private async checkPayout(me: Me, input: { creatorId: string; briefId: string; amountPaise: number }) {
    const creator = await this.prisma.creator.findFirst({ where: { id: input.creatorId, orgId: me.orgId }, include: { user: { select: { name: true, id: true } } } });
    if (!creator) throw new BadRequestException('Pick a creator');
    const brief = await this.prisma.creatorBrief.findFirst({ where: { id: input.briefId, orgId: me.orgId } });
    if (!brief || brief.creatorId !== creator.id) throw new BadRequestException('That brief is not with this creator');
    if (['offered', 'declined', 'cancelled'].includes(brief.status)) throw new BadRequestException(`The brief is ${brief.status}. Pay only for work the creator has done.`);
    if (await this.prisma.creatorPayout.findUnique({ where: { briefId: brief.id } })) throw new BadRequestException('A payout is already booked for this brief');
    if (input.amountPaise > brief.feePaise * 2) throw new BadRequestException(`That is more than double the agreed fee (${formatINR(brief.feePaise)})`);
    return { brief, creator };
  }

  private async createPayout(me: Me, p: { creatorId: string; briefId: string; amountPaise: number; note: string | null }, requestedById: string, ip?: string) {
    const { brief, creator } = await this.checkPayout(me, p);
    const tdsPaise = Math.round(p.amountPaise * TDS_RATE);
    const payout = await this.prisma.creatorPayout.create({ data: { orgId: me.orgId, creatorId: creator.id, briefId: brief.id, amountPaise: p.amountPaise, tdsPaise, netPaise: p.amountPaise - tdsPaise } });
    await this.audit.log(me, 'payout.created', 'CreatorPayout', payout.id, undefined, { creatorId: creator.id, briefId: brief.id, amountPaise: p.amountPaise, tdsPaise, proposedBy: requestedById, note: p.note }, ip);
    await this.audit.log(me, 'creator_brief.payout_booked', 'CreatorBrief', brief.id, undefined, { payoutId: payout.id, amountPaise: p.amountPaise }, ip);
    await this.notifications.notify(me.orgId, [creator.user.id], { kind: 'payout_booked', title: `Payout of ${formatINR(p.amountPaise - tdsPaise)} booked`, body: `For "${brief.title}". ${formatINR(tdsPaise)} TDS is held back.`, link: '/creator/payouts' });
    if (requestedById !== me.id) await this.notifications.notify(me.orgId, [requestedById], { kind: 'approval_decided', title: `Payout for ${creator.user.name} approved`, link: '/team/creators' });
    return { id: payout.id };
  }
}
