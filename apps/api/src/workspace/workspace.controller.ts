import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import {
  briefFeedbackSchema,
  createBriefSchema,
  creatorProfileSchema,
  inviteClientUserSchema,
  leaveRequestSchema,
  submissionLinkSchema,
  updateClientUserSchema,
  updateMeSchema,
  type Me,
} from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { storageRoot } from '../production/production.controller.js';
import { ClientWorkspaceService } from './client-workspace.service.js';
import { CreatorsService, type Upload } from './creators.service.js';
import { TeamWorkspaceService } from './team.service.js';

const upload = FileInterceptor('file', {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      const dir = join(storageRoot(), new Date().toISOString().slice(0, 7));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase().slice(0, 10)}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

/** Team workspace: Client 360, calendar, capacity, SOP library, profile and leave. */
@Controller('workspace')
export class TeamWorkspaceController {
  constructor(private readonly team: TeamWorkspaceService) {}

  @Get('clients/:id')
  client360(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.team.client360(me, id);
  }

  @Get('calendar')
  calendar(@CurrentUser() me: Me, @Query('month') month?: string, @Query('view') view?: string) {
    return this.team.calendar(me, month, view === 'team' ? 'team' : 'mine');
  }

  @Get('capacity')
  capacity(@CurrentUser() me: Me) {
    return this.team.capacity(me);
  }

  @Get('sops')
  sops(@CurrentUser() me: Me) {
    return this.team.sops(me);
  }

  @Get('sops/:id')
  sop(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.team.sop(me, id);
  }

  @Get('profile')
  profile(@CurrentUser() me: Me) {
    return this.team.profile(me);
  }

  @Patch('me')
  updateMe(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.team.updateMe(me, parse(updateMeSchema, body), ip);
  }

  @Post('leave')
  applyLeave(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.team.applyLeave(me, parse(leaveRequestSchema, body), ip);
  }

  @Post('leave/:id/cancel')
  @HttpCode(200)
  cancelLeave(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.team.cancelLeave(me, id, ip);
  }
}

/** Creator management for the team. */
@Controller('workspace')
export class CreatorAdminController {
  constructor(private readonly creators: CreatorsService) {}

  @Get('creators')
  list(@CurrentUser() me: Me) {
    return this.creators.creators(me);
  }

  @Get('briefs/options')
  options(@CurrentUser() me: Me) {
    return this.creators.options(me);
  }

  @Get('briefs')
  briefs(@CurrentUser() me: Me) {
    return this.creators.briefs(me);
  }

  @Post('briefs')
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creators.createBrief(me, parse(createBriefSchema, body), ip);
  }

  @Get('briefs/:id')
  brief(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.creators.brief(me, id);
  }

  @Post('briefs/:id/feedback')
  @HttpCode(200)
  feedback(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creators.feedback(me, id, parse(briefFeedbackSchema, body).feedback, ip);
  }

  @Post('briefs/:id/approve')
  @HttpCode(200)
  approve(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.creators.approve(me, id, ip);
  }

  @Post('briefs/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.creators.cancel(me, id, ip);
  }

  @Post('briefs/:id/submissions')
  @UseInterceptors(upload)
  submitFile(@CurrentUser() me: Me, @Param('id') id: string, @UploadedFile() file: Upload | undefined, @Body() body: { note?: string }, @ClientIp() ip?: string) {
    return this.creators.staffSubmit(me, id, { file, note: body?.note?.trim() || undefined }, storageRoot(), ip);
  }

  @Post('briefs/:id/submissions/link')
  submitLink(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creators.staffSubmit(me, id, parse(submissionLinkSchema, body), storageRoot(), ip);
  }

  /** Streams a submission's stored file to its creator or a creator manager. */
  @Get('submissions/:id/file')
  async file(@CurrentUser() me: Me, @Param('id') id: string, @Res() res: Response) {
    const file = await this.creators.submissionFile(me, id);
    const root = storageRoot();
    const abs = resolve(root, file.path);
    if (!abs.startsWith(root)) throw new NotFoundException('File not found');
    res.setHeader('Content-Disposition', `inline; filename="${(file.name ?? 'file').replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (file.mimeType) res.type(file.mimeType);
    res.sendFile(abs, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'File missing on disk' });
    });
  }
}

/** Creator portal: a creator's own briefs, submissions, payouts and profile. */
@Controller('workspace/creator')
export class CreatorPortalController {
  constructor(private readonly creators: CreatorsService) {}

  @Get('briefs')
  briefs(@CurrentUser() me: Me) {
    return this.creators.myBriefs(me);
  }

  @Get('briefs/:id')
  brief(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.creators.myBrief(me, id);
  }

  @Post('briefs/:id/accept')
  @HttpCode(200)
  accept(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.creators.respond(me, id, true, ip);
  }

  @Post('briefs/:id/decline')
  @HttpCode(200)
  decline(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.creators.respond(me, id, false, ip);
  }

  @Post('briefs/:id/submissions')
  @UseInterceptors(upload)
  submitFile(@CurrentUser() me: Me, @Param('id') id: string, @UploadedFile() file: Upload | undefined, @Body() body: { note?: string }, @ClientIp() ip?: string) {
    return this.creators.creatorSubmit(me, id, { file, note: body?.note?.trim() || undefined }, storageRoot(), ip);
  }

  @Post('briefs/:id/submissions/link')
  submitLink(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creators.creatorSubmit(me, id, parse(submissionLinkSchema, body), storageRoot(), ip);
  }

  @Get('payouts')
  payouts(@CurrentUser() me: Me) {
    return this.creators.payouts(me);
  }

  @Get('profile')
  profile(@CurrentUser() me: Me) {
    return this.creators.profile(me);
  }

  @Put('profile')
  saveProfile(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creators.saveProfile(me, parse(creatorProfileSchema, body), ip);
  }
}

/** Client app: monthly report and team users. */
@Controller('workspace/client')
export class ClientWorkspaceController {
  constructor(private readonly client: ClientWorkspaceService) {}

  @Get('report')
  report(@CurrentUser() me: Me, @Query('month') month?: string) {
    return this.client.report(me, month);
  }

  @Get('team')
  team(@CurrentUser() me: Me) {
    return this.client.team(me);
  }

  @Post('team')
  invite(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.client.invite(me, parse(inviteClientUserSchema, body), ip);
  }

  @Patch('team/:userId')
  update(@CurrentUser() me: Me, @Param('userId') userId: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.client.update(me, userId, parse(updateClientUserSchema, body), ip);
  }
}
