import { Module } from '@nestjs/common';
import { DocsController } from './docs.controller.js';
import { DocsService } from './docs.service.js';
import { CommsWebhooksController, InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';
import { MeetingsController } from './meetings.controller.js';
import { MeetingsService } from './meetings.service.js';
import { NotificationRouter } from './notification-router.js';
import { WhatsAppSender } from './whatsapp.sender.js';

/** v17 communications: shared inbox (WhatsApp + email), collaborative documents and meeting booking. */
@Module({
  controllers: [InboxController, CommsWebhooksController, DocsController, MeetingsController],
  providers: [InboxService, WhatsAppSender, DocsService, MeetingsService, NotificationRouter],
  exports: [InboxService, WhatsAppSender, DocsService, MeetingsService],
})
export class CommsModule {}
