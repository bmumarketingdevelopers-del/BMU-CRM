import { BadRequestException, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Razorpay orders + signature check. Without keys in .env the app offers a test payment instead. */
@Injectable()
export class PaymentsService {
  get keyId() {
    return process.env.RAZORPAY_KEY_ID || null;
  }

  get enabled() {
    return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  }

  /** Test payments are allowed only outside production and only when Razorpay isn't configured. */
  get testMode() {
    return process.env.NODE_ENV !== 'production' && !this.enabled;
  }

  async createOrder(amountPaise: number, receipt: string): Promise<{ id: string }> {
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: receipt.slice(0, 40) }),
    });
    if (!res.ok) throw new BadRequestException('Could not start the payment. Please try again.');
    return (await res.json()) as { id: string };
  }

  /** Amount actually paid on a Razorpay order (paise), or null when it can't be read. */
  async orderAmount(orderId: string): Promise<number | null> {
    if (!this.enabled) return null;
    try {
      const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
      const res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const o = (await res.json()) as { amount?: number; amount_paid?: number };
      return o.amount_paid || o.amount || null;
    } catch {
      return null;
    }
  }

  verifySignature(orderId: string, paymentId: string, signature: string): boolean {
    if (!process.env.RAZORPAY_KEY_SECRET || !signature) return false;
    const expected = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET ?? '').update(`${orderId}|${paymentId}`).digest('hex');
    return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }
}
