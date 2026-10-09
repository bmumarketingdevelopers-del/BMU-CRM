import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import {
  deliverApprovalModeSchema,
  deliverFeedbackSchema,
  deliverHandoverItemSchema,
  deliverPublishSchema,
  deliverRemindSchema,
  deliverScheduleSchema,
  type ClientOnboarding,
  type Me,
} from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isLeadership } from '../engagements/engagement-access.js';
import { engagementInclude, toRequirement } from '../engagements/engagements.service.js';
import { storageRoot } from '../production/production.controller.js';
import { DeliverApprovalsService, type ClientUpload } from './deliver-approvals.service.js';
import { DeliverCalendarService } from './deliver-calendar.service.js';
import { DeliverCyclesService } from './deliver-cycles.service.js';
import { DeliverHandoverService } from './deliver-handover.service.js';
import { DeliverSlaService } from './deliver-sla.service.js';

const upload = FileInterceptor('file', {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      const dir = join(storageRoot(), new Date().toISOString().slice(0, 7));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase().slice(0, 10)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

/** v10 deliver area: retainer months, content calendar, approval rules, delivery SLA and the handover pack. */
@Controller('deliver')
export class DeliverController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cycles: DeliverCyclesService,
    private readonly calendar: DeliverCalendarService,
    private readonly approvals: DeliverApprovalsService,
    private readonly sla: DeliverSlaService,
    private readonly handover: DeliverHandoverService,
  ) {}

  // Retainer months -----------------------------------------------------------

  @Get('engagements/:id/cycles')
  cycleList(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.cycles.view(me, id);
  }

  @Post('engagements/:id/cycles/next')
  @HttpCode(200)
  startNext(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.cycles.startNext(me, id, ip);
  }

  /** Runs the monthly job now (leadership): starts this month for every running retainer that lacks it. */
  @Post('retainers/run')
  @HttpCode(200)
  runRetainers(@CurrentUser() me: Me) {
    if (me.type !== 'staff' || !isLeadership(me)) throw new ForbiddenException('Leadership only');
    return this.cycles.runAuto(new Date(), undefined, me.orgId);
  }

  // Content calendar ----------------------------------------------------------

  @Get('calendar')
  teamCalendar(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.calendar.team(me, from, to);
  }

  @Get('client/calendar')
  clientCalendar(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.calendar.client(me, from, to);
  }

  @Patch('deliverables/:id/schedule')
  schedule(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.calendar.schedule(me, id, parse(deliverScheduleSchema, body), ip);
  }

  @Post('deliverables/:id/unschedule')
  @HttpCode(200)
  unschedule(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.calendar.unschedule(me, id, ip);
  }

  @Post('deliverables/:id/publish')
  @HttpCode(200)
  publish(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.calendar.publish(me, id, parse(deliverPublishSchema, body).liveUrl, ip);
  }

  // Approval rules -------------------------------------------------------------

  @Get('client/approval-settings')
  clientApprovalSettings(@CurrentUser() me: Me) {
    return this.approvals.clientSettings(me);
  }

  @Put('client/approval-settings')
  saveClientApprovalSettings(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.approvals.saveClientSettings(me, parse(deliverApprovalModeSchema, body).mode, ip);
  }

  @Get('clients/:id/approval-mode')
  staffApprovalSettings(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.approvals.staffSettings(me, id);
  }

  @Put('clients/:id/approval-mode')
  saveStaffApprovalSettings(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.approvals.saveStaffSettings(me, id, parse(deliverApprovalModeSchema, body).mode, ip);
  }

  @Post('approvals/remind')
  @HttpCode(200)
  remind(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    const { target, id } = parse(deliverRemindSchema, body);
    return this.approvals.remind(me, target, id, ip);
  }

  // Delivery SLA ---------------------------------------------------------------

  @Get('sla')
  slaView(@CurrentUser() me: Me, @Query('mine') mine?: string) {
    return this.sla.view(me, { mine: mine === '1' });
  }

  /** Runs the escalation job now (leadership). */
  @Post('sla/run')
  @HttpCode(200)
  runSla(@CurrentUser() me: Me) {
    if (me.type !== 'staff' || !isLeadership(me)) throw new ForbiddenException('Leadership only');
    return this.sla.escalate(new Date(), undefined, me.orgId);
  }

  // Handover pack and feedback ---------------------------------------------------

  @Get('engagements/:id/handover')
  handoverView(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.handover.view(me, id);
  }

  @Post('engagements/:id/handover/items')
  addItem(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.handover.addItem(me, id, parse(deliverHandoverItemSchema, body), ip);
  }

  @Delete('handover/items/:itemId')
  removeItem(@CurrentUser() me: Me, @Param('itemId') itemId: string, @ClientIp() ip?: string) {
    return this.handover.removeItem(me, itemId, ip);
  }

  @Get('engagements/:id/handover.zip')
  zip(@CurrentUser() me: Me, @Param('id') id: string, @Res() res: Response) {
    return this.handover.zip(me, id, res);
  }

  @Post('engagements/:id/feedback')
  @HttpCode(200)
  feedback(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.handover.feedback(me, id, parse(deliverFeedbackSchema, body), ip);
  }

  // Client onboarding uploads -----------------------------------------------------

  @Post('client/requirements/:id/upload')
  @HttpCode(200)
  @UseInterceptors(upload)
  async uploadRequirement(@CurrentUser() me: Me, @Param('id') id: string, @UploadedFile() file: ClientUpload | undefined, @Body() body: { note?: string }, @ClientIp() ip?: string): Promise<ClientOnboarding> {
    await this.approvals.uploadRequirement(me, id, file, body?.note?.trim().slice(0, 500) || undefined, storageRoot(), ip);
    const rows = await this.prisma.engagement.findMany({ where: { clientOrgId: me.clientOrg!.id, deletedAt: null }, include: engagementInclude, orderBy: { createdAt: 'asc' } });
    return {
      engagements: rows.map((e) => ({ id: e.id, serviceName: e.service.name, rcdAt: e.cycles[0]?.rcdAt?.toISOString() ?? null, requirements: (e.cycles[0]?.requirements ?? []).map(toRequirement) })),
    };
  }
}
