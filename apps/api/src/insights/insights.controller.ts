import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { REVENUE_PERIODS, type Me, type RevenuePeriod } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { FinanceService } from './finance.service.js';
import { InsightsService } from './insights.service.js';
import { cached } from '../platform/read-cache.js';

/** Command Centre dashboards. Each method checks who may read it. */
@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('weekly')
  weekly(@CurrentUser() me: Me) {
    return cached(me.orgId, `weekly:${me.id}`, 30_000, () => this.insights.weekly(me));
  }

  @Get('revenue')
  revenue(@CurrentUser() me: Me, @Query('period') period?: string) {
    const p = (REVENUE_PERIODS as readonly string[]).includes(period ?? '') ? (period as RevenuePeriod) : 'month';
    return this.insights.revenue(me, p);
  }

  @Get('collections')
  collections(@CurrentUser() me: Me) {
    return this.insights.collections(me);
  }

  @Get('capacity')
  capacity(@CurrentUser() me: Me) {
    return this.insights.capacity(me);
  }

  @Get('quality')
  quality(@CurrentUser() me: Me) {
    return this.insights.quality(me);
  }

  @Get('client-health')
  clientHealth(@CurrentUser() me: Me) {
    return this.insights.clientHealth(me);
  }
}

/** Finance desk: Founder, Admin and Finance (invoices_payments). */
@Controller('finance')
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('invoices')
  invoices(@CurrentUser() me: Me, @Query('status') status?: string, @Query('kind') kind?: string, @Query('clientId') clientId?: string, @Query('q') q?: string) {
    return this.finance.invoices(me, { status, kind, clientId, q });
  }

  @Get('invoices/:id')
  invoice(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.finance.invoice(me, id);
  }

  @Post('invoices/:id/payments')
  @HttpCode(200)
  recordPayment(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.finance.recordPayment(me, id, body, ip);
  }

  @Post('invoices/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.finance.cancel(me, id, body, ip);
  }

  @Post('invoices/:id/remind')
  @HttpCode(200)
  remind(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.finance.remind(me, id, ip);
  }

  @Get('payments')
  payments(@CurrentUser() me: Me) {
    return this.finance.payments(me);
  }

  @Get('credit-notes')
  creditNotes(@CurrentUser() me: Me) {
    return this.finance.creditNotes(me);
  }

  @Post('credit-notes')
  issueCreditNote(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.finance.issueCreditNote(me, body, ip);
  }

  @Get('payouts')
  payouts(@CurrentUser() me: Me) {
    return this.finance.payouts(me);
  }

  @Post('payouts')
  addPayout(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.finance.addPayout(me, body, ip);
  }

  @Post('payouts/:id/pay')
  @HttpCode(200)
  markPaid(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.finance.markPayoutPaid(me, id, body, ip);
  }

  @Get('gst')
  gst(@CurrentUser() me: Me, @Query('month') month?: string) {
    return this.finance.gst(me, month);
  }

  @Get('gst.csv')
  async gstCsv(@CurrentUser() me: Me, @Res({ passthrough: true }) res: Response, @Query('month') month?: string, @ClientIp() ip?: string) {
    const file = await this.finance.gstCsv(me, month, ip);
    return sendCsv(res, file);
  }

  @Get('export.csv')
  async exportCsv(@CurrentUser() me: Me, @Res({ passthrough: true }) res: Response, @Query('from') from?: string, @Query('to') to?: string, @Query('format') format?: string, @ClientIp() ip?: string) {
    const file = await this.finance.exportCsv(me, from, to, ip, format || 'csv');
    return sendCsv(res, file);
  }
}

function sendCsv(res: Response, file: { filename: string; body: string; contentType?: string }) {
  res.setHeader('Content-Type', file.contentType ?? 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  return file.body;
}
