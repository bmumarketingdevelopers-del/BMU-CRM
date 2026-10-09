import { Injectable, Logger } from '@nestjs/common';

export type PaidInvoice = { id: string; kind: string; engagementId: string | null; requestId: string | null; orgId: string };
export type PaidHandler = (invoice: PaidInvoice) => Promise<void>;

/**
 * One place where "an invoice is now fully paid" is announced, whether the money came from Razorpay,
 * the dev test payment, a manual bank/UPI payment recorded by Finance, or a credit note settling the rest.
 * Listeners: add-on paid → work task, project balance paid → Gate 5, dunning stops by itself.
 */
@Injectable()
export class InvoiceEvents {
  private readonly log = new Logger('InvoiceEvents');
  private handlers: PaidHandler[] = [];

  onPaid(handler: PaidHandler) {
    this.handlers.push(handler);
  }

  async paid(invoice: PaidInvoice) {
    for (const h of this.handlers) {
      try {
        await h(invoice);
      } catch (e) {
        this.log.error(`Paid handler failed for invoice ${invoice.id}: ${(e as Error).message}`);
      }
    }
  }
}
