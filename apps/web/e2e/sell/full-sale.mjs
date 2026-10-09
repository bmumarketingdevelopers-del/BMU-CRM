// Journey: a stranger builds a package on the website → lead → duplicate enquiry merged → sales logs a call and a
// follow-up → proposal with a 25% discount → sales manager then Founder approve → sent → client asks for changes →
// v2 sent (v1 link shows superseded) → client e-signs with designation → pays (test mode) → client account, AM,
// welcome → client signs in. Then the pipeline, funnel, forecast and weekly review open with the new numbers.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/sell/full-sale.mjs
import { launch, newPage, signIn, shot, check, finish, BASE, apiAs } from "./lib.mjs";

const browser = await launch();
const stamp = Date.now();
const company = `Journey Co ${stamp}`;
const email = `journey.${stamp}@example.com`;
const phone = `9${String(stamp).slice(-9)}`;

console.log("1. Visitor builds a package on the website");
const visitor = await newPage(browser, "visitor");
await visitor.goto(`${BASE}/`);
check((await visitor.title()).length > 0, "home page opens");
await visitor.goto(`${BASE}/services`);
await shot(visitor, "01-services");
await visitor.goto(`${BASE}/package-builder`);
await visitor.getByText("Social Media Management", { exact: true }).click();
await visitor.getByText("Website Design & Development", { exact: true }).click();
await visitor.waitForSelector("text=Due now to start, incl. GST");
const plan = visitor.getByLabel("Payment plan");
check(await plan.getByText("Project balance (50%)").isVisible(), "package builder shows the 50% project balance in the payment plan");
check(await plan.getByText("Monthly retainer").isVisible(), "package builder shows the monthly retainer in the payment plan");
await shot(visitor, "02-package-builder");
await visitor.getByPlaceholder("Your name").fill("Asha Journey");
await visitor.getByPlaceholder("Email").fill(email);
await visitor.getByPlaceholder("Mobile").fill(phone);
await visitor.getByPlaceholder("Business name (optional)").fill(company);
await visitor.getByRole("button", { name: "Get my proposal" }).click();
await visitor.getByText("We'll call you within one working day").waitFor();
check(true, "package enquiry sent");

console.log("2. Same person books a discovery call (duplicate)");
await visitor.goto(`${BASE}/enquiry`);
await visitor.getByLabel("Your name").fill("Asha J");
await visitor.getByLabel("Email").fill(`asha.other.${stamp}@example.com`);
await visitor.getByLabel("Mobile number").fill(phone);
await visitor.getByLabel("What do you need help with?").fill("Also want SEO for the new site");
await visitor.getByRole("button", { name: "Book my call" }).click();
await visitor.getByText("Your enquiry is with our team").waitFor();
check(true, "discovery-call enquiry sent");

console.log("3. Sales manager assigns the lead and merges the duplicate");
const mgr = await newPage(browser, "sales manager");
await signIn(mgr, "sales.manager@bmu.demo");
await mgr.goto(`${BASE}/team/leads`);
await mgr.getByLabel("Search leads").fill(company);
await mgr.getByRole("button", { name: "List" }).click();
const row = mgr.locator("tr", { hasText: company });
await row.first().waitFor();
check((await row.count()) === 1, "search finds the lead (duplicate has no company name)");
await mgr.getByLabel("Search leads").fill(phone);
check((await mgr.locator("tbody tr").count()) === 2, "searching the phone shows both enquiries");
await shot(mgr, "03-leads-list");
const sales = await newPage(browser, "sales exec");
await signIn(sales, "sales@bmu.demo");
const salesMe = (await apiAs(sales, "GET", "/auth/me")).body;
await mgr.locator("tr", { hasText: company }).getByLabel(`Owner of ${company}`).selectOption(salesMe.id);
await mgr.waitForTimeout(800);
const leads = (await apiAs(mgr, "GET", "/leads")).body;
const lead = leads.find((l) => l.contact.company === company);
const dup = leads.find((l) => l.duplicateOfId === lead.id);
check(lead.owner?.id === salesMe.id, "lead assigned to Priya");
check(!!dup, "second enquiry flagged as possible duplicate");
await mgr.goto(`${BASE}/team/leads/${dup.id}`);
await mgr.getByText("Possible duplicate.").waitFor();
await shot(mgr, "04-duplicate-banner");
await mgr.getByRole("button", { name: `Merge into ${company}` }).click();
await mgr.waitForURL(`**/team/leads/${lead.id}`);
await mgr.getByText("merged a repeat enquiry").waitFor();
check(true, "duplicate merged into the original lead");

console.log("4. Sales exec works the lead");
const bell = (await apiAs(sales, "GET", "/notifications")).body;
check(bell.items.some((n) => n.kind === "lead_assigned" && n.link === `/team/leads/${lead.id}`), "Priya was notified about the new lead");
await sales.goto(`${BASE}/team/leads/${lead.id}`);
await sales.getByRole("radio", { name: "Call" }).click();
await sales.locator("select[name=outcome]").selectOption("interested");
await sales.locator("textarea[name=body]").fill("Spoke to Asha. Wants SMM + website before Diwali.");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
await sales.locator("input[name=followDay]").fill(today);
await sales.locator("input[name=followTime]").fill("23:30");
await sales.getByRole("button", { name: "Save to timeline" }).click();
await sales.getByText("Saved to the timeline.").waitFor();
check(await sales.getByText("Contacted ·", { exact: false }).first().isVisible(), "logging a call moved the lead to Contacted");
check(await sales.getByText("Spoke to Asha.").isVisible(), "call shows on the timeline");
check(await sales.getByText("Lead score").isVisible(), "lead score explanation shows");
await shot(sales, "05-lead-detail");

console.log("5. Proposal with a 25% discount");
await sales.getByRole("link", { name: "Create proposal" }).first().click();
await sales.waitForURL("**/team/proposals/new**");
await sales.getByText("Tick a service to start.").waitFor({ state: "detached" }).catch(() => {});
await sales.getByLabel("Special discount (%)").fill("25").catch(async () => {
  await sales.locator("label", { hasText: "Special discount" }).locator("input").fill("25");
});
await sales.getByTestId("approval-hint").getByText("Sales manager → Founder").waitFor();
check(true, "builder explains the approval chain");
await shot(sales, "06-builder");
await sales.getByRole("button", { name: "Save proposal" }).click();
await sales.waitForURL(/\/team\/proposals\/c/);
const proposalId = sales.url().split("/").pop();
await sales.getByRole("button", { name: "Waiting for discount approval" }).waitFor();
check(true, "send is blocked until approvals");
await shot(sales, "07-proposal-waiting");

console.log("6. Sales manager, then Founder approve");
await mgr.goto(`${BASE}/team/approvals`);
const card = mgr.locator(`[data-approval="${proposalId}"]`);
await card.waitFor();
await card.getByRole("button", { name: "Approve" }).click();
await mgr.getByText("Approved the 25% discount").waitFor();
const founder = await newPage(browser, "founder");
await signIn(founder, "founder@bmu.demo");
await founder.goto(`${BASE}/team/approvals`);
const fcard = founder.locator(`[data-approval="${proposalId}"]`);
await fcard.waitFor();
await shot(founder, "08-approvals-founder");
await fcard.getByRole("button", { name: "Approve" }).click();
await founder.getByText("Approved the 25% discount").waitFor();
check(true, "both approval steps done");
await sales.reload();
await sales.getByRole("button", { name: "Send to client" }).click();
await sales.getByText("Sent. Share the client link below.").waitFor();
const link = await sales.getByLabel("Client link").inputValue();
check(link.includes("/p/"), "client link shown");

console.log("7. Client opens the link and asks for changes");
const client = await newPage(browser, "client");
await client.goto(link);
await client.getByText("Due now to start").waitFor();
check(await client.getByLabel("Payment plan").isVisible(), "client sees the payment plan before accepting");
await client.getByRole("button", { name: "Request changes" }).click();
await client.getByLabel("What would you like changed?").fill("Can we take the Premium social media tier and keep the website?");
await client.getByRole("button", { name: "Send request" }).click();
await client.getByText("we've got your request").waitFor();
await shot(client, "09-client-changes");
const salesBell = (await apiAs(sales, "GET", "/notifications")).body;
check(salesBell.items.some((n) => n.kind === "proposal_changes_requested"), "sales notified about the change request");
check(salesBell.items.some((n) => n.kind === "proposal_viewed"), "sales notified when the client first opened it");

console.log("8. Sales sends v2");
await sales.reload();
await sales.getByText("The client asked for changes").waitFor();
await sales.getByRole("link", { name: "Make a new version" }).click();
await sales.waitForURL("**revise=**");
await sales.getByLabel("Social Media Management tier").selectOption("premium");
await sales.getByLabel("Special discount (%)").fill("5");
await sales.getByRole("button", { name: "Save new version" }).click();
await sales.waitForURL((u) => !u.search.includes("revise"));
await sales.getByText("Version history").waitFor();
const stillWaiting = await sales.getByRole("button", { name: "Waiting for discount approval" }).isVisible().catch(() => false);
if (stillWaiting) {
  // 5% from a sales exec still needs a manager.
  await mgr.goto(`${BASE}/team/approvals`);
  const id2 = sales.url().split("/").pop();
  await mgr.locator(`[data-approval="${id2}"]`).getByRole("button", { name: "Approve" }).click();
  await mgr.getByText("Approved the 5% discount").waitFor();
  await sales.reload();
}
await sales.getByRole("button", { name: "Send to client" }).click();
await sales.getByText("Sent. Share the client link below.").waitFor();
const link2 = await sales.getByLabel("Client link").inputValue();
await shot(sales, "10-proposal-v2");
await client.goto(link);
await client.getByText("This version has been replaced").waitFor();
check(true, "old link shows superseded");
await client.getByRole("link", { name: "Open the latest version" }).click();
await client.waitForURL(link2.replace(/^https?:\/\/[^/]+/, "**"));

console.log("9. Client signs and pays");
await client.getByLabel("Designation").fill("Founder");
await client.locator("input[name=agree]").check();
await client.getByRole("button", { name: "Accept and sign" }).click();
await client.getByText("Signed. One step left").waitFor();
await client.getByRole("link", { name: "View or download your signed agreement" }).waitFor();
const agreement = await newPage(browser, "agreement");
await agreement.goto(`${link2}/agreement`);
await agreement.getByText("Electronically signed").waitFor();
check(await agreement.getByText("Asha Journey, Founder").isVisible(), "agreement shows signer name and designation");
await shot(agreement, "11-agreement");
await client.getByRole("button", { name: /Pay/ }).click();
await client.getByText("Welcome to BMU!").waitFor();
await shot(client, "12-paid");

console.log("10. New client signs in");
const newClient = await newPage(browser, "new client");
await signIn(newClient, email);
check(new URL(newClient.url()).pathname.startsWith("/client"), `client lands in the client app (${newClient.url()})`);
const overview = (await apiAs(newClient, "GET", "/client/overview")).body;
check(overview.engagements?.length === 2 && overview.engagements.every((e) => e.currentGate === "G1"), "two engagements at G1");
check(!!overview.accountManager?.name, "account manager assigned");
const clientBell = (await apiAs(newClient, "GET", "/notifications")).body;
check(clientBell.items.some((n) => n.kind === "welcome"), "welcome notification in the client's bell");
const invoices = (await apiAs(newClient, "GET", "/client/invoices")).body;
check(invoices[0]?.status === "paid", "first invoice paid");
await shot(newClient, "13-client-home");

console.log("11. Numbers update for leadership");
const leadAfter = (await apiAs(founder, "GET", "/leads")).body.find((l) => l.id === lead.id);
check(leadAfter.stage === "won", "lead is Won on the pipeline");
for (const path of ["/admin", "/admin/pipeline", "/admin/analytics/funnel", "/admin/analytics/forecast"]) {
  await founder.goto(`${BASE}${path}`);
  await founder.waitForLoadState("networkidle");
  check(!(await founder.getByText("Something went wrong").isVisible().catch(() => false)), `${path} opens`);
  await shot(founder, `14-founder${path.replace(/\//g, "_")}`);
}

finish();
await browser.close();
