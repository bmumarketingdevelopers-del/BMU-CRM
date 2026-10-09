import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpException, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { aiAskSchema, aiGenerateSchema, type AiResult, type AiStreamEvent, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { AiCopilotService } from './ai-copilot.js';
import { AiDigestService } from './ai-digest.js';
import { AiFeaturesService } from './ai-features.js';
import { AiService } from './ai.service.js';

/** v10 AI Copilot. Every endpoint checks the org switch, the feature switch and the signed-in person's scope. */
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly copilot: AiCopilotService,
    private readonly features: AiFeaturesService,
    private readonly digests: AiDigestService,
  ) {}

  @Get('status')
  status(@CurrentUser() me: Me) {
    return this.ai.status(me);
  }

  // ---------------------------------------------------------------- drafting features

  @Post('generate')
  @HttpCode(200)
  generate(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.features.generate(me, parse(aiGenerateSchema, body));
  }

  @Post('generate/stream')
  async generateStream(@CurrentUser() me: Me, @Body() body: unknown, @Res() res: Response) {
    const input = parse(aiGenerateSchema, body);
    if (me.type !== 'staff') throw new ForbiddenException('AI drafting is for the BMU team');
    await this.ai.assertOn({ orgId: me.orgId, userId: me.id, me }, input.feature);
    return this.stream(res, (emit) => this.features.generate(me, input, emit));
  }

  // ---------------------------------------------------------------- Ask BMU

  private staffOnly(me: Me) {
    if (me.type !== 'staff') throw new ForbiddenException('Ask BMU is for the BMU team');
  }

  private clientOnly(me: Me) {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('This assistant is for client accounts');
  }

  @Post('ask')
  @HttpCode(200)
  ask(@CurrentUser() me: Me, @Body() body: unknown) {
    this.staffOnly(me);
    return this.copilot.ask(me, parse(aiAskSchema, body));
  }

  @Post('ask/stream')
  async askStream(@CurrentUser() me: Me, @Body() body: unknown, @Res() res: Response) {
    this.staffOnly(me);
    const input = parse(aiAskSchema, body);
    await this.ai.assertOn({ orgId: me.orgId, userId: me.id, me }, 'copilot');
    return this.stream(res, (emit) => this.copilot.ask(me, input, emit));
  }

  @Post('client/ask')
  @HttpCode(200)
  clientAsk(@CurrentUser() me: Me, @Body() body: unknown) {
    this.clientOnly(me);
    return this.copilot.ask(me, parse(aiAskSchema, body));
  }

  @Post('client/ask/stream')
  async clientAskStream(@CurrentUser() me: Me, @Body() body: unknown, @Res() res: Response) {
    this.clientOnly(me);
    const input = parse(aiAskSchema, body);
    await this.ai.assertOn({ orgId: me.orgId, userId: me.id, me }, 'client_ask');
    return this.stream(res, (emit) => this.copilot.ask(me, input, emit));
  }

  @Get('conversations')
  conversations(@CurrentUser() me: Me) {
    return this.copilot.conversations(me);
  }

  @Get('conversations/:id')
  conversation(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.copilot.conversation(me, id);
  }

  @Delete('conversations/:id')
  removeConversation(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.copilot.remove(me, id);
  }

  // ---------------------------------------------------------------- weekly digest

  @Get('digest')
  digest(@CurrentUser() me: Me) {
    return this.digests.latest(me);
  }

  @Post('digest')
  @HttpCode(200)
  makeDigest(@CurrentUser() me: Me) {
    return this.digests.make(me);
  }

  // ---------------------------------------------------------------- Command Centre → AI Copilot

  @Get('usage')
  usage(@CurrentUser() me: Me) {
    return this.ai.usage(me);
  }

  @Put('settings')
  saveSettings(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.ai.saveSettings(me, body, ip);
  }

  /** Newline-delimited JSON events: delta / status while working, then done (or error in plain words). */
  private async stream(res: Response, work: (emit: (e: AiStreamEvent) => void) => Promise<AiResult>) {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const emit = (e: AiStreamEvent) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(e)}\n`);
    };
    try {
      emit({ t: 'done', result: await work(emit) });
    } catch (e) {
      emit({ t: 'error', message: e instanceof HttpException ? e.message : 'Something went wrong. Please try again.' });
    }
    res.end();
  }
}
