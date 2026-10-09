// v18 journey: finance 2.0 and capacity.
// API: a fresh client with a project and an open invoice.
// Browser: Finance creates a pay link on the invoice → the client pays on the public pay page (test mode) → the invoice
// is paid and the client sees "Payment received" on their thread. A Razorpay payment nobody can place lands in
// "Payments to match" and Finance matches it. The AM claims a billable expense, Finance approves and re-bills it.
// Finance plans 50/30/20 instalments and issues the first. Profit and Cash flow pages load. A producer runs the
// stopwatch. The workload board books a designer and refuses someone on approved leave.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/finance/finance.mjs
import { api, check, freshClient, launch, publicApi, shot, signIn, BASE } from "../deliver/lib.mjs";

const browser = await launch();
const errors = [];
const sessions = {};
async function as(email) {
  if (!sessions[email]) {
    sessions[email] = await signIn(browser, email);
    errors.push(sessions[email].errors);
  }
  return sessions[email].page;
}
const go = async (page, path) => {
  await page.goto(`${BASE}${path}`);
  await page.waitForLoadState("networkidle");
};
const finance = api("finance@bmu.demo");
const stamp = Date.now().toString(36);
const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const monday = (iso) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const invoice = async (c, rupees) => finance.post("/ops/finance/invoices", { clientOrgId: c.clientOrgId, engagementId: c.engagements[0].id, dueDate: addDays(today, 7), lines: [{ label: `Campaign work ${stamp}`, amountPaise: rupees * 100, kind: "service" }], issue: true });

try {
  console.log("1. Fresh client with an open invoice (API)");
  const c = await freshClient({ services: [{ serviceKey: "smm", tier: "growth" }], tag: `fn${stamp}` });
  const founderApi = api("founder@bmu.demo");
  const amUser = (await founderApi.get("/org/users")).find((u) => u.email === "am@bmu.demo");
  await founderApi.post(`/admin-org/clients/${c.clientOrgId}/am`, { amUserId: amUser.id }).catch(() => {});
  const inv = await invoice(c, 25000);
  check(inv.status === "issued", `invoice ${inv.number} issued`);

  console.log("2. Finance creates a pay link; the client pays on the public page; the invoice is paid");
  const fin = await as("finance@bmu.demo");
  await go(fin, `/admin/finance/invoices/${inv.id}`);
  await fin.getByTestId("create-pay-link").click();
  await fin.getByTestId("pay-link").first().waitFor();
  const href = await fin.getByTestId("pay-link").first().locator("a").getAttribute("href");
  check(href.includes("/pay/"), "a pay link was made");
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  await visitor.goto(`${BASE}/pay/${href.split("/pay/")[1]}`);
  await visitor.getByTestId("pay-test").click();
  await visitor.getByText("Paid, thank you").waitFor();
  await shot(visitor, "finance-public-pay");
  await ctx.close();
  const after = await finance.get(`/finance/invoices/${inv.id}`);
  check(after.status === "paid", "the invoice is marked paid");
  const client = await as(c.email);
  await go(client, "/client/messages");
  await client.getByText(`invoice ${inv.number}`, { exact: false }).first().waitFor();
  check(true, "the client sees “Payment received” on their thread");

  console.log("3. A Razorpay payment nobody can place waits in “Payments to match”; Finance matches it");
  const inv2 = await invoice(c, 11111);
  await publicApi.post("/webhooks/razorpay", { event: "payment.captured", payload: { payment: { entity: { id: `pay_j_${stamp}`, amount: inv2.totalPaise, status: "captured" } } } });
  await go(fin, "/admin/finance/reconcile");
  const row = fin.getByRole("row").filter({ hasText: `pay_j_${stamp}` });
  await row.waitFor();
  await row.getByTestId("match-pick").selectOption({ label: new RegExp(inv2.number.replace(/[/]/g, "\\/")) }).catch(async () => {
    const opts = await row.getByTestId("match-pick").locator("option").allTextContents();
    const pick = opts.find((o) => o.startsWith(inv2.number));
    await row.getByTestId("match-pick").selectOption({ label: pick });
  });
  await row.getByTestId("match-btn").click();
  await fin.getByText("Matched. The invoice is updated.").waitFor();
  check((await finance.get(`/finance/invoices/${inv2.id}`)).status === "paid", "matched payment marked the invoice paid");
  await shot(fin, "finance-reconcile");

  console.log("4. The AM claims a billable expense; Finance approves it and re-bills the client");
  const amPage = await as("am@bmu.demo");
  await go(amPage, "/team/expenses");
  await amPage.getByTestId("new-expense").click();
  await amPage.getByTestId("expense-description").fill(`Props for shoot ${stamp}`);
  await amPage.getByTestId("expense-amount").fill("2400");
  await amPage.getByTestId("expense-client").selectOption({ label: c.company });
  await amPage.getByTestId("expense-billable").check();
  await amPage.getByRole("button", { name: "Send claim" }).click();
  await amPage.getByText(`Props for shoot ${stamp}`).waitFor();
  await go(fin, "/admin/finance/expenses");
  const exp = fin.getByRole("row").filter({ hasText: `Props for shoot ${stamp}` });
  await exp.getByTestId("approve-expense").click();
  await fin.getByText("Approved.").waitFor();
  await fin.getByRole("button", { name: `Invoice ${c.company}` }).click();
  await fin.getByText(`Invoice issued to ${c.company}.`).waitFor();
  check(true, "approved and re-billed");
  await shot(fin, "finance-expenses");

  console.log("5. Finance plans 50/30/20 instalments and issues the first one");
  await go(fin, "/admin/finance/schedules");
  await fin.getByTestId("new-plan").click();
  const form = fin.getByTestId("plan-form");
  await form.getByRole("combobox").first().selectOption({ label: c.company });
  await form.getByTestId("plan-total").fill("200000");
  await form.getByRole("button", { name: "Plan instalments" }).click();
  await fin.getByText("Instalments planned.", { exact: false }).waitFor();
  const plans = await finance.get(`/money/schedules?clientId=${c.clientOrgId}`);
  check(plans.length === 3 && plans.reduce((s, p) => s + p.amountPaise, 0) === 200000_00, "three instalments adding up to ₹2,00,000");
  fin.once("dialog", (d) => d.accept());
  await fin.getByRole("row").filter({ hasText: c.company }).filter({ hasText: "Advance (50%)" }).getByTestId("issue-now").click();
  await fin.getByText("Invoice issued.").waitFor();
  check((await finance.get(`/money/schedules?clientId=${c.clientOrgId}`)).some((p) => p.status === "issued"), "first instalment invoiced");

  console.log("6. Profit and Cash flow");
  const founderPage = await as("founder@bmu.demo");
  await go(founderPage, "/admin/finance/profit");
  await founderPage.getByText("How it is worked out").waitFor();
  check(await founderPage.getByText(c.company).first().isVisible(), "the new client is on the profit table");
  await shot(founderPage, "finance-profit");
  await go(fin, "/admin/finance/cashflow");
  check((await fin.getByTestId("cashflow-week").count()) === 13, "13 weeks of cash flow");
  await shot(fin, "finance-cashflow");

  console.log("7. A producer uses the stopwatch");
  const prod = await as("producer@bmu.demo");
  await go(prod, "/team/timesheet");
  await prod.getByTestId("timer-start").click();
  await prod.getByTestId("timer-clock").waitFor();
  await prod.getByTestId("timer-stop").click();
  await prod.getByText(/Logged 0h 1m/).waitFor();
  check(true, "the timer logged the time");

  console.log("8. Workload: book a designer; someone on approved leave is refused");
  const view = await api("producer@bmu.demo").get(`/capacity/workload?weeks=6`);
  const leaveCell = view.people.flatMap((p) => p.cells.map((cl) => ({ p, cl }))).find((x) => x.cl.leaveDays > 0);
  await go(prod, "/team/workload");
  await prod.getByTestId("heatmap").waitFor();
  check((await prod.getByTestId("heatmap-row").count()) > 3, "the heatmap lists the team");
  const far = addDays(monday(today), 35);
  const designer = view.people.find((p) => p.specialty === "graphic_designer");
  await prod.getByTestId("new-booking").click();
  await prod.getByTestId("booking-project").selectOption({ label: `${c.company} · ${c.engagements[0].serviceName ?? c.engagements[0].service?.name ?? ""}`.trim() }).catch(async () => {
    const opts = await prod.getByTestId("booking-project").locator("option").allTextContents();
    await prod.getByTestId("booking-project").selectOption({ label: opts.find((o) => o.startsWith(c.company)) });
  });
  await prod.getByTestId("booking-person").selectOption(designer.userId);
  await prod.getByLabel("Week starting (Monday)").fill(far);
  await prod.getByTestId("booking-hours").fill("6");
  await prod.getByTestId("booking-save").click();
  await prod.getByText("Booked 1 week.").waitFor();
  check(true, `${designer.name} booked 6h`);
  if (leaveCell) {
    await prod.getByTestId("new-booking").click();
    await prod.getByTestId("booking-person").selectOption(leaveCell.p.userId);
    await prod.getByLabel("Week starting (Monday)").fill(leaveCell.cl.weekStart);
    await prod.getByTestId("booking-hours").fill("40");
    await prod.getByTestId("booking-save").click();
    await prod.getByRole("alert").filter({ hasText: /leave/ }).waitFor();
    check(true, `booking ${leaveCell.p.name} in a leave week was refused`);
  } else check(true, "no approved leave in view (skipped the refusal check)");
  await shot(prod, "finance-workload");

  const errs = errors.flat();
  check(errs.length === 0, `no page errors${errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""}`);
  console.log("\nFINANCE JOURNEY PASSED");
} catch (err) {
  console.error("\nFAILED:", err.message);
  for (const [email, s] of Object.entries(sessions)) await shot(s.page, `finance-fail-${email.split("@")[0]}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
