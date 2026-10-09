import { z } from "zod";

// Validation shared by the website forms, the apps and the API.

export const indianPhone = z
  .string()
  .trim()
  .regex(/^(\+91)?[6-9]\d{9}$/, "Enter a valid Indian mobile number");

export const enquirySchema = z.object({
  name: z.string().trim().min(2, "Enter your name"),
  email: z.email("Enter a valid email"),
  phone: indianPhone,
  company: z.string().trim().optional(),
  need: z.string().trim().min(5, "Tell us a little about what you need"),
  budgetRupees: z.number().int().nonnegative().optional(),
  serviceIds: z.array(z.string()).default([]),
  /** v20 DPDP: optional extra consents (replying to the enquiry itself needs none beyond sending it). */
  consentMarketing: z.boolean().optional(),
  consentWhatsapp: z.boolean().optional(),
  /** v20 bot protection: a hidden field people never fill. */
  website: z.string().max(200).optional(),
});
export type EnquiryInput = z.infer<typeof enquirySchema>;

export const healthSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  time: z.string(),
  database: z.enum(["up", "down"]),
});
export type Health = z.infer<typeof healthSchema>;
