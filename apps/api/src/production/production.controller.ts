import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { z } from 'zod';
import { addLinkVersionSchema, CORE_TASK_EDIT_KEYS, coreTaskEditSchema, eodSchema, qcSubmitSchema, reviewCommentSchema, updateTaskSchema, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { ProductionService, type UploadedFile as Upload } from './production.service.js';
import { TasksActionsService } from '../actions/tasks/tasks.service.js';

/** Uploaded files live on disk under STORAGE_DIR (default apps/api/storage). Swap for S3/R2 in production. */
export const storageRoot = () => {
  const dir = process.env.STORAGE_DIR?.trim() || 'storage';
  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
};

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

const commentBody = reviewCommentSchema.extend({ versionId: z.string() });

@Controller('tasks')
export class TasksController {
  constructor(
    private readonly production: ProductionService,
    private readonly taskActions: TasksActionsService,
  ) {}

  @Get()
  list(@CurrentUser() me: Me, @Query('view') view?: string) {
    return this.production.tasks(me, view === 'team' ? 'team' : 'mine');
  }

  @Patch(':id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    // v11 core: PATCH /tasks/:id with edit fields (title, description, priority…) is the task edit action.
    if (body && typeof body === 'object' && CORE_TASK_EDIT_KEYS.some((k) => k in body)) return this.taskActions.edit(me, id, parse(coreTaskEditSchema, body), ip);
    return this.production.updateTask(me, id, parse(updateTaskSchema, body), ip);
  }
}

@Controller('my-day')
export class MyDayController {
  constructor(private readonly production: ProductionService) {}

  @Get()
  get(@CurrentUser() me: Me) {
    return this.production.myDay(me);
  }

  @Post('check-in')
  @HttpCode(200)
  checkIn(@CurrentUser() me: Me) {
    return this.production.checkIn(me, false);
  }

  @Post('check-out')
  @HttpCode(200)
  checkOut(@CurrentUser() me: Me) {
    return this.production.checkIn(me, true);
  }

  @Put('eod')
  eod(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.production.submitEod(me, parse(eodSchema, body));
  }
}

@Controller('deliverables')
export class DeliverablesController {
  constructor(private readonly production: ProductionService) {}

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.production.deliverable(me, id);
  }

  @Post(':id/versions')
  @UseInterceptors(upload)
  addFile(@CurrentUser() me: Me, @Param('id') id: string, @UploadedFile() file: Upload | undefined, @Body() body: { note?: string }, @ClientIp() ip?: string) {
    return this.production.addVersion(me, id, { file, note: body?.note?.trim() || undefined }, storageRoot(), ip);
  }

  @Post(':id/versions/link')
  addLink(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { url, note } = parse(addLinkVersionSchema, body);
    return this.production.addVersion(me, id, { url, note }, storageRoot(), ip);
  }

  @Post(':id/comments')
  comment(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.production.comment(me, id, parse(commentBody, body), ip);
  }

  @Post('versions/:versionId/qc')
  @HttpCode(200)
  qc(@CurrentUser() me: Me, @Param('versionId') versionId: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.production.submitQc(me, versionId, parse(qcSubmitSchema, body), ip);
  }

  @Post('versions/:versionId/send')
  @HttpCode(200)
  send(@CurrentUser() me: Me, @Param('versionId') versionId: string, @ClientIp() ip?: string) {
    return this.production.sendToClient(me, versionId, ip);
  }
}

@Controller('qc')
export class QcController {
  constructor(private readonly production: ProductionService) {}

  @Get('queue')
  queue(@CurrentUser() me: Me) {
    return this.production.qcQueue(me);
  }
}

@Controller('client/reviews')
export class ClientReviewsController {
  constructor(private readonly production: ProductionService) {}

  @Get()
  list(@CurrentUser() me: Me) {
    return this.production.clientReviews(me);
  }

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.production.clientDeliverable(me, id);
  }

  @Post(':id/comments')
  comment(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.production.comment(me, id, parse(commentBody, body), ip);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { versionId } = parse(z.object({ versionId: z.string() }), body);
    return this.production.clientApprove(me, id, versionId, ip);
  }

  @Post(':id/request-changes')
  @HttpCode(200)
  requestChanges(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { comment } = parse(z.object({ comment: z.string().trim().max(4000).optional() }), body ?? {});
    return this.production.clientRequestChanges(me, id, comment || undefined, ip);
  }
}

@Controller('files')
export class FilesController {
  constructor(private readonly production: ProductionService) {}

  /** Streams a stored file inline (supports video seeking via range requests). */
  @Get(':id')
  async get(@CurrentUser() me: Me, @Param('id') id: string, @Query('download') download: string | undefined, @Res() res: Response) {
    const file = await this.production.fileFor(me, id);
    // Clients download final files only after Gate 5 (sign-off + balance paid) released them.
    if (download && me.type === 'client' && !file.released) throw new ForbiddenException('Final files unlock after sign-off and the final payment');
    if (file.kind === 'link') return res.redirect(file.path);
    const root = storageRoot();
    const abs = resolve(root, file.path);
    if (!abs.startsWith(root)) throw new NotFoundException('File not found');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${(file.name ?? 'file').replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (file.mimeType) res.type(file.mimeType);
    res.sendFile(abs, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'File missing on disk' });
    });
  }
}
