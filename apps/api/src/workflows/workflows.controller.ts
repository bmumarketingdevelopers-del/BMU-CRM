import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { workflowPatchSchema, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { WorkflowsService } from './workflows.service.js';

/** v14 workflows. Founder/Admin build them; leads and Finance read; anyone sees a record's own workflow history. */
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get('overview')
  overview(@CurrentUser() me: Me) {
    return this.workflows.overview(me);
  }

  @Get('options')
  options(@CurrentUser() me: Me) {
    return this.workflows.options(me);
  }

  @Get('whatsapp-queue')
  whatsappQueue(@CurrentUser() me: Me) {
    return this.workflows.whatsappQueue(me);
  }

  @Get('runs')
  runs(@CurrentUser() me: Me, @Query('workflowId') workflowId?: string, @Query('status') status?: string, @Query('entityId') entityId?: string, @Query('entity') entity?: string) {
    return this.workflows.runs(me, { workflowId, status, entityId, entity });
  }

  @Get('runs/:id')
  run(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.workflows.run(me, id);
  }

  @Post('runs/:id/cancel')
  @HttpCode(200)
  cancelRun(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.workflows.cancelRun(me, id, ip);
  }

  @Post('run-now')
  @HttpCode(200)
  runNow(@CurrentUser() me: Me, @ClientIp() ip?: string) {
    return this.workflows.runNow(me, ip);
  }

  @Post('test')
  @HttpCode(200)
  test(@CurrentUser() me: Me, @Body() body: unknown, @Query('id') id?: string) {
    return this.workflows.test(me, body, id);
  }

  @Post('from-template')
  fromTemplate(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.workflows.fromTemplate(me, parse(z.object({ templateKey: z.string().min(1) }), body).templateKey, ip);
  }

  @Post('move-automations')
  @HttpCode(200)
  moveAutomations(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.workflows.moveAutomations(me, parse(z.object({ ruleId: z.string().optional() }), body ?? {}).ruleId, ip);
  }

  @Post()
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.workflows.create(me, body, ip);
  }

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.workflows.get(me, id);
  }

  @Put(':id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.workflows.update(me, id, body, ip);
  }

  @Patch(':id')
  setEnabled(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.workflows.setEnabled(me, id, parse(workflowPatchSchema, body).enabled, ip);
  }

  @Delete(':id')
  remove(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.workflows.remove(me, id, ip);
  }
}
