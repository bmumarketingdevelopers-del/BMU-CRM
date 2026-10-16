// v27: the Founder's signature and the company seal on invoices (uploaded in Command Centre → Finance → GST & invoices).
import { z } from "zod";

export type InvoiceBrandingView = {
  signatoryName: string;
  designation: string;
  signature: { url: string; name: string; updatedAt: string } | null;
  seal: { url: string; name: string; updatedAt: string } | null;
  /** Only Founders change the signature and seal. */
  canEdit: boolean;
  /** v28: a signing password is set (its value is never sent anywhere). */
  passwordSet: boolean;
  /** v28: new invoices reach the client only after the seal and signature are added with the signing password. */
  requireSignature: boolean;
  /** When the rule was turned on: invoices created before it are not held. */
  requiredSince: string | null;
  /** v28: invoices waiting for the seal and signature before they go to the client (newest first). */
  waiting: { id: string; number: string; client: string; totalPaise: number; createdAt: string; kind: string }[];
};

/** v28: the Founder's signing password: needed to add the seal and signature to an invoice. */
export const invoiceSigningPasswordSchema = z
  .object({ password: z.string().min(8, "Use at least 8 characters").max(128), confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: "The two passwords do not match", path: ["confirm"] });
export const invoiceSigningRuleSchema = z.object({ requireSignature: z.boolean() });
export const invoiceSignSchema = z.object({ password: z.string().min(1, "Enter the signing password").max(128) });
export type InvoiceSignResult = { signed: true; number: string; delivered: boolean; message: string };

export const invoiceBrandingSchema = z.object({
  signatoryName: z.string().trim().max(120),
  designation: z.string().trim().max(80),
});
export type InvoiceBrandingInput = z.infer<typeof invoiceBrandingSchema>;

export const INVOICE_BRANDING_KINDS = ["signature", "seal"] as const;
export type InvoiceBrandingKind = (typeof INVOICE_BRANDING_KINDS)[number];

/** Signature and seal images: PNG (transparent background looks best), JPG or WebP, up to 2 MB. */
export const INVOICE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const INVOICE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
