import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { z } from 'zod';
import { createRequestSchema, decideRequestSchema, sendMessageSchema, serviceRateRequestSchema, serviceReopenRequestSchema, type Me } from '@bmu/shared';
import { storageRoot } from '../production/production.controller.js';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { BillingService } from './billing.service.js';
import { DeliveryService } from './delivery.service.js';
import { MessagesService, type UploadedAttachment } from './messages.service.js';
import { RequestsService } from './requests.service.js';

const commentSchema = z.object({ body: z.string().trim().min(1).max(4000) });
/** Message attachments: up to 25 MB, stored next to deliverable files under STORAGE_DIR. */
const attachmentUpload = FileInterceptor('file', {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      const dir = join(storageRoot(), 'messages', new Date().toISOString().slice(0, 7));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase().slice(0, 10)}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const verifySchema = z.object({ razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() });

@Controller('requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get()
  list(@CurrentUser() me: Me) {
    return this.requests.list(me);
  }

  /** Priced add-ons an AM can quote from (custom amounts are Founder/Admin only). */
  @Get('add-ons')
  addOns(@CurrentUser() me: Me) {
    return this.requests.addOns(me);
  }

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.requests.get(me, id);
  }

  @Post(':id/decide')
  @HttpCode(200)
  decide(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.requests.decide(me, id, parse(decideRequestSchema, body), ip);
  }
}

@Controller('client')
export class ClientDeskController {
  constructor(
    private readonly requests: RequestsService,
    private readonly delivery: DeliveryService,
    private readonly messages: MessagesService,
    private readonly billing: BillingService,
  ) {}

  @Get('requests')
  list(@CurrentUser() me: Me) {
    return this.requests.list(me);
  }

  @Post('requests')
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.requests.create(me, parse(createRequestSchema, body), ip);
  }

  @Get('requests/:id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.requests.get(me, id);
  }

  @Post('requests/:id/comments')
  comment(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.requests.clientComment(me, id, parse(commentSchema, body).body, ip);
  }

  /** v10: thumbs up/down once a request is done (feeds Client Health and SLA analytics). */
  @Post('requests/:id/rate')
  @HttpCode(200)
  rate(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.requests.rate(me, id, parse(serviceRateRequestSchema, body), ip);
  }

  /** v10: reopen a done request within 7 days. */
  @Post('requests/:id/reopen')
  @HttpCode(200)
  reopen(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.requests.reopen(me, id, parse(serviceReopenRequestSchema, body).reason, ip);
  }

  @Post('requests/:id/approve-quote')
  @HttpCode(200)
  approveQuote(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.requests.approveQuote(me, id, ip);
  }

  @Post('requests/:id/decline-quote')
  @HttpCode(200)
  declineQuote(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.requests.declineQuote(me, id, parse(z.object({ reason: z.string().trim().max(2000).optional() }), body ?? {}).reason, ip);
  }

  @Get('delivery')
  deliveryStatus(@CurrentUser() me: Me) {
    return this.delivery.clientDelivery(me);
  }

  @Post('engagements/:id/sign-off')
  @HttpCode(200)
  signOff(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.delivery.signOff(me, id, ip);
  }

  @Get('files')
  files(@CurrentUser() me: Me) {
    return this.delivery.clientFiles(me);
  }

  @Get('thread')
  thread(@CurrentUser() me: Me) {
    return this.messages.forClient(me);
  }

  @Post('thread/messages')
  send(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    const m = parse(sendMessageSchema, body);
    return this.messages.send(me, null, m.body, false, ip, m.attachmentIds);
  }

  @Post('thread/attachments')
  @UseInterceptors(attachmentUpload)
  attach(@CurrentUser() me: Me, @UploadedFile() file: UploadedAttachment | undefined) {
    return this.messages.upload(me, null, file, storageRoot());
  }

  @Post('invoices/:id/checkout')
  @HttpCode(200)
  checkout(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.billing.checkout(me, id);
  }

  @Post('invoices/:id/verify')
  @HttpCode(200)
  verify(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    return this.billing.verify(me, id, parse(verifySchema, body));
  }

  @Post('invoices/:id/pay-test')
  @HttpCode(200)
  payTest(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.billing.payTest(me, id);
  }
}

@Controller('threads')
export class ThreadsController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  list(@CurrentUser() me: Me) {
    return this.messages.list(me);
  }

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.messages.get(me, id);
  }

  @Post(':id/messages')
  send(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { body: text, internal, attachmentIds } = parse(sendMessageSchema, body);
    return this.messages.send(me, id, text, internal, ip, attachmentIds);
  }

  @Post(':id/attachments')
  @UseInterceptors(attachmentUpload)
  attach(@CurrentUser() me: Me, @Param('id') id: string, @UploadedFile() file: UploadedAttachment | undefined) {
    return this.messages.upload(me, id, file, storageRoot());
  }
}

/** Downloads a message attachment for anyone who can see that client thread. */
@Controller('thread-files')
export class ThreadFilesController {
  constructor(private readonly messages: MessagesService) {}

  @Get(':id')
  async get(@CurrentUser() me: Me, @Param('id') id: string, @Query('download') download: string | undefined, @Res() res: Response) {
    const file = await this.messages.attachmentFor(me, id);
    const root = storageRoot();
    const abs = resolve(root, file.path);
    if (!abs.startsWith(root)) throw new NotFoundException('File not found');
    const inline = !download && /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/.test(file.mimeType ?? '');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${(file.name ?? 'file').replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (file.mimeType) res.type(file.mimeType);
    res.sendFile(abs, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'File missing on disk' });
    });
  }
}
