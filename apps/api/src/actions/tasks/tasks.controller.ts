import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import {
  coreTaskActivateSchema,
  coreTaskBulkSchema,
  coreTaskDeadlineSchema,
  coreTaskDependencySchema,
  coreTaskDuplicateSchema,
  coreTaskEditSchema,
  coreTaskHandbackSchema,
  coreArchiveSchema,
  coreTaskStatusSchema,
  coreTemplatePreviewSchema,
  type CoreTaskQuery,
  type Me,
} from '@bmu/shared';
import { ClientIp, CurrentUser } from '../../common/decorators.js';
import { parse } from '../../common/zod.js';
import { TasksActionsService } from './tasks.service.js';
import { cached } from '../../platform/read-cache.js';
import { opsUpload, type OpsUpload } from '../../ops-actions/ops-util.js';

/**
 * v11 core: task actions. Shares the /tasks prefix with Production (GET /tasks and PATCH /tasks/:id keep working);
 * static routes are declared before /tasks/:id.
 */
@Controller('tasks')
export class TasksActionsController {
  constructor(private readonly tasks: TasksActionsService) {}

  @Get('query')
  query(@CurrentUser() me: Me, @Query() q: CoreTaskQuery) {
    return cached(me.orgId, `tasks:${me.id}:${JSON.stringify(q)}`, 30_000, () => this.tasks.query(me, q));
  }

  @Get('form-options')
  formOptions(@CurrentUser() me: Me, @Query('engagementId') engagementId?: string) {
    return this.tasks.formOptions(me, engagementId);
  }

  @Get('recurring')
  recurring(@CurrentUser() me: Me) {
    return this.tasks.recurring(me);
  }

  @Delete('recurring/:id')
  stopRecurring(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.tasks.stopRecurring(me, id, ip);
  }

  @Post('bulk')
  @HttpCode(200)
  bulk(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.tasks.bulk(me, parse(coreTaskBulkSchema, body), ip);
  }

  @Post('from-template/preview')
  @HttpCode(200)
  templatePreview(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.tasks.templatePreview(me, parse(coreTemplatePreviewSchema, body));
  }

  @Post('from-template')
  fromTemplate(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.tasks.fromTemplate(me, parse(coreTemplatePreviewSchema, body), ip);
  }

  @Post()
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.tasks.create(me, body, ip);
  }

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.tasks.get(me, id);
  }

  /** v38: send a file on the task (the owner, creator and watchers find it in Files too). */
  @Post(':id/files')
  @UseInterceptors(opsUpload)
  attachFile(@CurrentUser() me: Me, @Param('id') id: string, @UploadedFile() file: OpsUpload | undefined, @ClientIp() ip?: string) {
    return this.tasks.attachFile(me, id, file, ip);
  }

  @Patch(':id/details')
  edit(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.tasks.edit(me, id, parse(coreTaskEditSchema, body), ip);
  }

  @Post(':id/status')
  @HttpCode(200)
  status(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.tasks.status(me, id, parse(coreTaskStatusSchema, body), ip);
  }

  @Post(':id/deadline')
  @HttpCode(200)
  deadline(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.tasks.deadline(me, id, parse(coreTaskDeadlineSchema, body), ip);
  }

  @Post(':id/duplicate')
  duplicate(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.tasks.duplicate(me, id, parse(coreTaskDuplicateSchema, body ?? {}), ip);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.tasks.archive(me, id, parse(coreArchiveSchema, body).reason, ip);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.tasks.restore(me, id, ip);
  }

  @Post(':id/handback')
  @HttpCode(200)
  handback(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.tasks.handback(me, id, parse(coreTaskHandbackSchema, body).reason, ip);
  }

  @Post(':id/activate')
  @HttpCode(200)
  activate(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const parsed = coreTaskActivateSchema.partial().parse(body ?? {});
    return this.tasks.activate(me, id, parsed.addOnRequestId, ip);
  }

  @Post(':id/dependencies')
  @HttpCode(200)
  addDependency(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.tasks.addDependency(me, id, parse(coreTaskDependencySchema, body).dependsOnId, ip);
  }

  @Delete(':id/dependencies/:depId')
  removeDependency(@CurrentUser() me: Me, @Param('id') id: string, @Param('depId') depId: string, @ClientIp() ip?: string) {
    return this.tasks.removeDependency(me, id, depId, ip);
  }
}
