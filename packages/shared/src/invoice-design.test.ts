// v27: which invoice design applies, and the plain invoice wording used when AI is off.
import { describe, expect, it } from "vitest";
import { opsBasicLineText, serviceInvoiceVariant } from "./index.js";

const base = { status: "issued", kind: "retainer", dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString(), paidPaise: 0, creditedPaise: 0, balancePaise: 100_00 };

describe("invoice design", () => {
  it("picks the design from status, kind, payments and credit notes", () => {
    expect(serviceInvoiceVariant(base)).toBe("due");
    expect(serviceInvoiceVariant({ ...base, kind: "first_payment" })).toBe("new_subscription");
    expect(serviceInvoiceVariant({ ...base, dueDate: new Date(Date.now() - 3 * 86_400_000).toISOString() })).toBe("overdue");
    expect(serviceInvoiceVariant({ ...base, status: "overdue" })).toBe("overdue");
    expect(serviceInvoiceVariant({ ...base, status: "partially_paid", paidPaise: 40_00, balancePaise: 60_00 })).toBe("part_paid");
    expect(serviceInvoiceVariant({ ...base, status: "paid", paidPaise: 100_00, balancePaise: 0 })).toBe("paid");
    expect(serviceInvoiceVariant({ ...base, status: "credit_noted", creditedPaise: 100_00, balancePaise: 0 })).toBe("credited");
    expect(serviceInvoiceVariant({ ...base, status: "draft" })).toBe("draft");
    expect(serviceInvoiceVariant({ ...base, status: "void" })).toBe("cancelled");
    // A first invoice that is overdue shows as overdue, and once paid as paid.
    expect(serviceInvoiceVariant({ ...base, kind: "first_payment", status: "overdue" })).toBe("overdue");
    expect(serviceInvoiceVariant({ ...base, kind: "first_payment", status: "paid", paidPaise: 100_00, balancePaise: 0 })).toBe("paid");
  });

  it("writes plain wording from a short description when AI is off", () => {
    expect(opsBasicLineText("  website   redesign ", "service", "Poorva Clothings")).toEqual({ title: "Website redesign", details: "Professional website redesign services delivered by BMU Marketing for Poorva Clothings, as agreed." });
    expect(opsBasicLineText("meta ads october", "ad_spend").details).toMatch(/at cost without GST/);
  });
});
