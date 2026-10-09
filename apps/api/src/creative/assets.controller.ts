import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AssetQuery, Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { AssetsService } from './assets.service.js';

@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  list(@CurrentUser() me: Me, @Query() q: AssetQuery) {
    return this.assets.list(me, q);
  }

  @Get('collections')
  collections(@CurrentUser() me: Me) {
    return this.assets.collections(me);
  }

  @Post('collections')
  createCollection(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.assets.createCollection(me, body, ip);
  }

  @Patch('collections/:id')
  updateCollection(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.assets.updateCollection(me, id, body, ip);
  }

  @Delete('collections/:id')
  deleteCollection(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.assets.deleteCollection(me, id, ip);
  }

  @Post('link')
  addLink(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.assets.addLink(me, body, ip);
  }

  @Post('uploads')
  startUpload(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.assets.startUpload(me, body);
  }

  @Get('uploads/:id')
  uploadStatus(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.assets.uploadStatus(me, id);
  }

  /** One piece of a resumable upload, sent as the raw request body (application/octet-stream). */
  @Put('uploads/:id')
  uploadChunk(@CurrentUser() me: Me, @Param('id') id: string, @Query('offset') offset: string, @Req() req: Request) {
    return this.assets.uploadChunk(me, id, Number(offset), req);
  }

  @Post('uploads/:id/complete')
  @HttpCode(200)
  completeUpload(@CurrentUser() me: Me, @Param('id') id: string, @Req() req: { file?: { path: string; size: number } }, @ClientIp() ip?: string) {
    // req.file is set when the browser uploaded the whole file to Supabase Storage (storage/uploads.ts).
    return this.assets.completeUpload(me, id, ip, req.file);
  }

  @Delete('uploads/:id')
  cancelUpload(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.assets.cancelUpload(me, id);
  }

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.assets.get(me, id);
  }

  @Patch(':id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.assets.update(me, id, body, ip);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.assets.archive(me, id, true, ip);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.assets.archive(me, id, false, ip);
  }

  @Post(':id/versions/:versionId/current')
  @HttpCode(200)
  makeCurrent(@CurrentUser() me: Me, @Param('id') id: string, @Param('versionId') versionId: string, @ClientIp() ip?: string) {
    return this.assets.makeCurrent(me, id, versionId, ip);
  }

  @Post(':id/ai-tags')
  @HttpCode(200)
  aiTags(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.assets.aiTags(me, id);
  }
}

@Controller('client/assets')
export class ClientAssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  list(@CurrentUser() me: Me, @Query() q: AssetQuery) {
    return this.assets.clientList(me, q);
  }

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.assets.get(me, id);
  }
}
