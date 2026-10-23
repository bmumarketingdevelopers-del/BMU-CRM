// Every email the system sends goes through here. With SMTP_* set in .env it is really sent with nodemailer;
// without it the email is only stored ("simulated") so Command Centre -> Outbox shows what would have gone out.
import { Injectable, Logger } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';
import nodemailer, { type Transporter } from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service.js';
import { isServerless } from '../runtime/process-role.js';
import { SettingsService } from '../settings/settings.service.js';

export type EmailInput = {
  orgId: string | null;
  to: string;
  toName?: string | null;
  toUserId?: string | null;
  subject: string;
  /** Short heading at the top of the email (defaults to the subject). */
  heading?: string;
  /** Plain paragraphs (escaped). */
  paragraphs?: string[];
  /** Extra trusted HTML (already escaped by the caller), e.g. a rendered tax invoice. */
  htmlBlock?: string;
  /** Plain-text version of htmlBlock. */
  textBlock?: string;
  button?: { label: string; url: string };
  kind: string;
  entity?: string;
  entityId?: string;
  /** v20: files to attach (scheduled report PDFs). */
  attachments?: { filename: string; contentType: string; base64: string }[];
};

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Web app address used in email links (APP_URL, else the first CORS origin). */
export function appUrl(path = '') {
  const base = (process.env.APP_URL || process.env.CORS_ORIGINS?.split(',')[0] || 'http://localhost:3000').trim().replace(/\/$/, '');
  if (!path) return base;
  if (/^https?:\/\//.test(path)) return path;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

@Injectable()
export class EmailService {
  private readonly log = new Logger('Email');
  private transporter: Transporter | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  get configured() {
    return !!process.env.SMTP_HOST;
  }

  get from() {
    return process.env.SMTP_FROM || process.env.SMTP_USER || 'BMU Hub <no-reply@bmumarketing.in>';
  }

  private transport() {
    if (!this.transporter) {
      const port = Number(process.env.SMTP_PORT || 587);
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
    }
    return this.transporter;
  }

  private async brand(orgId: string | null) {
    if (!orgId) return { name: 'BMU Marketing', color: '#121F2F', accent: '#8BB72C', support: 'hello@bmumarketing.in', app: 'BMU Hub' };
    const [tenant, branding] = await Promise.all([this.settings.get(orgId, 'tenant'), this.settings.get(orgId, 'branding')]);
    return { name: tenant.name, color: branding.primary, accent: branding.accent, support: tenant.supportEmail, app: branding.clientAppName || 'BMU Hub' };
  }

  /** Renders the email in the house style. Returns html + text. */
  async render(input: EmailInput) {
    const b = await this.brand(input.orgId);
    const heading = input.heading ?? input.subject;
    const paras = input.paragraphs ?? [];
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(input.subject)}</title></head>
<body style="margin:0;background:#f6f5f0;font-family:Arial,Helvetica,sans-serif;color:#121F2F">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f0;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e6e4dc">
<tr><td style="padding:20px 28px;border-bottom:3px solid ${b.accent};font-weight:bold;letter-spacing:.04em">${escapeHtml(b.name)}</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:${b.color}">${escapeHtml(heading)}</h1>
${paras.map((p) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n')}
${input.htmlBlock ?? ''}
${input.button ? `<p style="margin:24px 0 8px"><a href="${escapeHtml(appUrl(input.button.url))}" style="display:inline-block;background:${b.color};color:#ffffff;text-decoration:none;padding:12px 20px;font-size:14px;font-weight:bold">${escapeHtml(input.button.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e6e4dc;font-size:12px;color:#6b7280">Sent by ${escapeHtml(b.app)} for ${escapeHtml(b.name)}. Questions? Write to ${escapeHtml(b.support)}.</td></tr>
</table></td></tr></table></body></html>`;
    const text = [heading, '', ...paras, ...(input.textBlock ? ['', input.textBlock] : []), ...(input.button ? ['', `${input.button.label}: ${appUrl(input.button.url)}`] : []), '', `-- ${b.name}`].join('\n');
    return { html, text };
  }

  /** Stores the email in the outbox and sends it when SMTP is configured. Never throws. */
  async send(input: EmailInput): Promise<string | null> {
    try {
      const to = input.to.trim();
      if (!to || !to.includes('@')) return null;
      const { html, text } = await this.render(input);
      const row = await this.prisma.emailOutbox.create({
        data: {
          orgId: input.orgId,
          toEmail: to,
          toName: input.toName ?? null,
          toUserId: input.toUserId ?? null,
          subject: input.subject.slice(0, 300),
          text,
          html,
          kind: input.kind,
          status: this.configured ? 'sending' : 'simulated',
          entity: input.entity ?? null,
          entityId: input.entityId ?? null,
          attachments: input.attachments?.length ? (input.attachments as never) : undefined,
        },
      });
      if (this.configured) {
        const sending = this.deliver(row.id).catch((e) => this.log.warn(`Email ${row.id} not delivered: ${(e as Error).message}`));
        // On Vercel the function is frozen as soon as the answer is sent, which stalls an open SMTP connection
        // ("Greeting never received"); waitUntil keeps it running until the email has gone.
        if (isServerless()) waitUntil(sending);
      } else this.log.log(`(outbox) ${input.kind} → ${to}: ${input.subject}`);
      return row.id;
    } catch (e) {
      this.log.error(`Could not queue email: ${(e as Error).message}`);
      return null;
    }
  }

  /** Sends one outbox row over SMTP and records the result. */
  async deliver(id: string) {
    const row = await this.prisma.emailOutbox.findUnique({ where: { id } });
    if (!row) return;
    if (!this.configured) {
      await this.prisma.emailOutbox.update({ where: { id }, data: { status: 'simulated', error: null } });
      return;
    }
    try {
      await this.transport().sendMail({ from: this.from, to: row.toName ? `"${row.toName.replace(/"/g, '')}" <${row.toEmail}>` : row.toEmail, subject: row.subject, html: row.html, text: row.text, attachments: ((row.attachments ?? []) as { filename: string; contentType: string; base64: string }[]).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.base64, 'base64') })) });
      await this.prisma.emailOutbox.update({ where: { id }, data: { status: 'sent', sentAt: new Date(), error: null } });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      this.log.warn(`Email ${id} failed: ${msg}`);
      await this.prisma.emailOutbox.update({ where: { id }, data: { status: 'failed', error: msg } });
    }
  }
}
