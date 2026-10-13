import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import {
  CRAFT_CHECKLIST_KINDS,
  craftBrandKitInputSchema,
  craftChecklistInputSchema,
  craftHookInputSchema,
  craftNudgeInputSchema,
  craftScriptInputSchema,
  type CraftChecklistKind,
  type Me,
} from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { ProductionService } from '../production/production.service.js';
import { storageRoot } from '../production/production.controller.js';
import { CraftService } from './craft.service.js';
import { putFile, relPathOf } from '../storage/file-store.js';

const brandUpload = FileInterceptor('file', {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      const dir = join(storageRoot(), new Date().toISOString().slice(0, 7));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase().slice(0, 10)}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

/** v10 craft: specialist dashboards (own, or read-only for leads) and the actions on them. Team accounts only. */
@Controller('craft')
export class CraftController {
  constructor(
    private readonly craft: CraftService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Get('dashboard')
  dashboard(@CurrentUser() me: Me, @Query('userId') userId?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.craft.dashboard(me, { userId, from, to });
  }

  /** Founder, Branch Manager, AM Lead (everyone) and Department Heads (their department). */
  @Get('specialists')
  specialists(@CurrentUser() me: Me) {
    return this.craft.specialists(me);
  }

  @Post('comments/:id/resolve')
  @HttpCode(200)
  resolve(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.craft.setResolved(me, id, true, ip);
  }

  @Post('comments/:id/reopen')
  @HttpCode(200)
  reopen(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.craft.setResolved(me, id, false, ip);
  }

  @Post('deliverables/:id/nudge')
  @HttpCode(200)
  nudge(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.craft.nudge(me, id, parse(craftNudgeInputSchema, body ?? {}).message, ip);
  }

  @Get('hooks')
  hooks(@CurrentUser() me: Me) {
    return this.craft.hooks(me);
  }

  @Post('hooks')
  saveHook(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.craft.saveHook(me, parse(craftHookInputSchema, body), ip);
  }

  @Post('hooks/:id/use')
  @HttpCode(200)
  useHook(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.craft.useHook(me, id);
  }

  @Delete('hooks/:id')
  deleteHook(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.craft.deleteHook(me, id, ip);
  }

  @Get('scripts')
  scripts(@CurrentUser() me: Me) {
    return this.craft.scripts(me);
  }

  @Post('scripts')
  createScript(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.craft.createScript(me, parse(craftScriptInputSchema, body), ip);
  }

  @Put('scripts/:id')
  saveScript(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    return this.craft.saveScript(me, id, parse(craftScriptInputSchema, body));
  }

  /** Writes the draft to a Markdown file and adds it as the next version of its deliverable (goes to QC). */
  @Post('scripts/:id/submit')
  @HttpCode(200)
  async submitScript(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    const s = await this.craft.scriptForSubmit(me, id);
    const root = storageRoot();
    const dir = join(root, new Date().toISOString().slice(0, 7));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${randomUUID()}.md`);
    const content = `# ${s.title}\n\n${s.body}\n`;
    writeFileSync(path, content, 'utf8');
    await putFile(relPathOf(path), path, 'text/markdown');
    const name = `${s.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'script'}.md`;
    const production = this.moduleRef.get(ProductionService, { strict: false });
    const detail = await production.addVersion(me, s.deliverableId!, { file: { path, originalname: name, mimetype: 'text/markdown', size: Buffer.byteLength(content) }, note: `Script: ${s.title}` }, root, ip);
    const v = detail.versions.at(-1);
    if (!v) throw new NotFoundException('Version not created');
    return this.craft.markScriptSubmitted(me, id, v.id);
  }

  @Put('checklists/:deliverableId/:kind')
  saveChecklist(@CurrentUser() me: Me, @Param('deliverableId') deliverableId: string, @Param('kind') kind: string, @Body() body: unknown, @ClientIp() ip?: string) {
    if (!(CRAFT_CHECKLIST_KINDS as readonly string[]).includes(kind)) throw new NotFoundException('Unknown checklist');
    return this.craft.saveChecklist(me, deliverableId, kind as CraftChecklistKind, parse(craftChecklistInputSchema, body), ip);
  }

  @Get('brand/:clientId')
  brand(@CurrentUser() me: Me, @Param('clientId') clientId: string) {
    return this.craft.brandKit(me, clientId);
  }

  @Put('brand/:clientId')
  saveBrand(@CurrentUser() me: Me, @Param('clientId') clientId: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.craft.saveBrandKit(me, clientId, parse(craftBrandKitInputSchema, body), ip);
  }

  @Post('brand/:clientId/files')
  @UseInterceptors(brandUpload)
  brandFile(@CurrentUser() me: Me, @Param('clientId') clientId: string, @UploadedFile() file: { path: string; originalname: string; mimetype: string; size: number } | undefined, @ClientIp() ip?: string) {
    return this.craft.addBrandFile(me, clientId, file, storageRoot(), ip);
  }
}
