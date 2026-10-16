import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Me } from '@bmu/shared';
import { ClientIp, CurrentUser, Public } from '../common/decorators.js';
import { MeetingsService } from './meetings.service.js';

@Controller()
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Get('meetings')
  list(@CurrentUser() me: Me) {
    return this.meetings.list(me);
  }

  @Post('meetings')
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.create(me, body, ip);
  }

  @Get('meetings/booking-page')
  bookingPage(@CurrentUser() me: Me) {
    return this.meetings.bookingPage(me);
  }

  @Put('meetings/booking-page')
  saveBookingPage(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.saveBookingPage(me, body, ip);
  }

  // v23 meeting requests (declared before meetings/:id so the paths are not read as ids) ---------------------
  @Get('meetings/arrange-options')
  arrangeOptions(@CurrentUser() me: Me) {
    return this.meetings.arrangeOptions(me);
  }

  // v23 Google Meet: invitable people and my Google Calendar connection.
  @Get('meetings/people')
  people(@CurrentUser() me: Me) {
    return this.meetings.people(me);
  }

  @Get('meetings/google')
  google(@CurrentUser() me: Me) {
    return this.meetings.googleStatus(me);
  }

  @Post('meetings/google/connect')
  @HttpCode(200)
  googleConnect(@CurrentUser() me: Me) {
    return this.meetings.googleConnect(me);
  }

  @Post('meetings/google/disconnect')
  @HttpCode(200)
  googleDisconnect(@CurrentUser() me: Me, @ClientIp() ip?: string) {
    return this.meetings.googleDisconnect(me, ip);
  }

  @Post('meetings/founder-request')
  founderRequest(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.founderRequest(me, body, ip);
  }

  @Post('meetings/:id/arrange')
  @HttpCode(200)
  arrange(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.arrange(me, id, body, ip);
  }

  @Post('meetings/:id/respond')
  @HttpCode(200)
  respond(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.respond(me, id, body, ip);
  }

  @Post('meetings/:id/fix')
  @HttpCode(200)
  fix(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.fix(me, id, body, ip);
  }

  @Post('meetings/:id/link')
  @HttpCode(200)
  shareLink(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.shareLink(me, id, body, ip);
  }

  @Get('meetings/:id/branch-manager-options')
  branchManagerOptions(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.meetings.branchManagerOptions(me, id);
  }

  @Post('meetings/:id/branch-managers')
  @HttpCode(200)
  addBranchManagers(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.addBranchManagers(me, id, body, ip);
  }

  @Get('meetings/:id/member-options')
  memberOptions(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.meetings.memberOptions(me, id);
  }

  @Post('meetings/:id/members')
  @HttpCode(200)
  addMembers(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.addMembers(me, id, body, ip);
  }

  @Post('meetings/:id/join')
  @HttpCode(200)
  join(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.joinOrIgnore(me, id, body, ip);
  }

  @Get('meetings/:id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.meetings.get(me, id);
  }

  @Patch('meetings/:id')
  saveNotes(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.saveNotes(me, id, body, ip);
  }

  @Post('meetings/:id/summarise')
  @HttpCode(200)
  summarise(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.meetings.summarise(me, id);
  }

  @Post('meetings/:id/tasks')
  tasks(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.createTasks(me, id, body, ip);
  }

  @Post('meetings/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.meetings.cancel(me, id, ip);
  }

  // Client portal ------------------------------------------------------------
  @Get('client/meetings')
  clientList(@CurrentUser() me: Me) {
    return this.meetings.clientList(me);
  }

  @Get('client/meetings/slots')
  clientSlots(@CurrentUser() me: Me) {
    return this.meetings.clientSlots(me);
  }

  @Post('client/meetings')
  clientBook(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.clientBook(me, body, ip);
  }

  @Post('client/meetings/request')
  clientRequest(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.clientRequest(me, body, ip);
  }

  @Post('client/meetings/:id/cancel')
  @HttpCode(200)
  clientCancel(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.meetings.cancel(me, id, ip);
  }

  // Public booking link ------------------------------------------------------
  @Public()
  @Get('public/book/:slug')
  publicSlots(@Param('slug') slug: string) {
    return this.meetings.publicSlots(slug);
  }

  @Public()
  @Post('public/book/:slug')
  @HttpCode(200)
  publicBook(@Param('slug') slug: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.meetings.publicBook(slug, body, ip);
  }

  @Public()
  @Get('public/meetings/:id/ics')
  async ics(@Param('id') id: string, @Query('t') t: string, @Res() res: Response) {
    const body = await this.meetings.ics(id, t);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="meeting.ics"');
    res.send(body);
  }
}
