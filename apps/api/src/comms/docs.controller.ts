import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { DocsService } from './docs.service.js';

/** v17 collaborative documents. Clients use the same open/edit/pull routes for documents shared with them. */
@Controller()
export class DocsController {
  constructor(private readonly docs: DocsService) {}

  @Get('docs')
  list(@CurrentUser() me: Me, @Query('engagementId') engagementId?: string, @Query('leadId') leadId?: string, @Query('clientOrgId') clientOrgId?: string) {
    return this.docs.list(me, { engagementId, leadId, clientOrgId });
  }

  @Post('docs')
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.docs.create(me, body, ip);
  }

  @Get('client/docs')
  clientList(@CurrentUser() me: Me) {
    return this.docs.clientList(me);
  }

  @Get('docs/:id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.docs.get(me, id);
  }

  @Patch('docs/:id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.docs.update(me, id, body, ip);
  }

  @Post('docs/:id/edit')
  @HttpCode(200)
  edit(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    return this.docs.edit(me, id, body);
  }

  @Post('docs/:id/pull')
  @HttpCode(200)
  pull(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    return this.docs.pull(me, id, body);
  }
}
