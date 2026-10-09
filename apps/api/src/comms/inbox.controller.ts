import { createHmac, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Logger, Param, Patch, Post, Put, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { inboundEmailSchema, type InboxChannel, type InboxQuery, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser, Public } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { InboxService } from './inbox.service.js';

@Controller('inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  list(@CurrentUser() me: Me, @Query('status') status?: string, @Query('box') box?: string, @Query('channel') channel?: string, @Query('q') q?: string) {
    const query: InboxQuery = {
      status: status === 'closed' ? 'closed' : 'open',
      box: box === 'mine' || box === 'unassigned' ? box : undefined,
      channel: channel === 'whatsapp' || channel === 'email' ? (channel as InboxChannel) : undefined,
      q: q?.slice(0, 100),
    };
    return this.inbox.list(me, query);
  }

  @Get('templates')
  templates(@CurrentUser() me: Me) {
    return this.inbox.templates(me);
  }

  @Post('templates')
  createTemplate(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.inbox.saveTemplate(me, body, undefined, ip);
  }

  @Put('templates/:id')
  updateTemplate(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.inbox.saveTemplate(me, body, id, ip);
  }

  @Delete('templates/:id')
  deleteTemplate(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.inbox.deleteTemplate(me, id, ip);
  }

  @Post('simulate')
  simulate(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.inbox.simulate(me, body);
  }

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.inbox.get(me, id);
  }

  @Post(':id/reply')
  reply(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.inbox.reply(me, id, body, ip);
  }

  @Patch(':id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.inbox.update(me, id, body, ip);
  }

  @Post(':id/draft')
  draft(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.inbox.draft(me, id);
  }
}

type MetaWebhook = {
  entry?: {
    changes?: {
      value?: {
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: { from?: string; id?: string; type?: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string } } }[];
      };
    }[];
  }[];
};

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Incoming messages from Meta's WhatsApp Cloud API and from an email forwarding service. */
@Controller('webhooks')
export class CommsWebhooksController {
  private readonly log = new Logger('Webhooks');
  constructor(private readonly inbox: InboxService) {}

  /** Meta calls this once when you add the webhook, to check the verify token. */
  @Public()
  @Get('whatsapp')
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string, @Res() res: Response) {
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    if (mode === 'subscribe' && expected && token && safeEqual(token, expected)) return res.status(200).type('text/plain').send(String(challenge ?? ''));
    return res.status(403).send('Verify token does not match');
  }

  @Public()
  @Post('whatsapp')
  @HttpCode(200)
  async whatsapp(@Req() req: Request & { rawBody?: Buffer }, @Body() body: MetaWebhook, @Headers('x-hub-signature-256') signature?: string) {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (secret) {
      const raw = req.rawBody ?? Buffer.from(JSON.stringify(body ?? {}));
      const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
      if (!signature || !safeEqual(signature, expected)) throw new UnauthorizedException('Bad signature');
    } else if (process.env.NODE_ENV === 'production') {
      // Without the app secret anyone could post fake messages, so live servers refuse unsigned calls.
      throw new ForbiddenException('Set WHATSAPP_APP_SECRET to receive WhatsApp messages');
    }
    let received = 0;
    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {};
        for (const m of v.messages ?? []) {
          const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? (m.type ? `[${m.type} message]` : '');
          if (!m.from || !text) continue;
          const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? v.contacts?.[0]?.profile?.name ?? null;
          try {
            const r = await this.inbox.receive({ channel: 'whatsapp', from: m.from, name, body: text.slice(0, 8000), externalId: m.id ? `wa:${m.id}` : null });
            if (r) received++;
          } catch (e) {
            this.log.warn(`WhatsApp message not stored: ${(e as Error).message}`);
          }
        }
      }
    }
    return { ok: true, received };
  }

  /** Any email forwarding service (Mailgun routes, SendGrid inbound parse via a small relay, Zapier) can post here. */
  @Public()
  @Post('email')
  @HttpCode(200)
  async email(@Body() body: unknown, @Headers('x-bmu-webhook-secret') secret?: string) {
    const expected = process.env.INBOUND_EMAIL_SECRET;
    if (!expected) throw new ForbiddenException('Inbound email is not set up. Set INBOUND_EMAIL_SECRET in apps/api/.env');
    if (!secret || !safeEqual(secret, expected)) throw new UnauthorizedException('Bad secret');
    const input = parse(inboundEmailSchema, body);
    const r = await this.inbox.receive({ channel: 'email', from: input.from, name: input.fromName ?? null, subject: input.subject ?? null, body: input.text, externalId: input.messageId ? `em:${input.messageId}` : null });
    return { ok: true, received: r ? 1 : 0, conversationId: r?.conversationId ?? null };
  }
}
