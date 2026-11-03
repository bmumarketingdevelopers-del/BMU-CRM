import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
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

  @Post(':id/decision')
  @HttpCode(200)
  decide(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.quotes.decide(me, id, body, ip);
  }
}
