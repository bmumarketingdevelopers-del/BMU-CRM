import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Me } from '@bmu/shared';
import { ClientIp, CurrentUser, Public } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { sendStoredFile } from '../storage/file-store.js';
import { ApiKeysService } from './api-keys.service.js';
import { verifyToken } from './crypto.js';
import { IntegrationsService } from './integrations.service.js';
import { MetricsSyncService } from './metrics-sync.service.js';
import { PublisherService } from './publisher.service.js';
import { WebhooksService } from './webhooks.service.js';

@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly hub: IntegrationsService,
    private readonly publisher: PublisherService,
    private readonly metrics: MetricsSyncService,
  ) {}

  @Get()
  view(@CurrentUser() me: Me) {
    return this.hub.hub(me);
  }

  @Post('test-accounts')
  addTest(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.hub.addTest(me, body, ip);
  }

  @Post('oauth/start')
  oauthStart(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.hub.oauthStart(me, body);
  }

  @Public()
  @Get('oauth/callback')
  async oauthCallback(@Query() q: { code?: string; state?: string; error?: string; error_description?: string }, @Res() res: Response) {
    res.redirect(await this.hub.oauthCallback(q));
  }

  @Patch('accounts/:id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.hub.updateAccount(me, id, body, ip);
  }

  @Post('accounts/:id/disconnect')
  disconnect(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.hub.disconnect(me, id, ip);
  }

  @Post('accounts/:id/sync')
  async sync(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.metrics.syncAccount(await this.hub.account(me, id));
  }

  @Get('jobs')
  jobs(@CurrentUser() me: Me, @Query('accountId') accountId?: string) {
    return this.hub.jobs(me, accountId);
  }

  @Post('publish/:deliverableId')
  publishNow(@CurrentUser() me: Me, @Param('deliverableId') id: string, @ClientIp() ip?: string) {
    return this.publisher.publishNow(me, id, ip);
  }

  @Post('publications/:id/retry')
  retry(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.publisher.retry(me, id, ip);
  }

  @Get('publications/by-post/:deliverableId')
  byPost(@CurrentUser() me: Me, @Param('deliverableId') id: string) {
    return this.publisher.byPost(me, id);
  }

  @Get('results')
  results(@CurrentUser() me: Me, @Query('clientOrgId') clientOrgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.hub.results(me, clientOrgId, from, to);
  }
}

@Controller('client')
export class ClientAdResultsController {
  constructor(private readonly hub: IntegrationsService) {}

  @Get('ad-results')
  results(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.hub.clientResults(me, from, to);
  }
}

/** No sign-in: signed media links for Instagram/Facebook to fetch, and the test account's post page. */
@Controller('public')
export class PublicIntegrationsController {
  constructor(
    private readonly hub: IntegrationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get('media/:token')
  async media(@Param('token') token: string, @Res() res: Response) {
    const t = verifyToken<{ f: string }>(token);
    const file = t ? await this.prisma.file.findUnique({ where: { id: t.f } }) : null;
    if (!file) return res.status(404).json({ message: 'Link expired' });
    if (file.kind === 'link') return res.redirect(file.path);
    return sendStoredFile(res, file, { cache: 'public, max-age=3600' });
  }

  @Public()
  @Get('test-posts/:externalId')
  testPost(@Param('externalId') id: string) {
    return this.hub.testPost(id);
  }
}

@Controller('developer')
export class DeveloperController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly webhooks: WebhooksService,
  ) {}

  @Get('keys')
  listKeys(@CurrentUser() me: Me) {
    return this.keys.list(me);
  }

  @Post('keys')
  createKey(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.keys.create(me, body, ip);
  }

  @Post('keys/:id/revoke')
  revokeKey(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.keys.revoke(me, id, ip);
  }

  @Get('webhooks')
  listWebhooks(@CurrentUser() me: Me) {
    return this.webhooks.list(me);
  }

  @Post('webhooks')
  createWebhook(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.webhooks.create(me, body, ip);
  }

  @Patch('webhooks/:id')
  updateWebhook(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.webhooks.update(me, id, body, ip);
  }

  @Delete('webhooks/:id')
  deleteWebhook(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.webhooks.remove(me, id, ip);
  }

  @Post('webhooks/:id/rotate')
  rotate(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.webhooks.rotate(me, id, ip);
  }

  @Post('webhooks/:id/test')
  test(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.webhooks.test(me, id);
  }

  @Get('webhooks/:id/deliveries')
  deliveries(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.webhooks.deliveries(me, id);
  }

  @Post('deliveries/:id/redeliver')
  redeliver(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.webhooks.redeliver(me, id);
  }
}
