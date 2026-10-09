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
