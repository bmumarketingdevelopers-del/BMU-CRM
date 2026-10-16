// v27: the Founder's signature and the company seal on invoices (uploaded in Command Centre → Finance → GST & invoices).
import { z } from "zod";

export type InvoiceBrandingView = {
  signatoryName: string;
  designation: string;
  signature: { url: string; name: string; updatedAt: string } | null;
  seal: { url: string; name: string; updatedAt: string } | null;
  /** Only Founders change the signature and seal. */
  canEdit: boolean;
};

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
