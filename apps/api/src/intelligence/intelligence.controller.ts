import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Me, MetricValueView } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { assertCommand } from '../insights/access.js';
import { cached } from '../platform/read-cache.js';
import { AlertsService } from './alerts.service.js';
import { GoalsService } from './goals.service.js';
import { IntelligenceService } from './intelligence.service.js';
import { MetricsService, windowOf, type Period } from './metrics.service.js';
import { ReportsService } from './reports.service.js';

const day = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);
const periodOf = (from?: string, to?: string): Period => {
  const w = windowOf(30);
  return { from: day(from) ?? w.from, to: day(to) ?? w.to };
};

@Controller('intelligence')
export class IntelligenceController {
  constructor(
    private readonly intelligence: IntelligenceService,
    private readonly metrics: MetricsService,
    private readonly alerts: AlertsService,
    private readonly reports: ReportsService,
    private readonly goals: GoalsService,
  ) {}

  // Forecast & risks
  @Get('overview')
  overview(@CurrentUser() me: Me) {
    return cached(me.orgId, `overview:${me.id}`, 60_000, () => this.intelligence.overview(me));
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@CurrentUser() me: Me) {
    assertCommand(me);
    return { refreshed: await this.intelligence.refresh(me.orgId) };
  }

  // Metric layer
  @Get('metrics')
  async allMetrics(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string): Promise<MetricValueView[]> {
    assertCommand(me);
    const p = periodOf(from, to);
    const defs = await this.metrics.visible(me);
    return Promise.all(defs.map((d) => this.metrics.view(me, d.key, p)));
  }

  @Get('metrics/:key')
  metric(@CurrentUser() me: Me, @Param('key') key: string, @Query('from') from?: string, @Query('to') to?: string, @Query('clientOrgId') clientOrgId?: string) {
    assertCommand(me);
    return this.metrics.view(me, key, periodOf(from, to), clientOrgId || null);
  }

  // Anomaly alerts
  @Get('alerts')
  alertList(@CurrentUser() me: Me) {
    return this.alerts.list(me);
  }

  @Post('alerts')
  createAlert(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.alerts.create(me, body, ip);
  }

  @Patch('alerts/:id')
  updateAlert(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.alerts.update(me, id, body, ip);
  }

  @Delete('alerts/:id')
  removeAlert(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.alerts.remove(me, id, ip);
  }

  @Post('alerts/check')
  @HttpCode(200)
  async checkAlerts(@CurrentUser() me: Me) {
    if (!me.roles.some((r) => r === 'founder' || r === 'admin')) throw new ForbiddenException('Only the Founder or a Branch Manager can run the alert check');
    return { fired: await this.alerts.check(me.orgId) };
  }

  // Scheduled reports
  @Get('reports')
  reportList(@CurrentUser() me: Me) {
    return this.reports.list(me);
  }

  @Post('reports')
  createReport(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.reports.create(me, body, ip);
  }

  @Patch('reports/:id')
  updateReport(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.reports.update(me, id, body, ip);
  }

  @Delete('reports/:id')
  removeReport(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.reports.remove(me, id, ip);
  }

  @Post('reports/:id/send')
  @HttpCode(200)
  sendReport(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.reports.sendNow(me, id);
  }

  @Get('reports/:id/pdf')
  async reportPdf(@CurrentUser() me: Me, @Param('id') id: string, @Res() res: Response) {
    const { filename, buffer } = await this.reports.pdf(me, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buffer);
  }

  // Goals
  @Get('goals')
  goalList(@CurrentUser() me: Me, @Query('archived') archived?: string) {
    return this.goals.list(me, { archived });
  }

  @Post('goals')
  createGoal(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.goals.create(me, body, ip);
  }

  @Get('goals/:id')
  goal(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.goals.one(me, id);
  }

  @Patch('goals/:id')
  updateGoal(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.goals.update(me, id, body, ip);
  }

  @Post('goals/:id/check-ins')
  checkIn(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.goals.checkIn(me, id, body, ip);
  }
}
