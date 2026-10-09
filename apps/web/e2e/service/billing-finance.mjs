// Journey: billing and finance. Client billing page + billing details + printable GST tax invoice + Pay now;
// Finance records a part payment by UPI with a reference, settles the rest with a credit note (the paid
// extra request then turns into a work task), emails the invoice (Outbox), GST summary + CSV downloads,
// Collections reminders + promise to pay, and the monthly Billing run with duplicate protection.
import { BASE, apiCall, browser, check, done, shot, signIn, sleep } from "./lib.mjs";

const stamp = Date.now().toString().slice(-6);
const b = await browser();
const client = await signIn(b, "client@sunrise.demo");
const am = await signIn(b, "am@bmu.demo");
const finance = await signIn(b, "finance@bmu.demo");
const admin = await signIn(b, "admin@bmu.demo");

console.log("Client billing page and billing details");
await client.goto(`${BASE}/client/billing`);
await client.getByText("To pay now").waitFor();
check((await client.locator("table tbody tr").count()) > 0, "client sees their invoices");
await client.getByRole("button", { name: "Edit" }).last().click();
await client.getByTestId("billing-details-form").waitFor();
await client.getByPlaceholder("29ABCDE1234F1Z5").fill("29abc");
await client.getByRole("button", { name: "Save details" }).click();
await client.getByText(/GSTIN does not look right/).waitFor();
check(true, "bad GSTIN is refused in plain words");
await client.getByPlaceholder("29ABCDE1234F1Z5").fill("29AAKCS1234M1Z5");
await client.getByRole("button", { name: "Save details" }).click();
await client.getByText("Saved. New invoices will show these details.").waitFor();
check(true, "client owner saved GSTIN");
const approver = await signIn(b, "approver@sunrise.demo");
const apprBilling = await apiCall(approver, "GET", "/service/client/billing");
if (apprBilling.status === 200) check(apprBilling.json.details.canEdit === false, "approver cannot edit billing details");
else check(apprBilling.status === 403, "approver has no billing access");
const apprSave = await apiCall(approver, "PUT", "/service/client/billing-details", { legalName: "Hack" });
check(apprSave.status === 403, "API refuses billing-detail changes from the approver");

console.log("New extra request → invoice issued → email with the tax invoice");
const eng = (await apiCall(client, "GET", "/client/overview")).json.engagements[0].id;
const req = (await apiCall(client, "POST", "/client/requests", { engagementId: eng, type: "new_scope", description: `[e2e ${stamp}] 4 extra reels for Diwali` })).json;
const addOns = (await apiCall(am, "GET", "/requests/add-ons")).json.filter((a) => a.pricePaise);
await apiCall(am, "POST", `/requests/${req.id}/decide`, { action: "quote", addOnId: addOns[0].id, quantity: 2, timeline: "5 working days" });
const approved = (await apiCall(client, "POST", `/client/requests/${req.id}/approve-quote`)).json;
const invId = approved.invoice.id;
check(approved.status === "approved" && approved.invoice.status === "issued", `invoice ${approved.invoice.number} issued on approval`);

await client.goto(`${BASE}/client/billing/${invId}`);
await client.getByTestId("tax-invoice").waitFor();
const tax = await client.getByTestId("tax-invoice").innerText();
check(/TAX INVOICE/.test(tax) && /CGST 9%/.test(tax) && /SGST 9%/.test(tax), "Karnataka client: CGST 9% + SGST 9%");
check(/Rupees .+ Only/.test(tax), "amount in words in the Indian format");
check(tax.includes("29AAKCS1234M1Z5"), "client GSTIN printed on the invoice");
check(/SAC/.test(tax), "SAC code printed");
check((await client.getByRole("button", { name: "Download PDF" }).count()) === 1, "Download PDF button present");
await shot(client, "billing-tax-invoice");

console.log("Finance: part payment by UPI, then a credit note settles the rest");
await finance.goto(`${BASE}/admin/finance/invoices/${invId}`);
await finance.getByText("Record a payment").first().waitFor().catch(() => {});
const detail = (await apiCall(finance, "GET", `/finance/invoices/${invId}`)).json;
const part = Math.round(detail.balancePaise / 2);
const pay = await apiCall(finance, "POST", `/finance/invoices/${invId}/payments`, { amountPaise: part, method: "upi", ref: `UPI-${stamp}` });
check(pay.status === 200 && pay.json.status === "partially_paid", `part payment recorded (${pay.json.status})`);
const dup = await apiCall(finance, "POST", `/finance/invoices/${invId}/payments`, { amountPaise: part, method: "upi", ref: `UPI-${stamp}` });
check(dup.json.paidPaise === part, "same reference twice is not double counted");
const tooMuch = await apiCall(finance, "POST", `/finance/invoices/${invId}/payments`, { amountPaise: detail.totalPaise, method: "bank", ref: `NEFT-${stamp}` });
check(tooMuch.status === 400 && /more than the balance/.test(tooMuch.json.message), "overpayment refused in plain words");
const clientBill = (await apiCall(client, "GET", "/service/client/billing")).json.invoices.find((i) => i.id === invId);
check(clientBill.status === "partially_paid" && clientBill.balancePaise === detail.totalPaise - part, "client billing shows the part payment and the balance");
const checkout = await apiCall(client, "POST", `/client/invoices/${invId}/checkout`);
check(checkout.json.mode === "test" || checkout.json.mode === "razorpay", `checkout works for a part-paid invoice (${checkout.json.mode})`);
const left = detail.totalPaise - part;
const net = Math.floor((left * 100) / 118);
const cn = await apiCall(finance, "POST", "/finance/credit-notes", { invoiceId: invId, amountPaise: net, reason: `Goodwill discount [${stamp}]` });
// v11: a credit note raised by Finance waits for an Admin's approval.
check(cn.status === 201 && (cn.json.number || cn.json.approvalId), `credit note ${cn.json.number ?? "sent for approval"}`);
if (cn.json.approvalId) {
  const ok = await apiCall(admin, "POST", `/actions/approvals/${cn.json.approvalId}/decide`, { decision: "approve" });
  check(ok.status < 300, `admin approves the credit note (${ok.status})`);
}
const afterCn = (await apiCall(finance, "GET", `/finance/invoices/${invId}`)).json;
check(afterCn.balancePaise <= 1, `balance after credit note: ${afterCn.balancePaise} paise`);
if (afterCn.balancePaise > 0) await apiCall(finance, "POST", `/finance/invoices/${invId}/payments`, { amountPaise: afterCn.balancePaise, method: "upi", ref: `UPI-R-${stamp}` });
const reqAfter = (await apiCall(client, "GET", `/client/requests/${req.id}`)).json;
check(reqAfter.status === "paid", `manual payment moved the extra request to paid (${reqAfter.status})`);
const amTasks = await apiCall(am, "GET", "/tasks?scope=mine");
check(JSON.stringify(amTasks.json).includes(`[e2e ${stamp}] 4 extra reels`), "work task created after the manual payment");

console.log("Finance: tax invoice page, email to client, Outbox");
await finance.goto(`${BASE}/admin/finance/invoices/${invId}`);
await finance.getByRole("link", { name: "Tax invoice / PDF" }).click();
await finance.getByTestId("tax-invoice").waitFor();
await finance.getByTestId("tax-invoice").getByText(/received against this invoice/i).waitFor({ timeout: 20000 }).catch(() => {});
check(/received against this invoice/i.test(await finance.getByTestId("tax-invoice").innerText()), "finance tax invoice lists payments and credit notes");
await finance.goBack();
await finance.getByRole("button", { name: "Email to client" }).click();
await finance.getByText(/Sent to \d+/).waitFor();
check(true, "invoice emailed to the client");
await admin.goto(`${BASE}/admin/outbox`);
await admin.getByText("Emails", { exact: true }).first().waitFor();
const ob = (await apiCall(admin, "GET", "/service/outbox")).json;
const invMail = ob.rows.find((r) => r.entityId === invId && r.kind === "invoice_issued");
check(!!invMail, `Outbox has the invoice email (${invMail?.subject})`);
check(ob.rows.some((r) => r.kind === "otp" && r.subject.includes("••••••")), "sign-in codes are in the Outbox, masked");
await admin.getByRole("button", { name: invMail.subject }).first().click();
await admin.getByTestId("outbox-preview").waitFor();
const frameText = await admin.frameLocator("[data-testid=outbox-preview]").locator("body").innerText();
check(/Tax invoice/i.test(frameText) && /CGST/.test(frameText), "email body shows the tax invoice");
const fOut = await apiCall(finance, "GET", "/service/outbox");
check(fOut.status === 403, "Finance cannot open the Outbox (Founder/Admin only)");
await shot(admin, "outbox");

console.log("GST summary and CSV downloads");
await finance.goto(`${BASE}/admin/finance/gst`);
await finance.getByText(/GST settings/).first().waitFor();
const gstCsv = await finance.evaluate(async () => {
  const r = await fetch("/api/finance/gst.csv");
  return { status: r.status, type: r.headers.get("content-type"), disp: r.headers.get("content-disposition"), body: (await r.text()).slice(0, 200) };
});
check(gstCsv.status === 200 && gstCsv.type.includes("text/csv") && gstCsv.disp.includes("attachment") && gstCsv.body.includes("Invoice number"), "GST CSV downloads as a file");
const today = new Date().toISOString().slice(0, 10);
const acc = await finance.evaluate(async (t) => {
  const r = await fetch(`/api/finance/export.csv?from=2026-04-01&to=${t}`);
  return { status: r.status, type: r.headers.get("content-type"), body: (await r.text()).slice(0, 300) };
}, today);
check(acc.status === 200 && acc.type.includes("text/csv") && acc.body.includes("Voucher type"), "accounting export CSV downloads");
await finance.goto(`${BASE}/admin/finance/accounting`);
const dlLinks = await finance.locator('a[href*=".csv"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
check(dlLinks.every((h) => h.startsWith("/api/")), `accounting page download links go through /api (${dlLinks.join(", ") || "form based"})`);

console.log("Collections: reminder, promise to pay, automatic reminders");
await finance.goto(`${BASE}/admin/collections`);
await finance.getByText("Automatic payment reminders").waitFor();
const coll = (await apiCall(finance, "GET", "/insights/collections")).json;
const target = coll.unpaid.find((u) => u.clientId && u.daysOverdue > 0) ?? coll.unpaid.find((u) => u.clientId);
if (target) {
  const r = await apiCall(finance, "POST", `/service/finance/invoices/${target.id}/remind`);
  check(r.status === 200 && r.json.notified > 0, `manual reminder sent for ${target.number}`);
  const promiseDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const p = await apiCall(finance, "POST", `/service/finance/invoices/${target.id}/promise`, { promisedFor: promiseDate, note: `Phone call [${stamp}]` });
  check(p.status === 200 && p.json.rows.find((x) => x.invoiceId === target.id)?.promise?.promisedFor === promiseDate, "promise to pay logged");
  const past = await apiCall(finance, "POST", `/service/finance/invoices/${target.id}/promise`, { promisedFor: "2020-01-01" });
  check(past.status === 400, "a promise date in the past is refused");
}
await finance.reload();
await finance.getByRole("button", { name: "Check and send now" }).click();
await finance.locator("text=/Sent \\d+ reminder|Checked \\d+ overdue|nothing new|switched off/").first().waitFor();
check(true, "automatic reminders run from the page");
check((await finance.locator("text=/By \\d|Broken/").count()) > 0, "Collections shows promise-to-pay dates");
await shot(finance, "collections");

console.log("Billing run: preview, issue selected, no duplicates");
await finance.goto(`${BASE}/admin/finance/billing-run`);
await finance.getByText(/Active retainers/).waitFor();
const prev = (await apiCall(finance, "GET", "/service/finance/billing-run")).json;
check(prev.lines.length > 0, `preview lists ${prev.lines.length} active retainers (${prev.readyCount} ready)`);
check(prev.lines.every((l) => l.status !== "ready" || l.totalPaise > 0), "every ready line has an amount");
const ready = prev.lines.filter((l) => l.status === "ready");
if (ready.length) {
  const first = ready[0];
  const res = await apiCall(finance, "POST", "/service/finance/billing-run", { period: prev.period, engagementIds: [first.engagementId] });
  check(res.status === 200 && res.json.issued.length === 1, `issued ${res.json.issued[0]?.number} for ${first.client}`);
  const again = await apiCall(finance, "POST", "/service/finance/billing-run", { period: prev.period, engagementIds: [first.engagementId] });
  check(again.json.issued.length === 0 && again.json.skipped[0]?.reason.startsWith("Already billed"), "issuing the same retainer twice is skipped");
  const prev2 = (await apiCall(finance, "GET", "/service/finance/billing-run")).json;
  check(prev2.lines.find((l) => l.engagementId === first.engagementId)?.status === "already_issued", "preview now shows it as already billed");
  const runs = (await apiCall(finance, "GET", "/service/finance/billing-runs")).json;
  check(runs[0]?.issuedCount === 0 && runs[1]?.issuedCount === 1, "both runs are in the log");
} else check(true, "nothing ready to bill this month (all already billed)");
const amRun = await apiCall(am, "GET", "/service/finance/billing-run");
check(amRun.status === 403, "Account Managers cannot open the billing run");
await finance.reload();
await finance.getByText(/Active retainers/).waitFor();
await shot(finance, "billing-run");

console.log("Phone width");
for (const [p, path] of [[client, "/client/billing"], [finance, "/admin/collections"], [finance, "/admin/finance/billing-run"]]) {
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(`${BASE}${path}`);
  await sleep(1500);
  const wide = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  check(!wide, `${path} has no sideways page scroll on a phone`);
  await p.setViewportSize({ width: 1360, height: 900 });
}

const errors = [client, am, finance, admin, approver].flatMap((p) => p.errors);
check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(" | ")})`);
await b.close();
done();
