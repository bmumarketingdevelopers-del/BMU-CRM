import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { automationRulePatchSchema, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { AutomationsService } from './automations.service.js';

/** Automations: "When this happens, if these are true, do this". Founder/Admin manage; leads and Finance read. */
@Controller('automations')
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get('overview')
  overview(@CurrentUser() me: Me) {
    return this.automations.overview(me);
  }

  @Get('options')
  options(@CurrentUser() me: Me) {
    return this.automations.options(me);
  }

  @Get('runs')
  runs(@CurrentUser() me: Me, @Query('ruleId') ruleId?: string, @Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.automations.runs(me, { ruleId, status, from, to });
  }

  @Post('run-now')
  @HttpCode(200)
  runNow(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    const { ruleId } = parse(z.object({ ruleId: z.string().optional() }), body ?? {});
    return this.automations.runNow(me, ruleId, ip);
  }

  @Post('test')
  @HttpCode(200)
  testDraft(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.automations.testDraft(me, body);
  }

  @Post('from-template')
  fromTemplate(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.automations.fromTemplate(me, parse(z.object({ templateKey: z.string().min(1) }), body).templateKey, ip);
  }

  @Post()
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.automations.create(me, body, ip);
  }

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.automations.get(me, id);
  }

  @Put(':id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.automations.update(me, id, body, ip);
  }

  @Patch(':id')
  setEnabled(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.automations.setEnabled(me, id, parse(automationRulePatchSchema, body).enabled, ip);
  }

  @Delete(':id')
  remove(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.automations.remove(me, id, ip);
  }

  @Post(':id/test')
  @HttpCode(200)
  test(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.automations.test(me, id);
  }
}
