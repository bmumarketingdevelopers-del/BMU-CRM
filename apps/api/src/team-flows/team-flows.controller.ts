import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  teamAddItemSchema,
  teamDecideTimesheetSchema,
  teamReassignSchema,
  teamStartOffboardingSchema,
  teamStartOnboardingSchema,
  teamSubmitTimesheetSchema,
  teamTickSchema,
  teamTimeEntrySchema,
  type Me,
  type TeamBranding,
} from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { SettingsService } from '../settings/settings.service.js';
import { ActivityService } from './activity.service.js';
import { CoverService } from './cover.service.js';
import { PeopleService } from './people.service.js';
import { SearchService } from './search.service.js';
import { TimesheetsService } from './timesheets.service.js';
import { cached } from '../platform/read-cache.js';

const coverReassignSchema = z.object({ taskIds: z.array(z.string().min(1)).min(1).max(200), toUserId: z.string().min(1) });

/** v10 team flows. Every service checks who may do what. */
@Controller('team-flows')
export class TeamFlowsController {
  constructor(
    private readonly people: PeopleService,
    private readonly timesheets: TimesheetsService,
    private readonly coverService: CoverService,
    private readonly searchService: SearchService,
    private readonly activityService: ActivityService,
    private readonly settings: SettingsService,
  ) {}

  // Onboarding & offboarding
  @Get('people')
  list(@CurrentUser() me: Me, @Query('kind') kind?: string) {
    return this.people.list(me, kind);
  }

  @Get('people/options')
  options(@CurrentUser() me: Me) {
    return this.people.options(me);
  }

  @Get('people/mine')
  mine(@CurrentUser() me: Me) {
    return this.people.mine(me);
  }

  /** Onboarding history: every onboarding the signed-in person is part of. */
  @Get('people/involved')
  involved(@CurrentUser() me: Me) {
    return this.people.involved(me);
  }

  @Get('people/:id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.people.get(me, id);
  }

  @Post('people/onboarding')
  startOnboarding(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.people.startOnboarding(me, parse(teamStartOnboardingSchema, body), ip);
  }

  @Post('people/offboarding')
  startOffboarding(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.people.startOffboarding(me, parse(teamStartOffboardingSchema, body), ip);
  }

  @Post('people/:id/tick')
  @HttpCode(200)
  tick(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { key, done } = parse(teamTickSchema, body);
    return this.people.tick(me, id, key, done, ip);
  }

  @Post('people/:id/items')
  addItem(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { label, group } = parse(teamAddItemSchema, body);
    return this.people.addItem(me, id, label, group, ip);
  }

  @Post('people/:id/reassign')
  @HttpCode(200)
  reassign(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.people.reassign(me, id, parse(teamReassignSchema, body), ip);
  }

  @Post('people/:id/complete')
  @HttpCode(200)
  complete(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.people.complete(me, id, ip);
  }

  @Post('people/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.people.cancel(me, id, ip);
  }

  @Post('sops/:id/acknowledge')
  @HttpCode(200)
  acknowledge(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.people.acknowledgeSop(me, id, ip);
  }

  // Timesheets
  @Get('timesheets/week')
  week(@CurrentUser() me: Me, @Query('week') week?: string, @Query('userId') userId?: string) {
    return this.timesheets.week(me, week, userId);
  }

  @Post('timesheets/entries')
  addEntry(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.timesheets.addEntry(me, parse(teamTimeEntrySchema, body), ip);
  }

  @Delete('timesheets/entries/:id')
  removeEntry(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.timesheets.removeEntry(me, id, ip);
  }

  @Post('timesheets/submit')
  @HttpCode(200)
  submit(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.timesheets.submit(me, parse(teamSubmitTimesheetSchema, body).weekStart, ip);
  }

  @Get('timesheets/approvals')
  approvals(@CurrentUser() me: Me, @Query('status') status?: string) {
    return this.timesheets.approvals(me, status);
  }

  @Get('timesheets/:id')
  timesheet(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.timesheets.byId(me, id);
  }

  @Post('timesheets/:id/decide')
  @HttpCode(200)
  decide(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.timesheets.decide(me, id, parse(teamDecideTimesheetSchema, body), ip);
  }

  // Leave cover
  @Get('leave/out')
  whoIsOut(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.coverService.whoIsOut(me, from, to);
  }

  @Get('leave/:id/cover')
  cover(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.coverService.cover(me, id);
  }

  @Post('leave/:id/reassign')
  @HttpCode(200)
  coverReassign(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { taskIds, toUserId } = parse(coverReassignSchema, body);
    return this.coverService.reassign(me, id, taskIds, toUserId, ip);
  }

  // Search & activity
  @Get('search')
  search(@CurrentUser() me: Me, @Query('q') q?: string, @Query('surface') surface?: string, @Query('kinds') kinds?: string) {
    return cached(me.orgId, `search:${me.id}:${surface}:${kinds}:${q}`, 30_000, () => this.searchService.search(me, q, surface, kinds));
  }

  @Get('activity')
  activity(@CurrentUser() me: Me, @Query('entity') entity?: string, @Query('id') id?: string, @Query('actor') actor?: string, @Query('take') take?: string) {
    return this.activityService.feed(me, entity, id, actor, take);
  }

  /** Client-app branding for any signed-in user (clients see their app name and colours). */
  @Get('branding')
  async branding(@CurrentUser() me: Me): Promise<TeamBranding> {
    const [b, t] = await Promise.all([this.settings.get(me.orgId, 'branding'), this.settings.get(me.orgId, 'tenant')]);
    return { clientAppName: b.clientAppName || 'BMU Hub', primary: b.primary, accent: b.accent, background: b.background, logoUrl: b.logoUrl, supportEmail: t.supportEmail, supportPhone: t.supportPhone, orgName: t.name };
  }
}
