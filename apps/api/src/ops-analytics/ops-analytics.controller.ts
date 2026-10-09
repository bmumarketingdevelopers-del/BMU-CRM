import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { OpsDeliveryService } from './delivery.service.js';
import { OpsExploreService } from './explore.service.js';
import { OpsSelfService } from './self.service.js';
import { OpsSlaService } from './sla.service.js';
import { OpsTeamService } from './team.service.js';

/** v9 operations analytics. Every read takes from/to (ISO dates, default the last 90 days). Each service checks who may read it. */
@Controller('ops-analytics')
export class OpsAnalyticsController {
  constructor(
    private readonly team: OpsTeamService,
    private readonly delivery: OpsDeliveryService,
    private readonly slaService: OpsSlaService,
    private readonly explorer: OpsExploreService,
    private readonly self: OpsSelfService,
  ) {}

  @Get('team')
  teamView(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string, @Query('departmentId') departmentId?: string) {
    return this.team.team(me, { from, to, departmentId });
  }

  @Get('delivery')
  deliveryView(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.delivery.delivery(me, { from, to });
  }

  @Get('sla')
  sla(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.slaService.sla(me, { from, to });
  }

  @Get('me')
  mine(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.self.me(me, { from, to });
  }

  @Get('client')
  client(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.self.client(me, { from, to });
  }

  @Post('explore')
  @HttpCode(200)
  explore(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.explorer.explore(me, body);
  }

  @Get('reports')
  reports(@CurrentUser() me: Me) {
    return this.explorer.reports(me);
  }

  @Get('reports/:id')
  report(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.explorer.report(me, id);
  }

  @Post('reports')
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.explorer.create(me, body, ip);
  }

  @Patch('reports/:id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.explorer.update(me, id, body, ip);
  }

  @Delete('reports/:id')
  remove(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.explorer.remove(me, id, ip);
  }
}
