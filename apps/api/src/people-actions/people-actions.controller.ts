import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  peopleAddPersonSchema,
  peopleBulkSchema,
  peopleChangeRoleSchema,
  peopleCreateUnitSchema,
  peopleCustomRoleSchema,
  peopleEditPersonSchema,
  peopleHandoverSchema,
  peopleMoveSchema,
  peopleOffboardSchema,
  peoplePodSchema,
  type Me,
} from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { OffboardingService } from './offboarding.service.js';
import { PeopleActionsService } from './people-actions.service.js';

/** v11 people & hierarchy actions. Every route checks role + scope in its service. */
@Controller('people-actions')
export class PeopleActionsController {
  constructor(
    private readonly people: PeopleActionsService,
    private readonly offboarding: OffboardingService,
  ) {}

  @Get('options')
  options(@CurrentUser() me: Me) {
    return this.people.options(me);
  }

  @Get('tree')
  tree(@CurrentUser() me: Me) {
    return this.people.tree(me);
  }

  @Get('people')
  list(@CurrentUser() me: Me, @Query() q: Record<string, string | undefined>) {
    return this.people.list(me, q);
  }

  @Post('people/duplicates')
  @HttpCode(200)
  duplicates(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.people.duplicates(me, parse(z.object({ email: z.string().max(200).optional(), phone: z.string().max(40).optional(), name: z.string().max(120).optional() }), body ?? {}));
  }

  @Post('people')
  add(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.people.add(me, parse(peopleAddPersonSchema, body), ip);
  }

  @Get('people/:id')
  detail(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.people.detail(me, id);
  }

  @Patch('people/:id')
  edit(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.people.edit(me, id, parse(peopleEditPersonSchema, body), ip);
  }

  @Post('people/:id/invite')
  @HttpCode(200)
  invite(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.people.resendInvite(me, id);
  }

  @Post('people/:id/move/preview')
  @HttpCode(200)
  movePreview(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    return this.people.movePreview(me, id, parse(peopleMoveSchema, body));
  }

  @Post('people/:id/move')
  @HttpCode(200)
  async move(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { undoRows: _rows, ...r } = await this.people.move(me, id, parse(peopleMoveSchema, body), ip);
    return r;
  }

  @Post('people/:id/role/preview')
  @HttpCode(200)
  rolePreview(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    return this.people.rolePreview(me, id, parse(peopleChangeRoleSchema, body));
  }

  @Post('people/:id/role')
  @HttpCode(200)
  changeRole(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.people.changeRole(me, id, parse(peopleChangeRoleSchema, body), ip);
  }

  @Get('people/:id/offboarding')
  offboardingStatus(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.offboarding.status(me, id);
  }

  @Post('people/:id/offboard')
  @HttpCode(200)
  offboard(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.offboarding.start(me, id, parse(peopleOffboardSchema, body), ip);
  }

  @Post('people/:id/handover')
  @HttpCode(200)
  handover(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.offboarding.handover(me, id, parse(peopleHandoverSchema, body), ip);
  }

  @Post('people/:id/offboard/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.offboarding.confirm(me, id, ip);
  }

  @Post('scheduled/:id/cancel')
  @HttpCode(200)
  cancelScheduled(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.people.cancelScheduled(me, id, ip);
  }

  @Post('units')
  createUnit(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.people.createUnit(me, parse(peopleCreateUnitSchema, body), ip);
  }

  @Get('pods')
  pods(@CurrentUser() me: Me) {
    return this.people.pods(me);
  }

  @Post('pods')
  createPod(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.people.createPod(me, parse(peoplePodSchema, body), ip);
  }

  @Patch('pods/:id')
  updatePod(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.people.updatePod(me, id, parse(peoplePodSchema.partial(), body), ip);
  }

  @Delete('pods/:id')
  removePod(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.people.removePod(me, id, ip);
  }

  @Post('roles')
  customRole(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.people.customRole(me, parse(peopleCustomRoleSchema, body), ip);
  }

  @Post('bulk')
  @HttpCode(200)
  bulk(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.people.bulk(me, parse(peopleBulkSchema, body), ip);
  }

  /** Applies due scheduled changes and suspends leavers now (founder/admin; used by tests and support). */
  @Post('jobs/run')
  @HttpCode(200)
  runJobs(@CurrentUser() me: Me) {
    return this.people.runJobs(me);
  }
}
