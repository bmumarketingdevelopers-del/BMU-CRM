import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { invoiceScheduleSchema, schedulePlanSchema, scheduleUpdateSchema, type InvoiceScheduleRow, type Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { hasRole } from '../creative/scope.js';
import type { InvoiceSchedule, Prisma } from '../generated/prisma/client.js';
import { canReadFinance, assertFinanceWrite } from '../insights/access.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BillingService } from '../requests/billing.service.js';
import { ServiceBillingService } from '../service/service-billing.service.js';
import { dbDate, isoOf, todayIst } from './dates.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

/** v18 invoice schedules: milestones and instalments planned up front and issued automatically on their date. */
@Injectable()
export class SchedulesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('InvoiceSchedules');
  private job?: JobHandle;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
    private readonly serviceBilling: ServiceBillingService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'money.invoice_plans', hint: 'Raises invoices from invoice plans when they fall due', everyMs: 15 * 60_000, run: () => this.tick() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  /** Issues every planned schedule due today or earlier (IST). */
  async tick(now = new Date()) {
    if (this.busy) return { issued: 0, failed: 0 };
    this.busy = true;
    let issued = 0;
    let failed = 0;
    try {
      const due = await this.prisma.invoiceSchedule.findMany({ where: { status: 'planned', dueOn: { lte: dbDate(todayIst(now)) } }, orderBy: { dueOn: 'asc' }, take: 100 });
      for (const s of due) {
        try {
          await this.issueCore(s, null);
          issued++;
        } catch (e) {
          failed++;
          await this.prisma.invoiceSchedule.update({ where: { id: s.id }, data: { error: (e as Error).message.slice(0, 300) } });
        }
      }
      if (issued || failed) this.log.log(`Issued ${issued} scheduled invoice(s), ${failed} failed`);
    } finally {
      this.busy = false;
    }
    return { issued, failed };
  }

  private async issueCore(s: InvoiceSchedule, byId: string | null) {
    // Claim first so a second timer or a double click never issues twice.
    const claimed = await this.prisma.invoiceSchedule.updateMany({ where: { id: s.id, status: 'planned' }, data: { status: 'issued', error: null } });
    if (!claimed.count) throw new BadRequestException('This instalment is already issued');
    try {
      const inv = await this.prisma.$transaction((tx) =>
        this.billing.issue(tx, { orgId: s.orgId, clientOrgId: s.clientOrgId, engagementId: s.engagementId ?? undefined, kind: s.kind === 'retainer' ? 'retainer' : 'standard', lines: [{ label: s.label, amountPaise: s.amountPaise }], dueInDays: 7 }),
      );
      await this.prisma.invoiceSchedule.update({ where: { id: s.id }, data: { invoiceId: inv.id } });
      await this.audit.logSystem(s.orgId, 'invoice.issued_from_schedule', 'Invoice', inv.id, { scheduleId: s.id, byId, amountPaise: s.amountPaise });
      await this.serviceBilling.invoiceIssued(inv.id).catch((e: Error) => this.log.warn(`Invoice email failed: ${e.message}`));
      return inv;
    } catch (e) {
      await this.prisma.invoiceSchedule.update({ where: { id: s.id }, data: { status: 'planned' } });
      throw e;
    }
  }

  private async canRead(me: Me, clientOrgId?: string) {
    if (canReadFinance(me) || hasRole(me, 'founder', 'admin', 'am_lead')) return true;
    if (!clientOrgId || me.type !== 'staff') return false;
    const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId }, select: { amUserId: true } });
    return c?.amUserId === me.id;
  }

  private async rows(where: { where: Prisma.InvoiceScheduleWhereInput; take?: number }): Promise<InvoiceScheduleRow[]> {
    const list = await this.prisma.invoiceSchedule.findMany({ ...where, orderBy: [{ dueOn: 'asc' }, { createdAt: 'asc' }] });
    const [clients, engs, invs] = await Promise.all([
      this.prisma.clientOrg.findMany({ where: { id: { in: [...new Set(list.map((s) => s.clientOrgId))] } }, select: { id: true, name: true } }),
      this.prisma.engagement.findMany({ where: { id: { in: list.map((s) => s.engagementId).filter((x): x is string => !!x) } }, select: { id: true, service: { select: { name: true } } } }),
      this.prisma.invoice.findMany({ where: { id: { in: list.map((s) => s.invoiceId).filter((x): x is string => !!x) } }, select: { id: true, number: true } }),
    ]);
    const cn = new Map(clients.map((c) => [c.id, c.name]));
    const en = new Map(engs.map((e) => [e.id, e.service.name]));
    const inn = new Map(invs.map((i) => [i.id, i.number]));
    return list.map((s) => ({
      id: s.id,
      clientId: s.clientOrgId,
      client: cn.get(s.clientOrgId) ?? '',
      engagementId: s.engagementId,
      project: s.engagementId ? (en.get(s.engagementId) ?? null) : null,
      label: s.label,
      amountPaise: s.amountPaise,
      dueOn: isoOf(s.dueOn),
      kind: s.kind as InvoiceScheduleRow['kind'],
      status: s.status as InvoiceScheduleRow['status'],
      invoiceId: s.invoiceId,
      invoiceNumber: s.invoiceId ? (inn.get(s.invoiceId) ?? null) : null,
      error: s.error,
    }));
  }

  async list(me: Me, q: { clientId?: string; engagementId?: string; status?: string }) {
    let clientId = q.clientId;
    if (q.engagementId && !clientId) clientId = (await this.prisma.engagement.findFirst({ where: { id: q.engagementId, orgId: me.orgId }, select: { clientOrgId: true } }))?.clientOrgId;
    if (!(await this.canRead(me, clientId))) throw new ForbiddenException('Invoice plans are for Finance, leadership and the client’s Client Manager');
    return this.rows({ where: { orgId: me.orgId, clientOrgId: clientId, engagementId: q.engagementId, status: q.status && ['planned', 'issued', 'skipped'].includes(q.status) ? q.status : undefined }, take: 300 });
  }

  private async checkTarget(me: Me, clientOrgId: string, engagementId?: string | null) {
    const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId }, select: { id: true } });
    if (!c) throw new NotFoundException('Client not found');
    if (engagementId) {
      const e = await this.prisma.engagement.findFirst({ where: { id: engagementId, clientOrgId }, select: { id: true } });
      if (!e) throw new BadRequestException('That project belongs to another client');
    }
  }

  async create(me: Me, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const input = parse(invoiceScheduleSchema, body);
    await this.checkTarget(me, input.clientOrgId, input.engagementId);
    const s = await this.prisma.invoiceSchedule.create({
      data: { orgId: me.orgId, clientOrgId: input.clientOrgId, engagementId: input.engagementId ?? null, label: input.label, amountPaise: input.amountPaise, dueOn: dbDate(input.dueOn), kind: input.kind, createdById: me.id },
    });
    await this.audit.log(me, 'invoice_schedule.created', 'InvoiceSchedule', s.id, undefined, { label: s.label, amountPaise: s.amountPaise, dueOn: input.dueOn }, ip);
    return (await this.rows({ where: { id: s.id } }))[0];
  }

  /** Splits a fee into instalments by percentage; the last one takes the rounding so the parts add up exactly. */
  async plan(me: Me, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const input = parse(schedulePlanSchema, body);
    await this.checkTarget(me, input.clientOrgId, input.engagementId);
    let left = input.totalPaise;
    const ids: string[] = [];
    for (const [i, p] of input.parts.entries()) {
      const amount = i === input.parts.length - 1 ? left : Math.round((input.totalPaise * p.pct) / 100);
      left -= amount;
      const s = await this.prisma.invoiceSchedule.create({
        data: { orgId: me.orgId, clientOrgId: input.clientOrgId, engagementId: input.engagementId ?? null, label: p.label, amountPaise: amount, dueOn: dbDate(p.dueOn), kind: 'milestone', createdById: me.id },
      });
      ids.push(s.id);
    }
    await this.audit.log(me, 'invoice_schedule.planned', 'ClientOrg', input.clientOrgId, undefined, { totalPaise: input.totalPaise, parts: input.parts.length, engagementId: input.engagementId }, ip);
    return this.rows({ where: { id: { in: ids } } });
  }

  async update(me: Me, id: string, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const input = parse(scheduleUpdateSchema, body);
    const s = await this.prisma.invoiceSchedule.findFirst({ where: { id, orgId: me.orgId } });
    if (!s) throw new NotFoundException('Instalment not found');
    if (s.status === 'issued') throw new BadRequestException('This instalment is already invoiced');
    const after = await this.prisma.invoiceSchedule.update({
      where: { id },
      data: { label: input.label, amountPaise: input.amountPaise, dueOn: input.dueOn ? dbDate(input.dueOn) : undefined, status: input.status, error: null },
    });
    await this.audit.log(me, 'invoice_schedule.updated', 'InvoiceSchedule', id, { label: s.label, amountPaise: s.amountPaise, dueOn: isoOf(s.dueOn), status: s.status }, { label: after.label, amountPaise: after.amountPaise, dueOn: isoOf(after.dueOn), status: after.status }, ip);
    return (await this.rows({ where: { id } }))[0];
  }

  async issueNow(me: Me, id: string, ip?: string) {
    assertFinanceWrite(me);
    const s = await this.prisma.invoiceSchedule.findFirst({ where: { id, orgId: me.orgId } });
    if (!s) throw new NotFoundException('Instalment not found');
    if (s.status !== 'planned') throw new BadRequestException(s.status === 'issued' ? 'This instalment is already invoiced' : 'This instalment was skipped');
    const inv = await this.issueCore(s, me.id);
    await this.audit.log(me, 'invoice_schedule.issued', 'InvoiceSchedule', id, { status: 'planned' }, { status: 'issued', invoiceId: inv.id }, ip);
    return (await this.rows({ where: { id } }))[0];
  }
}
