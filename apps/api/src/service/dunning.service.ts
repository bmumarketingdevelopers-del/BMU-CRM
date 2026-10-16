// Dunning: overdue invoice reminders at the steps set in settings (default 1, 7 and 14 working days late),
// with a friendlier tone first and a firm final notice. Each step: client message in their thread,
// in-app + email to the client's owner/finance people, and an alert for Finance and the CM.
// Stops by itself once the invoice is paid; pauses while a promise-to-pay date is in the future.
import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  addWorkingDays,
  formatINR,
  isWorkingDay,
  istDate,
  servicePromiseSchema,
  type Me,
  type ServiceCollectionsActions,
  type ServiceDunningRunResult,
} from '@bmu/shared';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { assertFinanceWrite, assertMoney, canWriteFinance } from '../insights/access.js';
import { loadLedger, type LedgerInvoice } from '../insights/ledger.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { holidaysFor } from '../production/generate.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { buildTaxInvoice, taxInvoiceEmailHtml, taxInvoiceEmailText } from './tax-invoice.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';
import { clientVisibleInvoiceWhere, invoiceHeld, readInvoiceBranding } from './invoice-branding.service.js';

const DAY = 86_400_000;
const INTERVAL_MS = 15 * 60_000;
/** Manual reminders use step numbers from here up, so they never block the automatic steps. */
const MANUAL_STEP_BASE = 100;

type Tone = 'friendly' | 'firm' | 'final';

/** Working days (Mon–Sat, not holidays) after the due date, up to and including today. */
export function workingDaysLate(due: Date, now: Date, holidays: readonly string[]) {
  if (now <= due) return 0;
  let n = 0;
  const end = istDate(now);
  let cursor = new Date(new Date(`${istDate(due)}T12:00:00+05:30`).getTime() + DAY);
  for (let i = 0; i < 400 && istDate(cursor) <= end; i++) {
    if (isWorkingDay(cursor, holidays)) n++;
    cursor = new Date(cursor.getTime() + DAY);
  }
  return n;
}

const calendarDaysLate = (due: Date, now: Date) => Math.max(0, Math.floor((new Date(`${istDate(now)}T00:00:00Z`).getTime() - new Date(`${istDate(due)}T00:00:00Z`).getTime()) / DAY));

function copy(tone: Tone, inv: { number: string }, balance: string, days: number, dayWord: string) {
  const late = `${days} ${dayWord}${days === 1 ? '' : 's'}`;
  if (tone === 'friendly')
    return {
      title: `Friendly reminder: invoice ${inv.number} is due`,
      message: `Hi! A quick reminder that invoice ${inv.number} (${balance}) was due ${late} ago. If you've already paid, thank you, please ignore this. You can pay online from Billing in the app, or by bank transfer / UPI.`,
    };
  if (tone === 'firm')
    return {
      title: `Payment overdue: invoice ${inv.number} (${balance})`,
      message: `Invoice ${inv.number} for ${balance} is now ${late} overdue. Please arrange payment this week, or reply here with the date you expect to pay so we can plan around it.`,
    };
  return {
    title: `Final reminder: invoice ${inv.number} is ${late} overdue`,
    message: `This is our final reminder for invoice ${inv.number} (${balance}), now ${late} overdue. Please pay today or call your Client Manager. As per our terms, work on new deliverables may be paused while invoices are overdue.`,
  };
}

@Injectable()
export class DunningService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Dunning');
  private job?: JobHandle;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'service.dunning', hint: 'Overdue invoice reminders', everyMs: INTERVAL_MS, firstAfterMs: 45_000, run: () => this.sweepAll() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  async sweepAll() {
    const orgs = await this.prisma.organisation.findMany({ where: { deletedAt: null }, select: { id: true } });
    for (const o of orgs) await this.sweep(o.id);
  }

  /** One pass for one organisation. Safe to run any time: each step is sent at most once per invoice. */
  async sweep(orgId: string): Promise<ServiceDunningRunResult> {
    const out: ServiceDunningRunResult = { checked: 0, sent: 0, paused: 0, details: [] };
    if (this.running) return { ...out, details: ['Reminders are already running. Try again in a moment.'] };
    this.running = true;
    try {
      const cfg = await this.settings.get(orgId, 'dunning');
      if (!cfg.enabled) return { ...out, details: ['Automatic reminders are switched off in the settings below.'] };
      const steps = [...new Set(cfg.steps)].sort((a, b) => a - b);
      const now = new Date();
      const holidays = await holidaysFor(this.prisma, orgId);
      // v28: no reminders for invoices the client has not received yet (waiting for the seal and signature).
      const ledger = (await loadLedger(this.prisma, orgId, { clientOrgId: { not: null }, ...clientVisibleInvoiceWhere(await readInvoiceBranding(this.prisma, orgId)) })).filter((i) => i.balancePaise > 0 && i.dueDate < now);
      if (!ledger.length) return out;
      const ids = ledger.map((i) => i.id);
      const [reminders, promises] = await Promise.all([
        this.prisma.invoiceReminder.findMany({ where: { invoiceId: { in: ids } } }),
        this.prisma.paymentPromise.findMany({ where: { invoiceId: { in: ids } }, orderBy: { createdAt: 'desc' } }),
      ]);
      const today = istDate(now);
      for (const inv of ledger) {
        out.checked++;
        const days = cfg.workingDays ? workingDaysLate(inv.dueDate, now, holidays) : calendarDaysLate(inv.dueDate, now);
        const promise = promises.find((p) => p.invoiceId === inv.id);
        if (promise && istDate(promise.promisedFor) >= today) {
          out.paused++;
          continue;
        }
        const sent = reminders.filter((r) => r.invoiceId === inv.id && r.step < MANUAL_STEP_BASE).map((r) => r.step);
        const maxSent = sent.length ? Math.max(...sent) : 0;
        // Highest step that is due now; earlier unsent steps are skipped so a client never gets three at once.
        let due = 0;
        steps.forEach((s, i) => {
          if (days >= s) due = i + 1;
        });
        if (!due || due <= maxSent) continue;
        const ok = await this.send(inv, due, steps.length, days, cfg, false);
        if (ok) {
          out.sent++;
          out.details.push(`${inv.number}: reminder ${due} of ${steps.length} sent (${days} ${cfg.workingDays ? 'working ' : ''}days late)`);
        }
      }
      if (out.sent) this.log.log(`Sent ${out.sent} overdue reminders`);
      return out;
    } finally {
      this.running = false;
    }
  }

  private tone(step: number, total: number): Tone {
    if (step >= total) return total === 1 ? 'friendly' : 'final';
    return step === 1 ? 'friendly' : 'firm';
  }

  /** Sends one reminder step. Returns false when that step was already sent (claimed by another run). */
  private async send(
    inv: LedgerInvoice,
    step: number,
    totalSteps: number,
    days: number,
    cfg: { workingDays: boolean; emailClient: boolean; messageClient: boolean; alertFinance: boolean },
    manual: boolean,
  ) {
    const channels: string[] = ['in_app'];
    if (cfg.emailClient) channels.push('email');
    if (cfg.messageClient) channels.push('message');
    try {
      await this.prisma.invoiceReminder.create({ data: { orgId: inv.orgId, invoiceId: inv.id, step, daysOverdue: days, channels, manual } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
    const tone: Tone = manual ? (days >= 14 ? 'firm' : 'friendly') : this.tone(step, totalSteps);
    const balance = formatINR(inv.balancePaise);
    const c = copy(tone, inv, balance, days, cfg.workingDays ? 'working day' : 'day');
    const clientOrg = await this.prisma.clientOrg.findUnique({ where: { id: inv.clientOrgId! }, select: { id: true, name: true, amUserId: true } });
    const people = await this.notifications.clientBilling(inv.clientOrgId!);

    if (cfg.messageClient) {
      const author = clientOrg?.amUserId ?? (await this.prisma.user.findFirst({ where: { orgId: inv.orgId, type: 'staff', deletedAt: null, roles: { some: { role: { baseRole: 'founder' } } } }, select: { id: true } }))?.id;
      if (author) {
        const thread =
          (await this.prisma.thread.findFirst({ where: { clientOrgId: inv.clientOrgId!, type: 'client_am' }, orderBy: { id: 'asc' } })) ??
          (await this.prisma.thread.create({ data: { orgId: inv.orgId, clientOrgId: inv.clientOrgId!, type: 'client_am' } }));
        await this.prisma.message.create({ data: { orgId: inv.orgId, threadId: thread.id, authorId: author, body: c.message } });
      }
    }

    const t = await buildTaxInvoice(this.prisma, this.settings, inv.orgId, inv.id, `/client/billing/${inv.id}`);
    await this.notifications.notify(inv.orgId, people, {
      kind: 'invoice_reminder',
      title: c.title,
      body: c.message,
      link: `/client/billing/${inv.id}`,
      critical: tone === 'final',
      noEmail: !cfg.emailClient,
      forceEmail: cfg.emailClient,
      email: t
        ? {
            subject: c.title,
            paragraphs: [c.message],
            htmlBlock: taxInvoiceEmailHtml(t),
            textBlock: taxInvoiceEmailText(t),
            button: { label: `Pay ${balance}`, url: `/client/billing/${inv.id}` },
            entity: 'Invoice',
            entityId: inv.id,
          }
        : undefined,
    });

    if (cfg.alertFinance) {
      const finance = await this.prisma.user.findMany({
        where: { orgId: inv.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: { in: ['finance'] } } } } },
        select: { id: true },
      });
      const alert = {
        kind: 'dunning_alert',
        title: `${manual ? 'Reminder' : `Reminder ${step} of ${totalSteps}`} sent: ${clientOrg?.name ?? 'client'} owes ${balance} (${inv.number})`,
        body: `${days} ${cfg.workingDays ? 'working ' : ''}days late. Tone: ${tone}.`,
        critical: tone === 'final',
        noEmail: true,
      };
      await this.notifications.notify(inv.orgId, finance.map((f) => f.id), { ...alert, link: `/admin/finance/invoices/${inv.id}` });
      await this.notifications.notify(inv.orgId, [clientOrg?.amUserId], { ...alert, link: `/team/clients/${inv.clientOrgId}` });
    }
    await this.audit.logSystem(inv.orgId, 'invoice.reminder_sent', 'Invoice', inv.id, { step, days, tone, channels, manual, notified: people.length });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Finance actions

  async runNow(me: Me) {
    assertFinanceWrite(me);
    const r = await this.sweep(me.orgId);
    await this.audit.log(me, 'finance.dunning_run', 'Organisation', me.orgId, undefined, { sent: r.sent, checked: r.checked });
    return r;
  }

  async remindNow(me: Me, invoiceId: string, ip?: string) {
    assertFinanceWrite(me);
    const [inv] = await loadLedger(this.prisma, me.orgId, { id: invoiceId });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (invoiceHeld(await readInvoiceBranding(this.prisma, me.orgId), inv)) throw new BadRequestException(`Sign invoice ${inv.number} first: the client has not received it yet`);
    if (inv.balancePaise <= 0) throw new BadRequestException('Nothing is due on this invoice');
    if (!inv.clientOrgId) throw new BadRequestException('This invoice has no client account yet');
    const people = await this.notifications.clientBilling(inv.clientOrgId);
    if (!people.length) throw new BadRequestException('No owner or finance person on this client account to remind');
    const cfg = await this.settings.get(me.orgId, 'dunning');
    const holidays = await holidaysFor(this.prisma, me.orgId);
    const days = cfg.workingDays ? workingDaysLate(inv.dueDate, new Date(), holidays) : calendarDaysLate(inv.dueDate, new Date());
    const manualCount = await this.prisma.invoiceReminder.count({ where: { invoiceId, step: { gte: MANUAL_STEP_BASE } } });
    await this.send(inv, MANUAL_STEP_BASE + manualCount + 1, 0, days, { ...cfg, alertFinance: false }, true);
    await this.audit.log(me, 'invoice.reminder_sent', 'Invoice', invoiceId, undefined, { manual: true, notified: people.length }, ip);
    return { notified: people.length, emailed: cfg.emailClient ? people.length : 0 };
  }

  async promise(me: Me, invoiceId: string, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const input = parse(servicePromiseSchema, body);
    const [inv] = await loadLedger(this.prisma, me.orgId, { id: invoiceId });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.balancePaise <= 0) throw new BadRequestException('Nothing is due on this invoice');
    if (input.promisedFor < istDate(new Date())) throw new BadRequestException('The promised date cannot be in the past');
    const p = await this.prisma.paymentPromise.create({
      data: { orgId: me.orgId, invoiceId, promisedFor: new Date(`${input.promisedFor}T00:00:00Z`), note: input.note?.trim() || null, createdById: me.id },
    });
    await this.audit.log(me, 'invoice.promise_to_pay', 'Invoice', invoiceId, undefined, { promiseId: p.id, promisedFor: input.promisedFor, note: input.note }, ip);
    return this.collections(me);
  }

  async collections(me: Me): Promise<ServiceCollectionsActions> {
    assertMoney(me);
    const cfg = await this.settings.get(me.orgId, 'dunning');
    const now = new Date();
    const today = istDate(now);
    const holidays = await holidaysFor(this.prisma, me.orgId);
    const ledger = (await loadLedger(this.prisma, me.orgId, { clientOrgId: { not: null } })).filter((i) => i.balancePaise > 0);
    const ids = ledger.map((i) => i.id);
    const [reminders, promises, sentLast30Days] = await Promise.all([
      ids.length ? this.prisma.invoiceReminder.findMany({ where: { invoiceId: { in: ids } }, orderBy: { createdAt: 'asc' } }) : [],
      ids.length ? this.prisma.paymentPromise.findMany({ where: { invoiceId: { in: ids } }, orderBy: { createdAt: 'desc' } }) : [],
      this.prisma.invoiceReminder.count({ where: { orgId: me.orgId, createdAt: { gte: new Date(now.getTime() - 30 * DAY) } } }),
    ]);
    const userIds = [...new Set(promises.map((p) => p.createdById))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const steps = [...new Set(cfg.steps)].sort((a, b) => a - b);
    let open = 0;
    let broken = 0;
    const rows = ledger.map((inv) => {
      const mine = reminders.filter((r) => r.invoiceId === inv.id);
      const p = promises.find((x) => x.invoiceId === inv.id);
      const isBroken = !!p && istDate(p.promisedFor) < today;
      if (p && !isBroken) open++;
      if (isBroken) broken++;
      const maxSent = Math.max(0, ...mine.filter((r) => r.step < MANUAL_STEP_BASE).map((r) => r.step));
      const nextIdx = maxSent;
      const nextDays = steps[nextIdx];
      const nextOn =
        nextDays === undefined || !cfg.enabled
          ? null
          : cfg.workingDays
            ? istDate(addWorkingDays(inv.dueDate, nextDays, holidays))
            : istDate(new Date(inv.dueDate.getTime() + nextDays * DAY));
      return {
        invoiceId: inv.id,
        reminders: mine.map((r) => ({ step: r.step >= MANUAL_STEP_BASE ? 0 : r.step, days: r.daysOverdue, at: r.createdAt.toISOString(), manual: r.manual, channels: r.channels })),
        promise: p ? { promisedFor: istDate(p.promisedFor), note: p.note, by: users.find((u) => u.id === p.createdById)?.name ?? '', at: p.createdAt.toISOString(), broken: isBroken } : null,
        nextReminder: nextOn ? { step: nextIdx + 1, days: nextDays, on: nextOn < today ? today : nextOn } : null,
        daysOverdueWorking: inv.dueDate < now ? (cfg.workingDays ? workingDaysLate(inv.dueDate, now, holidays) : calendarDaysLate(inv.dueDate, now)) : 0,
      };
    });
    return { rows, settings: cfg, sentLast30Days, promisesOpen: open, promisesBroken: broken, canEdit: canWriteFinance(me) };
  }
}
