import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from '../service/email.service.js';

/**
 * Delivers sign-in codes. Email addresses get the code by email (through the outbox: really sent when SMTP_* is
 * set, otherwise stored and visible as "not sent" in Command Centre -> Outbox). Development also prints the code
 * and shows it on screen. Mobile numbers will use SMS/WhatsApp (MSG91 / WhatsApp Business API) later.
 */
@Injectable()
export class OtpSender {
  private readonly log = new Logger('OTP');

  constructor(
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
  ) {}

  async send(identifier: string, code: string): Promise<void> {
    // OTP_LOG=1 on a live server prints codes to the log for the very first sign-in before email is set up.
    if (process.env.NODE_ENV !== 'production' || process.env.OTP_LOG === '1') this.log.log(`Sign-in code for ${identifier}: ${code}`);
    if (!identifier.includes('@')) return;
    const user = await this.prisma.user.findFirst({ where: { email: identifier, deletedAt: null }, select: { id: true, name: true, orgId: true } });
    await this.email.send({
      orgId: user?.orgId ?? null,
      to: identifier,
      toName: user?.name ?? null,
      toUserId: user?.id ?? null,
      kind: 'otp',
      subject: `Your BMU Hub sign-in code: ${code}`,
      heading: 'Your sign-in code',
      paragraphs: [`Hi${user ? ` ${user.name.split(' ')[0]}` : ''}, use this code to sign in to BMU Hub:`, code, 'It works for 10 minutes. If you did not ask for it, you can ignore this email.'],
    });
  }
}
