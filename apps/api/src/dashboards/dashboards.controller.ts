import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { DashboardDataService } from './dashboard-data.service.js';
import { DashboardsService } from './dashboards.service.js';

/** v12 Dashboard Studio. Editing is for the Founder and Admins; widget data is scoped to whoever is looking. */
@Controller('dashboards')
export class DashboardsController {
  constructor(
    private readonly dashboards: DashboardsService,
    private readonly data: DashboardDataService,
  ) {}

  @Get()
  studio(@CurrentUser() me: Me) {
    return this.dashboards.studio(me);
  }

  @Get('mine')
  mine(@CurrentUser() me: Me) {
    return this.dashboards.mine(me);
  }

  @Get('home/:surface')
  home(@CurrentUser() me: Me, @Param('surface') surface: string) {
    return this.dashboards.home(me, surface);
  }

  @Get('builtin/:key')
  builtin(@CurrentUser() me: Me, @Param('key') key: string) {
    return this.dashboards.builtin(me, key);
  }

  @Post('data/explore')
  explore(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.data.explore(me, body);
  }

  @Get('data/report/:id')
  report(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.data.report(me, id);
  }

  @Get('data/field/:entity/:field')
  field(@CurrentUser() me: Me, @Param('entity') entity: string, @Param('field') field: string, @Query('scope') scope?: string) {
    return this.data.fieldBreakdown(me, entity, field, scope === 'all' ? 'all' : 'open');
  }

  @Get('data/list/:source')
  list(@CurrentUser() me: Me, @Param('source') source: string, @Query('limit') limit?: string) {
    return this.data.list(me, source, limit);
  }

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.dashboards.get(me, id);
  }

  @Post()
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip: string) {
    return this.dashboards.create(me, body, ip);
  }

  @Patch(':id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip: string) {
    return this.dashboards.update(me, id, body, ip);
  }

  @Post(':id/duplicate')
  duplicate(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip: string) {
    return this.dashboards.duplicate(me, id, ip);
  }

  @Post(':id/archive')
  archive(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip: string) {
    return this.dashboards.archive(me, id, body, ip);
  }

  @Post(':id/restore')
  restore(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip: string) {
    return this.dashboards.restore(me, id, ip);
  }

  @Post(':id/reset')
  reset(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip: string) {
    return this.dashboards.reset(me, id, ip);
  }

  @Get(':id/versions')
  versions(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.dashboards.versions(me, id);
  }

  @Post(':id/versions/:versionId/restore')
  restoreVersion(@CurrentUser() me: Me, @Param('id') id: string, @Param('versionId') versionId: string, @ClientIp() ip: string) {
    return this.dashboards.restoreVersion(me, id, versionId, ip);
  }
}
