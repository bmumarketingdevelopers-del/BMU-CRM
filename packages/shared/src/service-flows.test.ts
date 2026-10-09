import { describe, expect, it } from "vitest";
import { SERVICE_GSTIN_RE, serviceAmountInWords, serviceGstStateName, serviceNoticeGroup, serviceRateRequestSchema } from "./index.js";

describe("service flows", () => {
  it("writes amounts in words the Indian way", () => {
    expect(serviceAmountInWords(12345678)).toBe("Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only");
    expect(serviceAmountInWords(100050)).toBe("Rupees One Thousand and Fifty Paise Only");
  });
  it("checks GSTINs and names states", () => {
    expect(SERVICE_GSTIN_RE.test("29AAKCS1234M1Z5")).toBe(true);
    expect(SERVICE_GSTIN_RE.test("29AAKCS1234")).toBe(false);
    expect(serviceGstStateName("30")).toBe("Goa");
  });
  it("groups notification kinds for preferences", () => {
    expect(serviceNoticeGroup("quote_declined")).toBe("quote_decision");
    expect(serviceNoticeGroup("request_client_reply")).toBe("request_created");
    expect(serviceNoticeGroup("something_new")).toBe("something_new");
  });
  it("accepts only thumbs up or down", () => {
    expect(serviceRateRequestSchema.safeParse({ rating: "up" }).success).toBe(true);
    expect(serviceRateRequestSchema.safeParse({ rating: 5 }).success).toBe(false);
  });
});
