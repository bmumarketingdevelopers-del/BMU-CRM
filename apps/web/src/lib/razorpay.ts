"use client";

import type { Checkout } from "@bmu/shared";

export type RazorpayCheckout = Extract<Checkout, { mode: "razorpay" }>;
export type RazorpayResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
type RazorpayCtor = new (options: Record<string, unknown>) => { open: () => void };

const rz = () => (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;

function load(): Promise<void> {
  if (rz()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the payment window"));
    document.body.appendChild(s);
  });
}

/** Opens Razorpay Checkout and resolves once the server has verified the payment. */
export async function payWithRazorpay<T>(c: RazorpayCheckout, verify: (r: RazorpayResponse) => Promise<T>): Promise<T> {
  await load();
  return new Promise((resolve, reject) => {
    const Ctor = rz()!;
    new Ctor({
      key: c.keyId,
      order_id: c.orderId,
      amount: c.amountPaise,
      currency: "INR",
      name: "BMU Marketing",
      description: `Invoice ${c.invoiceNumber}`,
      prefill: c.prefill,
      theme: { color: "#121F2F" },
      handler: (r: RazorpayResponse) => verify(r).then(resolve, reject),
      modal: { ondismiss: () => reject(new Error("Payment was cancelled")) },
    }).open();
  });
}
