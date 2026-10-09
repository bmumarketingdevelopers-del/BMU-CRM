// v20 scheduled reports: a set of numbers, or a dashboard's numbers and charts, emailed as a PDF on a schedule.
// Each report is built with its creator's own access, so nobody can email out numbers they couldn't open.
import { ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  describeSchedule,
  formatMetric,
  metricDef,
  nextReportRun,
  opsMetricInfo,
  scheduledReportSchema,
  dashboardPeriodRange,
  type DashboardWidget,
  type Me,
  type ReportCadence,
  type ScheduledReportView,
} from '@bmu/shared';
import type { ScheduledReport } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { MeService } from '../auth/me.service.js';
import { parse } from '../common/zod.js';
import { canReadCommand } from '../insights/access.js';
import { OpsExploreService } from '../ops-analytics/explore.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from '../service/email.service.js';
import { MetricsService, windowOf } from './metrics.service.js';
import { renderPdf, type PdfBlock } from './pdf.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const WINDOW: Record<ReportCadence, number> = { daily: 1, weekly: 7, monthly: 30 };

@Injectable()
export class ReportsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Reports');
  private job?: JobHandle;

  constructor(
    private readonly prisma: PrismaService,
    private readonly meService: MeService,
    private readonly metrics: MetricsService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly ref: ModuleRef,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'intelligence.reports', hint: 'Sends scheduled reports that are due', everyMs: 5 * 60_000, run: () => this.runDue() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  private assertReader(me: Me) {
    if (!canReadCommand(me)) throw new ForbiddenException('Scheduled reports are for the Command Centre team');
  }

  private async view(r: ScheduledReport): Promise<ScheduledReportView> {
    const dash = r.dashboardId ? await this.prisma.dashboard.findUnique({ where: { id: r.dashboardId }, select: { name: true } }) : null;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind as ScheduledReportView['kind'],
      dashboardId: r.dashboardId,
      dashboardName: dash?.name ?? null,
      metricKeys: r.metricKeys,
      cadence: r.cadence as ReportCadence,
      dayOfWeek: r.dayOfWeek,
      dayOfMonth: r.dayOfMonth,
      hourIst: r.hourIst,
      recipients: r.recipients,
      active: r.active,
      nextRunAt: r.nextRunAt.toISOString(),
      lastSentAt: r.lastSentAt?.toISOString() ?? null,
      lastError: r.lastError,
      schedule: describeSchedule({ cadence: r.cadence as ReportCadence, dayOfWeek: r.dayOfWeek, dayOfMonth: r.dayOfMonth, hourIst: r.hourIst }),
    };
  }

  private async one(me: Me, id: string) {
    const r = await this.prisma.scheduledReport.findFirst({ where: { id, orgId: me.orgId } });
    if (!r) throw new NotFoundException('Report not found');
    return r;
  }

  async list(me: Me) {
    this.assertReader(me);
    const rows = await this.prisma.scheduledReport.findMany({ where: { orgId: me.orgId }, orderBy: { createdAt: 'asc' } });
    const dashboards = await this.prisma.dashboard.findMany({ where: { orgId: me.orgId, archivedAt: null, surface: { not: 'client' } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return { reports: await Promise.all(rows.map((r) => this.view(r))), metrics: (await this.metrics.visible(me)).map((m) => ({ key: m.key, label: m.label, unit: m.unit })), dashboards };
  }

  private async validate(me: Me, input: ReturnType<typeof scheduledReportSchema.parse>) {
    for (const k of input.metricKeys) await this.metrics.assertCanSee(me, k);
    if (input.kind === 'dashboard') {
      const d = await this.prisma.dashboard.findFirst({ where: { id: input.dashboardId!, orgId: me.orgId, archivedAt: null } });
      if (!d) throw new NotFoundException('Dashboard not found');
    }
  }

  async create(me: Me, body: unknown, ip?: string) {
    this.assertReader(me);
    const input = parse(scheduledReportSchema, body);
    await this.validate(me, input);
    const r = await this.prisma.scheduledReport.create({
      data: { orgId: me.orgId, name: input.name, kind: input.kind, dashboardId: input.kind === 'dashboard' ? input.dashboardId : null, metricKeys: input.kind === 'metrics' ? input.metricKeys : [], cadence: input.cadence, dayOfWeek: input.dayOfWeek ?? null, dayOfMonth: input.dayOfMonth ?? null, hourIst: input.hourIst, recipients: input.recipients, active: input.active, nextRunAt: nextReportRun(input), createdById: me.id },
    });
    await this.audit.log(me, 'report.scheduled', 'ScheduledReport', r.id, undefined, input, ip);
    return this.view(r);
  }

  async update(me: Me, id: string, body: unknown, ip?: string) {
    this.assertReader(me);
    const before = await this.one(me, id);
    if (before.createdById !== me.id && !me.roles.some((r) => r === 'founder' || r === 'admin')) throw new ForbiddenException('Only the person who set it up (or the Founder / an Admin) can change it');
    const input = parse(scheduledReportSchema, { ...before, ...(body as object) });
    await this.validate(me, input);
    const r = await this.prisma.scheduledReport.update({
      where: { id },
      data: { name: input.name, kind: input.kind, dashboardId: input.kind === 'dashboard' ? input.dashboardId : null, metricKeys: input.kind === 'metrics' ? input.metricKeys : [], cadence: input.cadence, dayOfWeek: input.dayOfWeek ?? null, dayOfMonth: input.dayOfMonth ?? null, hourIst: input.hourIst, recipients: input.recipients, active: input.active, nextRunAt: nextReportRun(input) },
    });
    await this.audit.log(me, 'report.updated', 'ScheduledReport', id, before, r, ip);
    return this.view(r);
  }

  async remove(me: Me, id: string, ip?: string) {
    this.assertReader(me);
    const r = await this.one(me, id);
    if (r.createdById !== me.id && !me.roles.some((x) => x === 'founder' || x === 'admin')) throw new ForbiddenException('Only the person who set it up (or the Founder / an Admin) can delete it');
    await this.prisma.scheduledReport.delete({ where: { id } });
    await this.audit.log(me, 'report.deleted', 'ScheduledReport', id, r, undefined, ip);
    return { ok: true as const };
  }

  /** The PDF as the signed-in person would get it (preview / download). */
  async pdf(me: Me, id: string) {
    this.assertReader(me);
    const r = await this.one(me, id);
    return { filename: `${r.name.replace(/[^\w-]+/g, '-').toLowerCase()}.pdf`, buffer: (await this.build(me, r)).pdf };
  }

  async sendNow(me: Me, id: string) {
    this.assertReader(me);
    const r = await this.one(me, id);
    return this.send(r);
  }

  /** Sends every report that is due. */
  async runDue(now = new Date()) {
    const due = await this.prisma.scheduledReport.findMany({ where: { active: true, nextRunAt: { lte: now } }, take: 50 });
    for (const r of due) await this.send(r, now);
    return due.length;
  }

  private async send(r: ScheduledReport, now = new Date()) {
    const owner = await this.meService.load(r.createdById);
    try {
      if (!owner || !canReadCommand(owner)) throw new Error('The person who set this up no longer has access to these numbers');
      const { pdf, lines } = await this.build(owner, r);
      for (const to of r.recipients) {
        await this.email.send({
          orgId: r.orgId,
          to,
          subject: `${r.name}: ${new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(now)}`,
          heading: r.name,
          paragraphs: [...lines, 'The full report is attached as a PDF.'],
          kind: 'scheduled_report',
          entity: 'ScheduledReport',
          entityId: r.id,
          attachments: [{ filename: `${r.name.replace(/[^\w-]+/g, '-').toLowerCase()}.pdf`, contentType: 'application/pdf', base64: pdf.toString('base64') }],
        });
      }
      await this.prisma.scheduledReport.update({ where: { id: r.id }, data: { lastSentAt: now, lastError: null, nextRunAt: nextReportRun({ cadence: r.cadence as ReportCadence, dayOfWeek: r.dayOfWeek, dayOfMonth: r.dayOfMonth, hourIst: r.hourIst }, now) } });
      return { sent: r.recipients.length };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      this.log.warn(`Report ${r.id} failed: ${msg}`);
      await this.prisma.scheduledReport.update({ where: { id: r.id }, data: { lastError: msg, nextRunAt: nextReportRun({ cadence: r.cadence as ReportCadence, dayOfWeek: r.dayOfWeek, dayOfMonth: r.dayOfMonth, hourIst: r.hourIst }, now) } });
      return { sent: 0, error: msg };
    }
  }

  /** Builds the PDF and a few summary lines for the email body. */
  async build(me: Me, r: ScheduledReport): Promise<{ pdf: Buffer; lines: string[] }> {
    const org = await this.prisma.organisation.findUnique({ where: { id: r.orgId }, select: { name: true } });
    const period = windowOf(WINDOW[r.cadence as ReportCadence] ?? 7);
    const blocks: PdfBlock[] = [
      { type: 'title', text: r.name },
      { type: 'subtitle', text: `${org?.name ?? 'BMU'} - ${period.from === period.to ? period.to : `${period.from} to ${period.to}`} (IST) - ${describeSchedule({ cadence: r.cadence as ReportCadence, dayOfWeek: r.dayOfWeek, dayOfMonth: r.dayOfMonth, hourIst: r.hourIst })}` },
      { type: 'gap', size: 12 },
    ];
    const lines: string[] = [];
    if (r.kind === 'metrics') {
      const rows: string[][] = [];
      for (const key of r.metricKeys) {
        const def = metricDef(key);
        if (!def) continue;
        try {
          const v = await this.metrics.view(me, key, period);
          const change = v.changePct === null ? '-' : `${v.changePct > 0 ? '+' : ''}${v.changePct}%`;
          rows.push([def.label, v.display, def.snapshot ? 'now' : formatMetric(v.previous, def.unit), change, def.formula]);
          lines.push(`${def.label}: ${v.display}${v.changePct === null ? '' : ` (${change} on the period before)`}`);
        } catch (e) {
          rows.push([def.label, 'not available', '', '', (e as Error).message]);
        }
      }
      blocks.push({ type: 'table', columns: ['Number', 'This period', 'Period before', 'Change', 'How it is worked out'], rows, widths: [2.2, 1.5, 1.5, 1, 4] });
    } else {
      const d = await this.prisma.dashboard.findFirst({ where: { id: r.dashboardId!, orgId: r.orgId } });
      if (!d) throw new Error('The dashboard was deleted');
      blocks.push({ type: 'heading', text: `Dashboard: ${d.name}` });
      const ex = this.ref.get(OpsExploreService, { strict: false });
      for (const w of d.layout as DashboardWidget[]) {
        if (w.type === 'kpi') {
          const range = dashboardPeriodRange(w.period);
          const res = await ex.exploreForDashboard(me, { metric: w.metric, dimension: 'month', from: range.from, to: range.to }).catch(() => null);
          const label = w.title || opsMetricInfo[w.metric].label;
          const val = res ? formatMetric(res.total, res.unit) : 'not available';
          blocks.push({ type: 'text', text: `${label}: ${val}` });
          lines.push(`${label}: ${val}`);
        } else if (w.type === 'chart') {
          const range = dashboardPeriodRange(w.period);
          const res = await ex.exploreForDashboard(me, { metric: w.metric, dimension: w.dimension, from: range.from, to: range.to }).catch(() => null);
          blocks.push({ type: 'heading', text: w.title || `${opsMetricInfo[w.metric].label} by ${w.dimension}` });
          if (res) blocks.push({ type: 'table', columns: [res.dimensionLabel, res.metricLabel], rows: res.rows.slice(0, 15).map((x) => [x.label, formatMetric(x.value, res.unit)]), widths: [3, 2] });
        } else if (w.type === 'note') {
          blocks.push({ type: 'text', text: w.text });
        }
      }
    }
    blocks.push({ type: 'gap', size: 14 }, { type: 'subtitle', text: 'Numbers come from the BMU Hub metric layer: the same definitions used on every dashboard.' });
    return { pdf: renderPdf(blocks, `${org?.name ?? 'BMU Hub'} - ${r.name}`), lines };
  }
}
