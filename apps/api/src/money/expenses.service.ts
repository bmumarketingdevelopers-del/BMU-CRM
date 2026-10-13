import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { expenseDecisionSchema, expensePaidSchema, expenseSchema, formatINR, type ExpenseList, type ExpenseRow, type Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import type { Expense, Prisma } from '../generated/prisma/client.js';
import { canReadFinance, canWriteFinance, assertFinanceWrite } from '../insights/access.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BillingService } from '../requests/billing.service.js';
import { ServiceBillingService } from '../service/service-billing.service.js';
import { dbDate, isoOf, todayIst } from './dates.js';

const payable = (e: { amountPaise: number; gstPaise: number; tdsPaise: number }) => e.amountPaise + e.gstPaise - e.tdsPaise;

/**
 * v18 expenses and vendor bills. Anyone on the team can claim an expense; Finance adds vendor bills. Founder, Admin
 * and Finance approve (not their own claim, except the Founder) and mark them paid. Expenses tied to a client count
 * as that client's cost in Profit; billable ones can be re-billed on a client invoice.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly billing: BillingService,
    private readonly serviceBilling: ServiceBillingService,
  ) {}

  private async toRows(list: Expense[]): Promise<ExpenseRow[]> {
    const userIds = [...new Set(list.flatMap((e) => [e.createdById, e.decidedById]).filter((x): x is string => !!x))];
    const [users, clients, engs] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
      this.prisma.clientOrg.findMany({ where: { id: { in: list.map((e) => e.clientOrgId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
      this.prisma.engagement.findMany({ where: { id: { in: list.map((e) => e.engagementId).filter((x): x is string => !!x) } }, select: { id: true, service: { select: { name: true } } } }),
    ]);
    const un = new Map(users.map((u) => [u.id, u.name]));
    const cn = new Map(clients.map((c) => [c.id, c.name]));
    const en = new Map(engs.map((e) => [e.id, e.service.name]));
    return list.map((e) => ({
      id: e.id,
      kind: e.kind as ExpenseRow['kind'],
      category: e.category as ExpenseRow['category'],
      vendorName: e.vendorName,
      billNumber: e.billNumber,
      description: e.description,
      date: isoOf(e.date),
      dueDate: e.dueDate ? isoOf(e.dueDate) : null,
      amountPaise: e.amountPaise,
      gstPaise: e.gstPaise,
      tdsPaise: e.tdsPaise,
      payablePaise: payable(e),
      clientId: e.clientOrgId,
      client: e.clientOrgId ? (cn.get(e.clientOrgId) ?? null) : null,
      engagementId: e.engagementId,
      project: e.engagementId ? (en.get(e.engagementId) ?? null) : null,
      billable: e.billable,
      invoiceId: e.invoiceId,
      status: e.status as ExpenseRow['status'],
      receiptFileId: e.receiptFileId,
      paidAt: e.paidAt?.toISOString() ?? null,
      paidRef: e.paidRef,
      createdBy: un.get(e.createdById) ?? '',
      createdById: e.createdById,
      decidedBy: e.decidedById ? (un.get(e.decidedById) ?? null) : null,
      decisionNote: e.decisionNote,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  private async one(me: Me, id: string) {
    const e = await this.prisma.expense.findFirst({ where: { id, orgId: me.orgId } });
    if (!e) throw new NotFoundException('Expense not found');
    if (!canReadFinance(me) && e.createdById !== me.id) throw new ForbiddenException('You can only see your own expenses');
    return e;
  }

  async list(me: Me, q: { kind?: string; status?: string; mine?: string }): Promise<ExpenseList> {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    const all = canReadFinance(me) && q.mine !== '1';
    const where: Prisma.ExpenseWhereInput = {
      orgId: me.orgId,
      ...(all ? {} : { createdById: me.id }),
      ...(q.kind === 'expense' || q.kind === 'vendor_bill' ? { kind: q.kind } : {}),
      ...(q.status && ['submitted', 'approved', 'rejected', 'paid'].includes(q.status) ? { status: q.status } : {}),
    };
    const list = await this.prisma.expense.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 500 });
    const monthStart = `${todayIst().slice(0, 7)}-01`;
    const scope = await this.prisma.expense.findMany({ where: { orgId: me.orgId, ...(all ? {} : { createdById: me.id }), status: { in: ['submitted', 'approved', 'paid'] } } });
    return {
      rows: await this.toRows(list),
      totals: {
        waitingPaise: scope.filter((e) => e.status === 'submitted').reduce((s, e) => s + payable(e), 0),
        approvedUnpaidPaise: scope.filter((e) => e.status === 'approved').reduce((s, e) => s + payable(e), 0),
        paidThisMonthPaise: scope.filter((e) => e.status === 'paid' && e.paidAt && isoOf(new Date(e.paidAt.getTime() + 330 * 60_000)) >= monthStart).reduce((s, e) => s + payable(e), 0),
        billableUnbilledPaise: scope.filter((e) => e.billable && !e.invoiceId && e.status !== 'submitted').reduce((s, e) => s + e.amountPaise, 0),
      },
      canDecide: canWriteFinance(me),
    };
  }

  private async checkLinks(me: Me, clientOrgId?: string | null, engagementId?: string | null) {
    if (clientOrgId && !(await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId }, select: { id: true } }))) throw new NotFoundException('Client not found');
    if (engagementId) {
      const e = await this.prisma.engagement.findFirst({ where: { id: engagementId, orgId: me.orgId }, select: { clientOrgId: true } });
      if (!e) throw new NotFoundException('Project not found');
      if (clientOrgId && e.clientOrgId !== clientOrgId) throw new BadRequestException('That project belongs to another client');
      return e.clientOrgId;
    }
    return clientOrgId ?? null;
  }

  async create(me: Me, body: unknown, ip?: string) {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    const input = parse(expenseSchema, body);
    if (input.kind === 'vendor_bill' && !canWriteFinance(me)) throw new ForbiddenException('Only Founder, Branch Manager and Finance add vendor bills');
    const clientOrgId = await this.checkLinks(me, input.clientOrgId, input.engagementId);
    if (input.date > todayIst()) throw new BadRequestException('The date cannot be in the future');
    const e = await this.prisma.expense.create({
      data: {
        orgId: me.orgId,
        kind: input.kind,
        category: input.category,
        vendorName: input.vendorName?.trim() || null,
        billNumber: input.billNumber?.trim() || null,
        description: input.description,
        date: dbDate(input.date),
        dueDate: input.dueDate ? dbDate(input.dueDate) : null,
        amountPaise: input.amountPaise,
        gstPaise: input.gstPaise,
        tdsPaise: input.tdsPaise,
        clientOrgId,
        engagementId: input.engagementId ?? null,
        billable: input.billable,
        receiptFileId: input.receiptFileId ?? null,
        // Finance's own vendor bills are approved as they are entered.
        status: input.kind === 'vendor_bill' ? 'approved' : 'submitted',
        decidedById: input.kind === 'vendor_bill' ? me.id : null,
        decidedAt: input.kind === 'vendor_bill' ? new Date() : null,
        createdById: me.id,
      },
    });
    await this.audit.log(me, `${e.kind}.created`, 'Expense', e.id, undefined, { amountPaise: e.amountPaise, category: e.category, clientOrgId }, ip);
    if (e.status === 'submitted') {
      const approvers = await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, id: { not: me.id }, roles: { some: { role: { baseRole: 'finance' } } } }, select: { id: true } });
      await this.notifications.notify(me.orgId, approvers.map((a) => a.id), { kind: 'expense', title: `${me.name} claimed ${formatINR(payable(e))}`, body: e.description, link: '/admin/finance/expenses', noEmail: true });
    }
    return (await this.toRows([e]))[0];
  }

  async update(me: Me, id: string, body: unknown, ip?: string) {
    const e = await this.one(me, id);
    const fin = canWriteFinance(me);
    if (e.status === 'paid' || e.invoiceId) throw new BadRequestException('Paid or re-billed expenses cannot be changed');
    if (!fin && (e.createdById !== me.id || e.status !== 'submitted')) throw new ForbiddenException('You can change your claim only while it waits for approval');
    const input = parse(expenseSchema, body);
    if (input.kind !== e.kind) throw new BadRequestException('An expense cannot become a vendor bill');
    const clientOrgId = await this.checkLinks(me, input.clientOrgId, input.engagementId);
    const after = await this.prisma.expense.update({
      where: { id },
      data: {
        category: input.category,
        vendorName: input.vendorName?.trim() || null,
        billNumber: input.billNumber?.trim() || null,
        description: input.description,
        date: dbDate(input.date),
        dueDate: input.dueDate ? dbDate(input.dueDate) : null,
        amountPaise: input.amountPaise,
        gstPaise: input.gstPaise,
        tdsPaise: input.tdsPaise,
        clientOrgId,
        engagementId: input.engagementId ?? null,
        billable: input.billable,
        receiptFileId: input.receiptFileId ?? null,
        // A rejected claim that is edited goes back for approval.
        ...(e.status === 'rejected' && e.createdById === me.id ? { status: 'submitted', decidedById: null, decidedAt: null } : {}),
      },
    });
    await this.audit.log(me, `${e.kind}.updated`, 'Expense', id, { amountPaise: e.amountPaise, clientOrgId: e.clientOrgId }, { amountPaise: after.amountPaise, clientOrgId }, ip);
    return (await this.toRows([after]))[0];
  }

  async decide(me: Me, id: string, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const input = parse(expenseDecisionSchema, body);
    const e = await this.one(me, id);
    if (e.status !== 'submitted') throw new BadRequestException('This expense is already decided');
    if (e.createdById === me.id && !me.roles.includes('founder')) throw new ForbiddenException('Someone else must approve your own claim');
    if (!input.approve && !input.note?.trim()) throw new BadRequestException('Say why it is rejected');
    const after = await this.prisma.expense.update({ where: { id }, data: { status: input.approve ? 'approved' : 'rejected', decidedById: me.id, decidedAt: new Date(), decisionNote: input.note?.trim() || null } });
    await this.audit.log(me, input.approve ? 'expense.approved' : 'expense.rejected', 'Expense', id, { status: 'submitted' }, { status: after.status, note: after.decisionNote }, ip);
    if (e.createdById !== me.id) {
      await this.notifications.notify(me.orgId, [e.createdById], {
        kind: 'expense',
        title: input.approve ? `Expense approved: ${formatINR(payable(e))}` : `Expense rejected: ${formatINR(payable(e))}`,
        body: input.approve ? e.description : `${e.description}. Reason: ${after.decisionNote}`,
        link: '/team/expenses',
        noEmail: true,
      });
    }
    return (await this.toRows([after]))[0];
  }

  async markPaid(me: Me, id: string, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const input = parse(expensePaidSchema, body);
    const e = await this.one(me, id);
    if (e.status !== 'approved') throw new BadRequestException(e.status === 'paid' ? 'Already paid' : 'Approve it first');
    const at = input.paidOn ? new Date(`${input.paidOn}T12:00:00+05:30`) : new Date();
    const after = await this.prisma.expense.update({ where: { id }, data: { status: 'paid', paidAt: at, paidRef: input.ref } });
    await this.audit.log(me, `${e.kind}.paid`, 'Expense', id, { status: 'approved' }, { status: 'paid', ref: input.ref }, ip);
    if (e.kind === 'expense' && e.createdById !== me.id) await this.notifications.notify(me.orgId, [e.createdById], { kind: 'expense', title: `Reimbursed ${formatINR(payable(e))}`, body: `${e.description}. Ref ${input.ref}`, link: '/team/expenses', noEmail: true });
    return (await this.toRows([after]))[0];
  }

  async remove(me: Me, id: string, ip?: string) {
    const e = await this.one(me, id);
    if (e.status === 'paid' || e.invoiceId) throw new BadRequestException('Paid or re-billed expenses cannot be deleted');
    if (!canWriteFinance(me) && (e.createdById !== me.id || e.status !== 'submitted')) throw new ForbiddenException('You can delete your claim only while it waits for approval');
    await this.prisma.expense.delete({ where: { id } });
    await this.audit.log(me, `${e.kind}.deleted`, 'Expense', id, { amountPaise: e.amountPaise, description: e.description }, undefined, ip);
    return { ok: true as const };
  }

  /** One invoice for all approved billable expenses of a client that are not billed yet (lines before GST). */
  async rebill(me: Me, clientOrgId: string, ip?: string) {
    assertFinanceWrite(me);
    const list = await this.prisma.expense.findMany({ where: { orgId: me.orgId, clientOrgId, billable: true, invoiceId: null, status: { in: ['approved', 'paid'] } }, orderBy: { date: 'asc' } });
    if (!list.length) throw new BadRequestException('No approved billable expenses to re-bill for this client');
    const inv = await this.prisma.$transaction(async (tx) => {
      const created = await this.billing.issue(tx, { orgId: me.orgId, clientOrgId, kind: 'standard', lines: list.map((e) => ({ label: `Re-billed: ${e.description}`.slice(0, 160), amountPaise: e.amountPaise })), dueInDays: 7 });
      await tx.expense.updateMany({ where: { id: { in: list.map((e) => e.id) } }, data: { invoiceId: created.id } });
      return created;
    });
    await this.audit.log(me, 'expense.rebilled', 'Invoice', inv.id, undefined, { clientOrgId, expenses: list.length, subtotalPaise: inv.subtotalPaise }, ip);
    await this.serviceBilling.invoiceIssued(inv.id).catch(() => undefined);
    return { invoiceId: inv.id, number: inv.number, count: list.length };
  }
}
