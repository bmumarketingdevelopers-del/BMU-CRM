import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Me } from '@bmu/shared';
import { ClientIp, CurrentUser, Public } from '../common/decorators.js';
import { sendStoredFile } from '../storage/file-store.js';
import { CreativeService } from './creative.service.js';
import { ProofingService } from './proofing.service.js';
import { sendClientPreview } from '../storage/client-preview.js';

@Controller('creative')
export class CreativeController {
  constructor(private readonly creative: CreativeService) {}

  @Get('brand-kits')
  brandKits(@CurrentUser() me: Me) {
    return this.creative.brandKits(me);
  }

  @Get('settings')
  settings(@CurrentUser() me: Me) {
    return this.creative.settings(me);
  }

  @Post('channels')
  addChannel(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creative.addChannel(me, body, ip);
  }

  @Delete('channels/:id')
  removeChannel(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.creative.removeChannel(me, id, ip);
  }

  @Put('clients/:id/publish-rule')
  publishRule(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creative.setPublishRule(me, id, body, ip);
  }

  @Put('posts/:id/caption')
  caption(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creative.setCaption(me, id, body, ip);
  }

  @Put('posts/:id/results')
  results(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creative.recordResults(me, id, body, ip);
  }

  @Post('posts/:id/approve')
  @HttpCode(200)
  approve(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.creative.approveInternally(me, id, ip);
  }

  @Get('results')
  summary(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.creative.results(me, from, to);
  }

  @Post('timers/run')
  @HttpCode(200)
  runTimers(@CurrentUser() me: Me) {
    return this.creative.runTimers(me);
  }
}

@Controller()
export class CreativeClientController {
  constructor(
    private readonly creative: CreativeService,
    private readonly proofing: ProofingService,
  ) {}

  @Get('client/brand-kit')
  brandKit(@CurrentUser() me: Me) {
    return this.creative.clientBrandKit(me);
  }

  @Get('client/post-results')
  results(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.creative.clientResults(me, from, to);
  }

  @Get('deliverables/:id/certificate')
  certificate(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.proofing.certificate(me, id);
  }

  @Get('client/reviews/:id/certificate')
  clientCertificate(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.proofing.clientCertificate(me, id);
  }

  // One-tap approval links (email / WhatsApp): the token is the only key, valid for one person and one version.

  @Public()
  @Get('public/proof/:token')
  proof(@Param('token') token: string) {
    return this.proofing.publicView(token);
  }

  @Public()
  @Post('public/proof/:token/decide')
  @HttpCode(200)
  decide(@Param('token') token: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.proofing.decide(token, body, ip);
  }

  @Public()
  @Get('public/proof/:token/file')
  async file(@Param('token') token: string, @Res() res: Response) {
    const f = await this.proofing.publicFile(token);
    if (f.kind === 'link') return res.redirect(f.path);
    // v37: a one-time project's work before the final payment: the watermarked preview, as in the client app.
    if (await this.proofing.needsPreview(f)) return sendClientPreview(res, f);
    return sendStoredFile(res, f, { cache: 'private, no-store' });
  }
}
