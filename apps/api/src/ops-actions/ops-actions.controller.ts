// v11 ops: HTTP endpoints for the ops actions (all under /ops). Services hold the rules; controllers only parse.
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { opsLeadBulkSchema, opsLeadLostSchema, opsLeadMergeSchema, opsLeadNoteSchema, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser, Public } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { sendStoredFile } from '../storage/file-store.js';
import { OpsAdminService } from './ops-admin.service.js';
import { OpsCommsService } from './ops-comms.service.js';
import { OpsCreatorsService } from './ops-creators.service.js';
import { OpsFilesService } from './ops-files.service.js';
import { OpsFinanceService } from './ops-finance.service.js';
import { OpsLeadsService } from './ops-leads.service.js';
import { opsUpload, type OpsUpload } from './ops-util.js';

@Controller('ops/leads')
export class OpsLeadsController {
  constructor(private readonly leads: OpsLeadsService) {}

  @Get('options')
  options(@CurrentUser() me: Me) {
    return this.leads.addOptions(me);
  }

  @Get('duplicates')
  duplicates(@CurrentUser() me: Me, @Query('phone') phone?: string, @Query('email') email?: string, @Query('company') company?: string, @Query('excludeId') excludeId?: string) {
    return this.leads.duplicates(me, { phone, email, company, excludeId });
  }

  @Post()
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.leads.create(me, body, ip);
  }

  @Post('bulk')
  @HttpCode(200)
  bulk(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.leads.bulk(me, parse(opsLeadBulkSchema, body), ip);
  }

  @Post(':id/lost')
  @HttpCode(200)
  lost(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.leads.markLost(me, id, parse(opsLeadLostSchema, body).reason, ip);
  }

  @Post(':id/merge')
  @HttpCode(200)
  merge(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.leads.merge(me, id, parse(opsLeadMergeSchema, body).intoId, ip);
  }

  @Post(':id/notes')
  note(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.leads.note(me, id, parse(opsLeadNoteSchema, body), ip);
  }

  @Get(':id/convert-options')
  convertOptions(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.leads.convertOptions(me, id);
  }

  @Post(':id/convert')
  @HttpCode(200)
  convert(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.leads.convert(me, id, body, ip);
  }
}

@Controller('ops/finance')
export class OpsFinanceController {
  constructor(private readonly finance: OpsFinanceService) {}

  @Get('options')
  options(@CurrentUser() me: Me) {
    return this.finance.options(me);
  }

  @Post('invoices')
  createInvoice(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.finance.createInvoice(me, body, ip);
  }

  /** v27: invoice wording (AI when on) for the Founder's short descriptions, before the invoice is made. */
  @Post('invoices/describe')
  @HttpCode(200)
  describe(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.finance.describe(me, body);
  }

  @Get('drafts')
  drafts(@CurrentUser() me: Me) {
    return this.finance.drafts(me);
  }

  @Post('invoices/:id/issue')
  @HttpCode(200)
  issue(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.finance.issue(me, id, ip);
  }

  @Post('invoices/:id/offline-payment')
  offlinePayment(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.finance.offlinePayment(me, id, body, ip);
  }

  @Post('invoices/:id/due-date')
  @HttpCode(200)
  dueDate(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.finance.changeDueDate(me, id, body, ip);
  }

  @Post('payouts')
  payout(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.finance.proposePayout(me, body, ip);
  }
}

@Controller('ops/creators')
export class OpsCreatorsController {
  constructor(private readonly creators: OpsCreatorsService) {}

  @Get()
  list(@CurrentUser() me: Me, @Query('archived') archived?: string) {
    return this.creators.list(me, archived === '1');
  }

  @Get('duplicates')
  duplicates(@CurrentUser() me: Me, @Query('phone') phone?: string, @Query('handle') handle?: string, @Query('email') email?: string, @Query('excludeId') excludeId?: string) {
    return this.creators.duplicates(me, { phone, handle, email, excludeId });
  }

  @Post()
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creators.create(me, body, ip);
  }

  @Get(':id')
  detail(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.creators.detail(me, id);
  }

  @Patch(':id')
  edit(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creators.edit(me, id, body, ip);
  }

  @Post('briefs/:briefId/rating')
  rate(@CurrentUser() me: Me, @Param('briefId') briefId: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creators.rate(me, briefId, body, ip);
  }
}

@Controller('ops')
export class OpsFilesController {
  constructor(private readonly files: OpsFilesService) {}

  @Get('files')
  list(@CurrentUser() me: Me, @Query('clientOrgId') clientOrgId?: string, @Query('engagementId') engagementId?: string, @Query('folder') folder?: string, @Query('archived') archived?: string, @Query('direction') direction?: string) {
    return this.files.list(me, { clientOrgId, engagementId, folder, archived, direction });
  }

  // v35: every file sent to and received from clients, for the Founder.
  @Get('files/client-feed')
  clientFeed(@CurrentUser() me: Me, @Query('days') days?: string) {
    return this.files.clientFeed(me, Number(days) || 7);
  }

  @Post('files')
  @UseInterceptors(opsUpload)
  upload(@CurrentUser() me: Me, @UploadedFile() file: OpsUpload | undefined, @Body() body: { clientOrgId?: string; engagementId?: string; folder?: string; tags?: string; name?: string; departmentId?: string }, @ClientIp() ip?: string) {
    return this.files.upload(me, file, body ?? {}, ip);
  }

  @Patch('files/:id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.files.update(me, id, body, ip);
  }

  @Post('files/:id/release')
  @HttpCode(200)
  release(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.files.release(me, id, ip);
  }

  @Get('files/:id/shares')
  shares(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.files.shares(me, id);
  }

  @Post('files/:id/shares')
  share(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.files.createShare(me, id, body, ip);
  }

  @Delete('shares/:id')
  revoke(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.files.revokeShare(me, id, ip);
  }

  @Post('uploads/proof')
  @UseInterceptors(opsUpload)
  proof(@CurrentUser() me: Me, @UploadedFile() file: OpsUpload | undefined, @ClientIp() ip?: string) {
    return this.files.proof(me, file, ip);
  }

  // Client portal ---------------------------------------------------------------

  @Get('client/files')
  clientList(@CurrentUser() me: Me) {
    return this.files.clientList(me);
  }

  @Post('client/files')
  @UseInterceptors(opsUpload)
  clientUpload(@CurrentUser() me: Me, @UploadedFile() file: OpsUpload | undefined, @Body() body: { engagementId?: string; requirementItemId?: string; tags?: string; note?: string }, @ClientIp() ip?: string) {
    return this.files.clientUpload(me, file, body ?? {}, ip);
  }

  // Public share page -------------------------------------------------------------

  @Public()
  @Get('public/share/:token')
  publicView(@Param('token') token: string) {
    return this.files.publicView(token);
  }

  @Public()
  @Post('public/share/:token/unlock')
  @HttpCode(200)
  unlock(@Param('token') token: string, @Body() body: { password?: string }, @ClientIp() ip?: string) {
    return this.files.unlock(token, typeof body?.password === 'string' ? body.password : undefined, ip);
  }

  @Public()
  @Get('public/share/:token/file')
  async publicFile(@Param('token') token: string, @Query('k') k: string | undefined, @Res() res: Response) {
    const f = await this.files.publicFile(token, k);
    return sendStoredFile(res, f, { disposition: 'attachment', cache: 'no-store' });
  }
}

@Controller('ops')
export class OpsCommsController {
  constructor(private readonly comms: OpsCommsService) {}

  @Get('threads')
  threads(@CurrentUser() me: Me, @Query('clientOrgId') clientOrgId?: string, @Query('kind') kind?: string) {
    return this.comms.threads(me, { clientOrgId, kind });
  }

  @Get('threads/options')
  threadOptions(@CurrentUser() me: Me) {
    return this.comms.options(me);
  }

  @Post('threads')
  createThread(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.comms.create(me, body, ip);
  }

  @Get('threads/:id')
  thread(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.comms.thread(me, id);
  }

  @Post('threads/:id/messages')
  post(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.comms.post(me, id, body, ip);
  }

  /** v38: a file to send with the next message in a discussion. */
  @Post('threads/:id/attachments')
  @UseInterceptors(opsUpload)
  attach(@CurrentUser() me: Me, @Param('id') id: string, @UploadedFile() file: OpsUpload | undefined, @ClientIp() ip?: string) {
    return this.comms.attach(me, id, file, ip);
  }

  @Post('messages/to-request')
  toRequest(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.comms.toRequest(me, body, ip);
  }

  @Get('announcements')
  announcements(@CurrentUser() me: Me) {
    return this.comms.announcements(me);
  }

  @Get('announcements/options')
  announcementOptions(@CurrentUser() me: Me) {
    return this.comms.announcementOptions(me);
  }

  @Post('announcements')
  announce(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.comms.announce(me, body, ip);
  }
}

@Controller('ops/admin')
export class OpsAdminController {
  constructor(private readonly admin: OpsAdminService) {}

  @Get('integrations')
  integrations(@CurrentUser() me: Me) {
    return this.admin.integrations(me);
  }

  @Post('integrations/:key/connect')
  @HttpCode(200)
  connect(@CurrentUser() me: Me, @Param('key') key: string, @ClientIp() ip?: string) {
    return this.admin.connect(me, key, ip);
  }

  @Post('integrations/:key/disconnect')
  @HttpCode(200)
  disconnect(@CurrentUser() me: Me, @Param('key') key: string, @Body() body: { reason?: string }, @ClientIp() ip?: string) {
    return this.admin.disconnect(me, key, body?.reason, ip);
  }

  @Get('clients/:clientOrgId/accounts')
  clientAccounts(@CurrentUser() me: Me, @Param('clientOrgId') clientOrgId: string) {
    return this.admin.clientAccounts(me, clientOrgId);
  }

  @Post('clients/:clientOrgId/accounts')
  connectClient(@CurrentUser() me: Me, @Param('clientOrgId') clientOrgId: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.admin.connectClientAccount(me, clientOrgId, body, ip);
  }

  @Post('accounts/:id/disconnect')
  @HttpCode(200)
  disconnectClient(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: { reason?: string }, @ClientIp() ip?: string) {
    return this.admin.disconnectClientAccount(me, id, body?.reason, ip);
  }
}
