// v27: signature and company seal for invoices (Founders upload; every signed-in person can see the images).
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { INVOICE_BRANDING_KINDS, type InvoiceBrandingKind, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { opsUpload, type OpsUpload } from '../ops-actions/ops-util.js';
import { InvoiceBrandingService } from './invoice-branding.service.js';

const kindOf = (k: string): InvoiceBrandingKind => {
  if (!(INVOICE_BRANDING_KINDS as readonly string[]).includes(k)) throw new BadRequestException('Use signature or seal');
  return k as InvoiceBrandingKind;
};

@Controller()
export class InvoiceBrandingController {
  constructor(private readonly branding: InvoiceBrandingService) {}

  @Get('finance/invoice-branding')
  view(@CurrentUser() me: Me) {
    return this.branding.view(me);
  }

  @Put('finance/invoice-branding')
  save(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.branding.save(me, body, ip);
  }

  @Post('finance/invoice-branding/:kind')
  @HttpCode(200)
  @UseInterceptors(opsUpload)
  upload(@CurrentUser() me: Me, @Param('kind') kind: string, @UploadedFile() file: OpsUpload | undefined, @ClientIp() ip?: string) {
    return this.branding.upload(me, kindOf(kind), file, ip);
  }

  @Delete('finance/invoice-branding/:kind')
  remove(@CurrentUser() me: Me, @Param('kind') kind: string, @ClientIp() ip?: string) {
    return this.branding.remove(me, kindOf(kind), ip);
  }

  @Get('invoice-branding/:kind')
  image(@CurrentUser() me: Me, @Param('kind') kind: string, @Res() res: Response) {
    return this.branding.image(me, kindOf(kind), res);
  }
}
