import { Body, Controller, Delete, ForbiddenException, Get, Header, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  coreArchiveSchema,
  coreBulkReassignSchema,
  coreDecideApprovalSchema,
  coreDraftSchema,
  coreImportCommitSchema,
  coreImportPreviewSchema,
  coreReassignPreviewSchema,
  coreSavedViewSchema,
  coreSetTagsSchema,
  coreTagSchema,
  type Me,
} from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { ApprovalsService } from './approvals.service.js';
import { ImportsService } from './imports.service.js';
import { ActionsJobsService } from './jobs.service.js';
import { PaletteService } from './palette.service.js';
import { hasRole } from './people.js';
import { ReassignService } from './reassign.service.js';
import { RecordsService } from './records.service.js';
import { UndoService } from './undo.service.js';

/** v11 core: the shared action system. Every route checks role + scope in its service. */
@Controller('actions')
export class ActionsController {
  constructor(
    private readonly reassign: ReassignService,
    private readonly approvals: ApprovalsService,
    private readonly undo: UndoService,
    private readonly records: RecordsService,
    private readonly palette: PaletteService,
    private readonly jobs: ActionsJobsService,
  ) {}

  // Reassignment engine
  @Get('reassign/types')
  types() {
    return this.reassign.types();
  }

  @Get('reassign/open-work/:userId')
  openWork(@CurrentUser() me: Me, @Param('userId') userId: string) {
    return this.reassign.openWork(me, userId);
  }

  @Post('reassign/bulk')
  @HttpCode(200)
  bulk(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.reassign.bulk(me, parse(coreBulkReassignSchema, body), ip);
  }

  @Get('reassign/:type/candidates')
  candidates(
    @CurrentUser() me: Me,
    @Param('type') type: string,
    @Query('ids') ids?: string,
    @Query('departmentId') departmentId?: string,
    @Query('deadline') deadline?: string,
    @Query('estimateHours') estimateHours?: string,
    @Query('role') role?: string,
  ) {
    return this.reassign.candidates(me, type, (ids ?? '').split(',').filter(Boolean).slice(0, 500), { departmentId, deadline, estimateHours, role });
  }

  @Post('reassign/:type/preview')
  @HttpCode(200)
  preview(@CurrentUser() me: Me, @Param('type') type: string, @Body() body: unknown) {
    return this.reassign.preview(me, type, parse(coreReassignPreviewSchema, body));
  }

  @Post('reassign/:type/apply')
  @HttpCode(200)
  apply(@CurrentUser() me: Me, @Param('type') type: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.reassign.apply(me, type, body, ip);
  }

  // Approvals
  @Get('approvals')
  approvalsList(@CurrentUser() me: Me, @Query('box') box?: string, @Query('status') status?: string) {
    return this.approvals.list(me, box, status);
  }

  @Get('approvals/count')
  approvalsCount(@CurrentUser() me: Me) {
    return this.approvals.count(me);
  }

  @Get('approvals/:id')
  approval(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.approvals.get(me, id);
  }

  @Post('approvals/:id/decide')
  @HttpCode(200)
  decide(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.approvals.decide(me, id, parse(coreDecideApprovalSchema, body), ip);
  }

  @Post('approvals/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.approvals.cancel(me, id, ip);
  }

  // Undo
  @Post('undo/:token')
  @HttpCode(200)
  undoIt(@CurrentUser() me: Me, @Param('token') token: string, @ClientIp() ip?: string) {
    return this.undo.undo(me, token, ip);
  }

  // Drafts
  @Get('drafts/:entity')
  draft(@CurrentUser() me: Me, @Param('entity') entity: string, @Query('key') key?: string) {
    return this.records.getDraft(me, entity, key || 'new');
  }

  @Put('drafts/:entity')
  saveDraft(@CurrentUser() me: Me, @Param('entity') entity: string, @Body() body: unknown) {
    const { key, payload } = parse(coreDraftSchema, body);
    return this.records.saveDraft(me, entity, key, payload);
  }

  @Delete('drafts/:entity')
  removeDraft(@CurrentUser() me: Me, @Param('entity') entity: string, @Query('key') key?: string) {
    return this.records.removeDraft(me, entity, key || 'new');
  }

  // Saved views
  @Get('views/:entity')
  views(@CurrentUser() me: Me, @Param('entity') entity: string) {
    return this.records.views(me, entity);
  }

  @Post('views/:entity')
  createView(@CurrentUser() me: Me, @Param('entity') entity: string, @Body() body: unknown) {
    return this.records.createView(me, entity, parse(coreSavedViewSchema, body) as Required<z.infer<typeof coreSavedViewSchema>>);
  }

  @Patch('views/item/:id')
  updateView(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    return this.records.updateView(me, id, parse(coreSavedViewSchema.partial(), body));
  }

  @Delete('views/item/:id')
  removeView(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.records.removeView(me, id);
  }

  // Watchers
  @Get('watchers/:type/:id')
  watchers(@CurrentUser() me: Me, @Param('type') type: string, @Param('id') id: string) {
    return this.records.watchers(me, type, id);
  }

  @Post('watchers/:type/:id')
  @HttpCode(200)
  watch(@CurrentUser() me: Me, @Param('type') type: string, @Param('id') id: string, @Body() body: unknown) {
    const { userIds } = parse(z.object({ userIds: z.array(z.string()).max(30).optional() }), body ?? {});
    return this.records.watch(me, type, id, userIds);
  }

  @Delete('watchers/:type/:id')
  unwatch(@CurrentUser() me: Me, @Param('type') type: string, @Param('id') id: string, @Query('userId') userId?: string) {
    return this.records.unwatch(me, type, id, userId);
  }

  // Tags
  @Get('tags')
  tags(@CurrentUser() me: Me) {
    return this.records.tags(me);
  }

  @Post('tags')
  createTag(@CurrentUser() me: Me, @Body() body: unknown) {
    const { name, color } = parse(coreTagSchema, body);
    return this.records.createTag(me, name, color);
  }

  @Get('tags/:type/:id')
  tagsOf(@CurrentUser() me: Me, @Param('type') type: string, @Param('id') id: string) {
    return this.records.tagsOf(me, type, id);
  }

  @Put('tags/:type/:id')
  setTags(@CurrentUser() me: Me, @Param('type') type: string, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.records.setTags(me, type, id, parse(coreSetTagsSchema, body), ip);
  }

  // Archive / restore (registered entities)
  @Post('archive/:entity/:id')
  @HttpCode(200)
  archive(@CurrentUser() me: Me, @Param('entity') entity: string, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.records.archive(me, entity, id, parse(coreArchiveSchema, body).reason, ip);
  }

  @Post('restore/:entity/:id')
  @HttpCode(200)
  restore(@CurrentUser() me: Me, @Param('entity') entity: string, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.records.restore(me, entity, id, ip);
  }

  // Command palette
  @Get('palette')
  paletteResolve(@CurrentUser() me: Me, @Query('q') q?: string) {
    return this.palette.resolve(me, q);
  }

  /** Runs the scheduled jobs now for your organisation (founder/admin; used by tests and support). */
  @Post('jobs/run')
  @HttpCode(200)
  async runJobs(@CurrentUser() me: Me) {
    if (!hasRole(me, 'founder', 'admin')) throw new ForbiddenException('Founders and admins only');
    return { ok: true as const, results: await this.jobs.tick(new Date(), me.orgId) };
  }
}

/** v11 core: generic CSV import (POST /imports/{entity}). */
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get()
  entities(@CurrentUser() me: Me) {
    return this.imports.entities(me);
  }

  @Get('jobs')
  jobs(@CurrentUser() me: Me, @Query('entity') entity?: string) {
    return this.imports.jobs(me, entity);
  }

  @Get('jobs/:id')
  job(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.imports.get(me, id);
  }

  @Get('jobs/:id/errors.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async errors(@CurrentUser() me: Me, @Param('id') id: string, @Res() res: Response) {
    const csv = await this.imports.errorReport(me, id);
    res.setHeader('Content-Disposition', `attachment; filename="import-errors-${id}.csv"`);
    res.send(csv);
  }

  @Post('jobs/:id/mapping')
  @HttpCode(200)
  remap(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    const { mapping } = parse(z.object({ mapping: z.record(z.string(), z.string()) }), body);
    return this.imports.remap(me, id, mapping);
  }

  @Post('jobs/:id/commit')
  @HttpCode(200)
  commit(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.imports.commit(me, id, parse(coreImportCommitSchema, body ?? {}).skipDuplicates, ip);
  }

  @Post(':entity')
  @HttpCode(200)
  preview(@CurrentUser() me: Me, @Param('entity') entity: string, @Body() body: unknown) {
    return this.imports.preview(me, entity, parse(coreImportPreviewSchema, body));
  }
}
