import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  craftAdhocTaskInputSchema,
  craftAssignInputSchema,
  craftBulkAssignInputSchema,
  craftClientNoteInputSchema,
  craftTaskUpdateInputSchema,
  type Me,
} from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { CraftManagerService } from './craft-manager.service.js';

/**
 * v10 craft: the Manager workspace. Account managers and project managers act on their own clients' work, department
 * heads on their department, AM leads, founders and admins on everything. Everyone else gets 403.
 */
@Controller('craft/manager')
export class CraftManagerController {
  constructor(private readonly manager: CraftManagerService) {}

  @Get()
  view(@CurrentUser() me: Me) {
    return this.manager.view(me);
  }

  @Post('tasks/assign')
  @HttpCode(200)
  bulkAssign(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.manager.bulkAssign(me, parse(craftBulkAssignInputSchema, body), ip);
  }

  @Post('tasks/:id/assign')
  @HttpCode(200)
  assign(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.manager.assign(me, id, parse(craftAssignInputSchema, body), ip);
  }

  @Patch('tasks/:id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.manager.updateTask(me, id, parse(craftTaskUpdateInputSchema, body), ip);
  }

  @Post('tasks')
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.manager.createTask(me, parse(craftAdhocTaskInputSchema, body), ip);
  }

  @Post('clients/:id/notes')
  note(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.manager.addClientNote(me, id, parse(craftClientNoteInputSchema, body), ip);
  }
}
