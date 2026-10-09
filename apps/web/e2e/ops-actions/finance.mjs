// v11 ops journey: finance. + New invoice with service and pass-through lines (GST on service only), save as draft and
// issue, the invoices list (row menu, bulk bar, export), due-date change (≤ 7 days applies; more goes to an Admin),
// offline payment that needs proof, a credit note that waits for Admin approval, and forbidden roles.
// BASE_URL=http://localhost:3000 node apps/web/e2e/ops-actions/finance.mjs
import { writeFileSync } from "node:fs";
import { as, apiCall, check, dayAhead, done, go, launch, noErrors, noSideScroll, shot, SHOTS, stamp } from "./lib.mjs";

const browser = await launch();
const proofPath = `${SHOTS}/proof-${stamp}.pdf`;
writeFileSync(proofPath, "%PDF-1.4\n% bank slip for the journey\n");

console.log("1. Finance raises a manual invoice");
const fin = await as(browser, "finance@bmu.demo");
await go(fin, "/admin/finance/invoices");
await fin.getByTestId("add-invoice").click();
const drawer = fin.getByTestId("invoice-drawer");
await drawer.waitFor();
const opts = (await apiCall(fin, "GET", "/ops/finance/options")).body;
const client = opts.clients.find((c) => c.name.startsWith("Sunrise")) ?? opts.clients[0];
await drawer.getByLabel("Client").selectOption(client.id);
await drawer.getByLabel("Line 1 description").fill(`Extra reels ${stamp}`);
await drawer.getByLabel("Line 1 amount").fill("10000");
await drawer.getByRole("button", { name: "+ Ad spend (pass-through)" }).click();
await drawer.getByLabel("Line 2 description").fill("Meta ad spend October");
await drawer.getByLabel("Line 2 amount").fill("5000");
const totals = await drawer.innerText();
check(/GST 18% ₹1,800/.test(totals) && /pass-through ₹5,000/.test(totals) && /₹16,800/.test(totals), "GST on service only; pass-through added at cost");
await shot(fin, "finance-01-invoice-drawer");
await drawer.getByRole("button", { name: "Save as draft" }).click();
await drawer.waitFor({ state: "detached", timeout: 15000 });
const drafts = (await apiCall(fin, "GET", "/ops/finance/drafts")).body;
const draft = drafts.find((r) => r.totalPaise === 1_680_000);
check(!!draft, "draft saved");

console.log("2. Issue the draft from the Drafts panel");
await fin.getByTestId("invoice-drafts").waitFor();
await fin.getByRole("button", { name: `Issue ${draft.number}` }).click();
await fin.locator(`[data-invoice="${draft.number}"]`).waitFor({ timeout: 15000 });
const issued = (await apiCall(fin, "GET", `/finance/invoices/${draft.id}`)).body;
check(issued.status === "issued", "draft issued");
check(await fin.getByRole("button", { name: /Export/ }).first().isVisible(), "export offered");
await fin.getByLabel(`Select ${draft.number}`).check();
check(await fin.getByTestId("bulk-bar").getByRole("button", { name: "Send reminders" }).isVisible(), "bulk reminders offered");

console.log("3. Due date: 3 days applies, 20 days needs an Admin");
await go(fin, `/admin/finance/invoices/${draft.id}`);
await fin.getByRole("button", { name: "Change due date" }).click();
let dlg = fin.getByTestId("due-date-dialog");
const due0 = issued.dueDate.slice(0, 10);
const plus = (d, n) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
await dlg.getByLabel("New due date").fill(plus(due0, 3));
await dlg.getByRole("button", { name: "Change due date" }).click();
check(await dlg.getByText("Say why the due date moves").isVisible(), "reason required");
await dlg.getByLabel("Reason").fill("Client pays on Fridays");
await dlg.getByRole("button", { name: "Change due date" }).click();
await dlg.waitFor({ state: "detached", timeout: 15000 });
const moved = (await apiCall(fin, "GET", `/finance/invoices/${draft.id}`)).body;
check(moved.dueDate.slice(0, 10) === plus(due0, 3), "3-day move applied straight away");
await fin.getByRole("button", { name: "Change due date" }).click();
dlg = fin.getByTestId("due-date-dialog");
await dlg.getByLabel("New due date").fill(plus(due0, 25));
await dlg.getByLabel("Reason").fill("Waiting for their new financial year");
await dlg.getByRole("button", { name: "Ask an Admin" }).click();
await dlg.waitFor({ state: "detached", timeout: 15000 });
check(/Admin/i.test(await fin.getByRole("status").first().innerText()), "long move sent to an Admin");
const still = (await apiCall(fin, "GET", `/finance/invoices/${draft.id}`)).body;
check(still.dueDate.slice(0, 10) === plus(due0, 3), "due date unchanged until approved");

console.log("4. Offline payment needs proof");
const form = fin.locator("#record-payment");
await form.locator("input[inputmode=decimal]").first().fill("5000");
await form.getByLabel("Reference").fill(`UTR${stamp}`);
await form.getByRole("button", { name: "Record payment" }).click();
check(await form.getByText(/Upload the proof/).isVisible(), "payment refused without proof");
await form.getByLabel("Payment proof").setInputFiles(proofPath);
await form.getByText(`proof-${stamp}.pdf`).waitFor({ timeout: 15000 });
await form.getByRole("button", { name: "Record payment" }).click();
await fin.waitForTimeout(2000);
const paid = (await apiCall(fin, "GET", `/finance/invoices/${draft.id}`)).body;
check(paid.paidPaise === 500_000, "part payment recorded with proof");
const noProof = await apiCall(fin, "POST", `/ops/finance/invoices/${draft.id}/offline-payment`, { amountPaise: 1000, method: "upi", ref: `X${stamp}`, at: dayAhead(0) });
check(noProof.status === 400, `API refuses an offline payment without proof (${noProof.status})`);

console.log("5. Credit note waits for Admin approval");
const cn = await apiCall(fin, "POST", "/finance/credit-notes", { invoiceId: draft.id, amountPaise: 100_000, reason: "One reel dropped" });
check(cn.status < 300 && (cn.body.pending || cn.body.approvalId), `credit note by Finance goes to an Admin (${cn.status})`);
await shot(fin, "finance-02-detail");
noErrors(fin, "finance");

console.log("6. Forbidden: sales and producer");
const sales = await as(browser, "sales@bmu.demo");
const s1 = await apiCall(sales, "POST", "/ops/finance/invoices", { clientOrgId: client.id, dueDate: dayAhead(10), issue: true, lines: [{ label: "x", kind: "service", amountPaise: 100 }] });
check(s1.status === 403, `sales cannot raise invoices (${s1.status})`);
const producer = await as(browser, "producer@bmu.demo");
const p1 = await apiCall(producer, "POST", `/ops/finance/invoices/${draft.id}/due-date`, { dueDate: dayAhead(30), reason: "please" });
check(p1.status === 403, `producer cannot change due dates (${p1.status})`);

console.log("7. 390px");
const mob = await as(browser, "finance@bmu.demo", { mobile: true });
await go(mob, "/admin/finance/invoices");
check(await noSideScroll(mob), "invoices page has no side scroll at 390px");
await shot(mob, "finance-03-mobile");

await browser.close();
done();
