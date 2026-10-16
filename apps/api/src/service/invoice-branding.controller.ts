// v27: signature and company seal for invoices (Founders upload; every signed-in person can see the images).
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { INVOICE_BRANDING_KINDS, type InvoiceBrandingKind, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { opsUpload, type OpsUpload } from '../ops-actions/ops-util.js';
import { InvoiceBrandingService } from './invoice-branding.service.js';
import { CmSigningService } from './cm-signing.service.js';
import { InvoiceSigningService } from './invoice-signing.service.js';

const kindOf = (k: string): InvoiceBrandingKind => {
  if (!(INVOICE_BRANDING_KINDS as readonly string[]).includes(k)) throw new BadRequestException('Use signature or seal');
  return k as InvoiceBrandingKind;
};

@Controller()
export class InvoiceBrandingController {
  constructor(
    private readonly branding: InvoiceBrandingService,
    private readonly signing: InvoiceSigningService,
    private readonly cm: CmSigningService,
  ) {}

  // v29: a Client Manager's own signature and signing password, and their clients' invoices.
  @Get('finance/my-signing')
  mySigning(@CurrentUser() me: Me) {
    return this.cm.view(me);
  }

  @Post('finance/my-signing/signature')
  @HttpCode(200)
  @UseInterceptors(opsUpload)
  mySignature(@CurrentUser() me: Me, @UploadedFile() file: OpsUpload | undefined, @ClientIp() ip?: string) {
    return this.cm.uploadSignature(me, file, ip);
  }

  @Delete('finance/my-signing/signature')
  removeMySignature(@CurrentUser() me: Me, @ClientIp() ip?: string) {
    return this.cm.removeSignature(me, ip);
  }

  @Put('finance/my-signing/password')
  mySigningPassword(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.cm.setPassword(me, body, ip);
  }

  @Get('finance/cm/invoices')
  cmInvoices(@CurrentUser() me: Me) {
    return this.cm.invoices(me);
  }

  @Get('finance/cm/invoices/:id/tax-invoice')
  cmTaxInvoice(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.cm.taxInvoice(me, id);
  }

  /** A signature or seal image printed on a signed invoice (declared before :kind). */
  @Get('invoice-branding/file/:fileId')
  signingFile(@CurrentUser() me: Me, @Param('fileId') fileId: string, @Res() res: Response) {
    return this.cm.file(me, fileId, res);
  }

  /** v28: add the seal and signature to an invoice with the signing password (a held invoice is then sent). */
  @Post('finance/invoices/:id/sign')
  @HttpCode(200)
  sign(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.signing.sign(me, id, body, ip);
  }

  @Get('finance/invoice-branding')
  view(@CurrentUser() me: Me) {
    return this.branding.view(me);
  }

  @Put('finance/invoice-branding')
  save(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.branding.save(me, body, ip);
  }

  // v28: the signing password and the "require signature" rule (declared before :kind so they are not read as a kind).
  @Put('finance/invoice-branding/password')
  password(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.branding.setPassword(me, body, ip);
  }

  @Put('finance/invoice-branding/rule')
  rule(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.branding.setRule(me, body, ip);
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
