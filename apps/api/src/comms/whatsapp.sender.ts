// Sends WhatsApp text messages through the WhatsApp Business Cloud API when WHATSAPP_TOKEN and WHATSAPP_PHONE_ID are
// set. Without them nothing leaves the building: messages stay "queued" in Command Centre → Outbox → WhatsApp queue.
// Note: Meta only allows free text within 24 hours of the person's last message; outside that window it needs an
// approved template, so a reply can come back "failed" with Meta's reason.
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class WhatsAppSender {
  private readonly log = new Logger('WhatsApp');
  constructor(private readonly prisma: PrismaService) {}

  get live() {
    return !!process.env.WHATSAPP_TOKEN && !!process.env.WHATSAPP_PHONE_ID;
  }

  /** Queues the message (always kept for the record) and sends it when WhatsApp is connected. */
  async send(input: { orgId: string; toPhone: string; toName?: string | null; body: string; entity?: string; entityId?: string; source: string }) {
    const row = await this.prisma.whatsAppMessage.create({
      data: { orgId: input.orgId, toPhone: input.toPhone, toName: input.toName ?? null, body: input.body, entity: input.entity ?? null, entityId: input.entityId ?? null, source: input.source },
    });
    if (!this.live) return { id: row.id, status: 'queued' as const, error: null as string | null };
    const digits = input.toPhone.replace(/\D/g, '');
    const to = digits.length === 10 ? `91${digits}` : digits;
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: input.body.slice(0, 4096) } }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) throw new Error(data.error?.message ?? `WhatsApp said ${res.status}`);
      await this.prisma.whatsAppMessage.update({ where: { id: row.id }, data: { status: 'sent' } });
      return { id: row.id, status: 'sent' as const, error: null };
    } catch (e) {
      const error = (e as Error).message.slice(0, 300);
      this.log.warn(`Send failed: ${error}`);
      await this.prisma.whatsAppMessage.update({ where: { id: row.id }, data: { status: 'failed' } });
      return { id: row.id, status: 'failed' as const, error };
    }
  }
}
