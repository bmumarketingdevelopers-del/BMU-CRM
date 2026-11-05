import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import type { Response } from 'express';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { opsUpload, type OpsUpload } from '../ops-actions/ops-util.js';
import { QuotesService } from './quotes.service.js';

/** v45 quotations (team). Static routes before /quotes/:id. */
@Controller('quotes')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Get('templates')
  templates(@CurrentUser() me: Me) {
    return this.quotes.templates(me);
  }

  @Post('templates')
  createTemplate(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.quotes.saveTemplate(me, body, undefined, ip);
  }

  @Patch('templates/:id')
  updateTemplate(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.quotes.saveTemplate(me, body, id, ip);
  }

  @Delete('templates/:id')
  deleteTemplate(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.quotes.deleteTemplate(me, id, ip);
  }

  @Post('overview')
  @HttpCode(200)
  overview(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.quotes.overview(me, body);
  }

  @Get()
  list(@CurrentUser() me: Me, @Query('clientOrgId') clientOrgId?: string, @Query('status') status?: string) {
    return this.quotes.list(me, { clientOrgId, status });
  }

  @Post()
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.quotes.create(me, body, ip);
  }

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.quotes.get(me, id);
  }

  @Patch(':id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.quotes.update(me, id, body, ip);
  }

  @Post(':id/send')
  @HttpCode(200)
  send(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.quotes.send(me, id, ip);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.quotes.cancel(me, id, ip);
  }

  @Get(':id/signed-copy')
  signedCopy(@CurrentUser() me: Me, @Param('id') id: string, @Res() res: Response) {
    return this.quotes.signedCopy(me, id, res);
  }

  @Post(':id/advance-invoice')
  @HttpCode(200)
  advance(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.quotes.raiseAdvance(me, id, ip);
  }

  @Post(':id/confirm-payment')
  @HttpCode(200)
  confirmPayment(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.quotes.confirmPayment(me, id, ip);
  }

  @Post(':id/balance-invoice')
  @HttpCode(200)
  balance(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.quotes.raiseBalance(me, id, ip);
  }
}

/** v45 quotations (client portal). */
@Controller('client/quotes')
export class ClientQuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Get()
  mine(@CurrentUser() me: Me) {
    return this.quotes.mine(me);
  }

  @Get(':id')
  one(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.quotes.mineOne(me, id);
  }

  @Get(':id/signed-copy')
  signedCopy(@CurrentUser() me: Me, @Param('id') id: string, @Res() res: Response) {
    return this.quotes.signedCopy(me, id, res);
  }

  @Post(':id/files/:kind')
  @HttpCode(200)
  @UseInterceptors(opsUpload)
  file(@CurrentUser() me: Me, @Param('id') id: string, @Param('kind') kind: string, @UploadedFile() file: OpsUpload | undefined, @ClientIp() ip?: string) {
    return this.quotes.acceptanceFile(me, id, kind, file, ip);
  }

  @Post(':id/paid')
  @HttpCode(200)
  paid(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.quotes.notifyPaid(me, id, body, ip);
  }

  @Post(':id/decision')
  @HttpCode(200)
  decide(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.quotes.decide(me, id, body, ip);
  }
}
