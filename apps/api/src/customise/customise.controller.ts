import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { customFieldValuesSchema, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser, Public } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { CustomFieldsService } from './custom-fields.service.js';
import { FormsService } from './forms.service.js';
import { PipelinesService } from './pipelines.service.js';

/** v14 no-code customisation: custom fields, forms (and their public pages) and pipeline settings. */
@Controller()
export class CustomiseController {
  constructor(
    private readonly fields: CustomFieldsService,
    private readonly forms: FormsService,
    private readonly pipelines: PipelinesService,
  ) {}

  // Custom fields ----------------------------------------------------------
  @Get('custom-fields')
  listFields(@CurrentUser() me: Me, @Query('entity') entity?: string, @Query('archived') archived?: string) {
    return this.fields.list(me, entity, archived === '1');
  }

  @Post('custom-fields')
  createField(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.fields.create(me, body, ip);
  }

  @Patch('custom-fields/:id')
  updateField(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.fields.update(me, id, body, ip);
  }

  @Get('custom-fields/values/:entity/:id')
  values(@CurrentUser() me: Me, @Param('entity') entity: string, @Param('id') id: string) {
    return this.fields.values(me, entity, id);
  }

  @Put('custom-fields/values/:entity/:id')
  setValues(@CurrentUser() me: Me, @Param('entity') entity: string, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.fields.setValues(me, entity, id, parse(customFieldValuesSchema, body).values, ip);
  }

  // Forms ------------------------------------------------------------------
  @Get('forms')
  listForms(@CurrentUser() me: Me) {
    return this.forms.list(me);
  }

  @Post('forms')
  createForm(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.forms.create(me, body, ip);
  }

  @Get('forms/:id')
  getForm(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.forms.get(me, id);
  }

  @Put('forms/:id')
  updateForm(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.forms.update(me, id, body, ip);
  }

  @Delete('forms/:id')
  removeForm(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.forms.remove(me, id, ip);
  }

  @Get('forms/:id/submissions')
  submissions(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.forms.submissions(me, id);
  }

  @Public()
  @Get('public/forms/:slug')
  publicForm(@Param('slug') slug: string) {
    return this.forms.publicForm(slug);
  }

  @Public()
  @Post('public/forms/:slug/submit')
  @HttpCode(200)
  submit(@Param('slug') slug: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.forms.submit(slug, body, ip);
  }

  // Pipelines --------------------------------------------------------------
  @Get('pipelines')
  allPipelines(@CurrentUser() me: Me) {
    return this.pipelines.all(me);
  }

  @Put('pipelines/:kind')
  updatePipeline(@CurrentUser() me: Me, @Param('kind') kind: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.pipelines.update(me, kind, body, ip);
  }

  @Delete('pipelines/:kind')
  resetPipeline(@CurrentUser() me: Me, @Param('kind') kind: string, @ClientIp() ip?: string) {
    return this.pipelines.reset(me, kind, ip);
  }
}
