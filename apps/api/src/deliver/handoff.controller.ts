import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { HandoffService } from './handoff.service.js';

/** v37 manual hand-off: Client Manager → Department Head → people. */
@Controller('handoff')
export class HandoffController {
  constructor(private readonly handoff: HandoffService) {}

  @Get('inbox')
  inbox(@CurrentUser() me: Me) {
    return this.handoff.inbox(me);
  }

  @Get('projects/:id')
  project(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.handoff.project(me, id);
  }

  @Post('projects/:id/send')
  @HttpCode(200)
  send(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.handoff.send(me, id, body, ip);
  }

  @Get('deliverables/:id/options')
  options(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.handoff.options(me, id);
  }

  @Post('deliverables/:id/assign')
  @HttpCode(200)
  assign(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.handoff.assign(me, id, body, ip);
  }
}
