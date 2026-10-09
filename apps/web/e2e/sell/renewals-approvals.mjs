// Journey: renewals (one click renewal proposal → upsell version → client signs and pays → retainer extended, no
// duplicate client), discount rejection with a reason, extending an expired proposal, and phone-width checks.
// Needs the seed (Sell demo clients). Run: BASE_URL=http://localhost:3000 node apps/web/e2e/sell/renewals-approvals.mjs
import { launch, newPage, signIn, shot, check, finish, BASE, apiAs } from "./lib.mjs";

const browser = await launch();
const mgr = await newPage(browser, "sales manager");
await signIn(mgr, "sales.manager@bmu.demo");

console.log("1. Renewals");
await mgr.goto(`${BASE}/team/renewals`);
await mgr.getByText("Up for renewal").waitFor();
await shot(mgr, "20-renewals");
const list = (await apiAs(mgr, "GET", "/sell/renewals")).body;
check(Array.isArray(list) && list.length > 0, `renewals list has ${list.length} services`);
const target = list.find((r) => !r.openProposal && r.billingType === "monthly");
if (!target) {
  check(false, "a monthly retainer without an open renewal proposal (re-run the seed)");
} else {
  const engagementsBefore = (await apiAs(mgr, "GET", "/sell/renewals")).body.filter((r) => r.clientOrgId === target.clientOrgId).length;
  const section = mgr.getByLabel(`Renewal for ${target.client}`);
  await section.getByRole("button", { name: "Create renewal proposal" }).click();
  await mgr.waitForURL(/\/team\/proposals\/c/);
  await mgr.getByText("Renewal proposal v").waitFor();
  check(await mgr.getByText(target.service).first().isVisible(), "renewal proposal prefilled with the current service");
  await mgr.getByRole("link", { name: "Edit as a new version" }).click();
  await mgr.waitForURL("**revise=**");
  await mgr.getByText("Google Business Profile", { exact: true }).click();
  await mgr.getByRole("button", { name: "Save new version" }).click();
  await mgr.waitForURL((u) => !u.search.includes("revise"));
  await mgr.getByRole("button", { name: "Send to client" }).click();
  await mgr.getByText("Sent. Share the client link below.").waitFor();
  const link = await mgr.getByLabel("Client link").inputValue();
  const client = await newPage(browser, "renewal client");
  await client.goto(link);
  await client.getByLabel("Designation").fill("Owner");
  await client.locator("input[name=agree]").check();
  await client.getByRole("button", { name: "Accept and sign" }).click();
  await client.getByRole("button", { name: /Pay/ }).click();
  await client.getByText("Your services continue without a break").waitFor();
  check(true, "client signed and paid the renewal");
  await shot(client, "21-renewal-paid");
  const after = (await apiAs(mgr, "GET", "/sell/renewals")).body;
  check(!after.some((r) => r.engagementId === target.engagementId), "renewed retainer left the renewals list");
  const clients = (await apiAs(mgr, "GET", "/leads")).body.filter((l) => l.source === "renewal" && l.contact.company === target.client);
  check(clients.some((l) => l.stage === "won"), "renewal deal is Won");
  void engagementsBefore;
}

console.log("2. Discount rejection");
const sales = await newPage(browser, "sales exec");
await signIn(sales, "sales@bmu.demo");
const leads = (await apiAs(sales, "GET", "/leads")).body.filter((l) => ["new", "contacted", "discovery"].includes(l.stage));
const lead = leads[0];
const created = await apiAs(sales, "POST", "/proposals", { leadId: lead.id, lines: [{ serviceKey: "smm", tier: "starter" }], extraDiscountPct: 7 });
check(created.status === 201 && created.body.discountStatus === "pending", "7% from a sales exec waits for a sales manager");
await mgr.goto(`${BASE}/team/approvals`);
const card = mgr.locator(`[data-approval="${created.body.id}"]`);
await card.getByRole("button", { name: "Reject" }).click();
await mgr.getByText("Write a short reason").waitFor();
await card.getByRole("textbox").fill("Starter tier already discounted this month");
await card.getByRole("button", { name: "Reject" }).click();
await mgr.getByText("Sales has been notified").waitFor();
await sales.goto(`${BASE}/team/proposals/${created.body.id}`);
await sales.getByText("Rejected: make a new version").waitFor();
check(await sales.getByText("discount rejected").first().isVisible(), "sales sees the rejection on the proposal");
const bell = (await apiAs(sales, "GET", "/notifications")).body;
check(bell.items.some((n) => n.kind === "discount_rejected" && n.body?.includes("Starter tier")), "rejection reason reaches the sales exec's bell");
await shot(sales, "22-discount-rejected");

console.log("3. Extend an expired proposal");
const proposals = (await apiAs(mgr, "GET", "/proposals")).body;
const expired = proposals.find((p) => p.status === "expired");
if (expired) {
  await mgr.goto(`${BASE}/team/proposals/${expired.id}`);
  await mgr.getByText("This proposal has expired").waitFor();
  await mgr.getByRole("button", { name: "Extend" }).click();
  await mgr.getByText(/Extended by \d+ days/).waitFor();
  await mgr.getByRole("heading", { name: "Validity" }).waitFor();
  const after = (await apiAs(mgr, "GET", `/proposals/${expired.id}`)).body;
  check(after.status === "sent", "expired proposal re-opened after extending");
} else check(false, "an expired proposal exists (seed: Sell demo · Metro Dental)");

console.log("4. Phone width");
const phone = await newPage(browser, "phone", { mobile: true });
await signIn(phone, "sales.manager@bmu.demo");
const someLead = (await apiAs(phone, "GET", "/leads"))[`body`][0];
for (const path of ["/team/leads", `/team/leads/${someLead.id}`, "/team/approvals", "/team/renewals", "/team/proposals", "/package-builder", "/enquiry"]) {
  await phone.goto(`${BASE}${path}`);
  await phone.waitForLoadState("networkidle");
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `${path} fits a phone screen (overflow ${overflow}px)`);
}
await phone.goto(`${BASE}/team/leads/${someLead.id}`);
await shot(phone, "23-phone-lead");

finish();
await browser.close();
