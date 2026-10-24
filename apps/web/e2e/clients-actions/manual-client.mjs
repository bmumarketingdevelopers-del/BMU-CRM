// Journey: CM Lead adds a client by hand (no lead) with an offline payment; Finance confirms; the payment gate opens.
// Also: duplicate warning with Merge / Continue, the Client 360 tabs, and the Clients list at phone width.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/clients-actions/manual-client.mjs
import { apiCall, as, check, done, go, launch, noErrors, noSideScroll, shot, stamp, toast } from "./lib.mjs";

const browser = await launch();
const name = `Journey Bakery ${stamp}`;
const phone = `98${String(stamp).padStart(6, "0")}11`.slice(0, 10);

console.log("CM Lead adds a client from the Clients list");
const lead = await as(browser, "am.lead@bmu.demo");
await go(lead, "/team/clients");
check(await lead.getByTestId("clients-add").isVisible(), "Clients list shows + Add");
await shot(lead, "01-clients-list");
await lead.getByTestId("clients-add").click();
const drawer = lead.getByTestId("add-client-drawer");
await drawer.waitFor();
await drawer.locator("#ac-name").fill(name);
await drawer.locator("#ac-industry").fill("Restaurants & cafes");
await drawer.locator("#ac-cname").fill("Meera Iyer");
await drawer.locator("#ac-phone").fill(phone);
await drawer.locator("#ac-email").fill(`meera.${stamp}@example.com`);
await drawer.locator("#ac-bname").fill(`${name} LLP`);
await drawer.locator("#ac-addr").fill("22 Church Street, Bengaluru");
const branch = drawer.locator("#ac-branch");
if ((await branch.inputValue()) === "") await branch.selectOption({ index: 1 });
await drawer.getByRole("button", { name: "+ Add a service" }).click();
await drawer.locator("#ac-s0").selectOption({ index: 1 });
await drawer.getByRole("radio", { name: /Paid offline/ }).click();
await drawer.getByLabel("Payment reference").fill(`UTR${stamp}`);
await drawer.getByRole("radio", { name: "Invite now" }).click();
await drawer.locator("#ac-handover").fill("Owner wants a soft launch before Diwali");
await shot(lead, "02-add-client-drawer");
await drawer.getByRole("button", { name: "Add client", exact: true }).click();
await toast(lead).waitFor({ timeout: 15000 });
check(/Finance|added|confirm/i.test(await toast(lead).innerText()), "toast confirms the client was added");
await lead.waitForTimeout(800);
await lead.getByPlaceholder("Find client…").fill(name);
const row = lead.locator("[data-client-row]").filter({ hasText: name });
await row.first().waitFor({ timeout: 10000 });
check(await row.getByText("Payment pending").isVisible(), "list row shows Payment pending");
noErrors(lead, "add client");

console.log("Duplicate check: same phone offers Merge or Continue");
await lead.getByTestId("clients-add").click();
await drawer.waitFor();
await drawer.locator("#ac-name").fill(`${name} Two`);
await drawer.locator("#ac-phone").fill(phone);
await drawer.locator("#ac-cname").click();
const dup = drawer.getByTestId("duplicate-box");
await dup.waitFor({ timeout: 10000 });
check(await dup.getByRole("button", { name: "Merge into this client" }).first().isVisible(), "duplicate box offers Merge");
check(await dup.getByRole("button", { name: /Continue/ }).isVisible(), "duplicate box offers Continue");
await shot(lead, "03-duplicate");
await drawer.getByRole("button", { name: "Cancel" }).click().catch(() => lead.keyboard.press("Escape"));
await lead.waitForTimeout(300);

console.log("Client 360: tabs, payment pending, + Add menu");
await row.first().getByRole("link", { name }).click();
await lead.waitForURL(/\/team\/clients\/[a-z0-9]+/);
const clientId = lead.url().split("/team/clients/")[1].split("?")[0];
await lead.getByTestId("client360-actions").waitFor();
check(await lead.getByTestId("client360-actions").getByText("Payment pending").isVisible(), "360 shows Payment pending");
for (const t of ["Overview", "Services", "Work", "Requests", "Users", "Brands", "Notes", "Billing", "History"]) check(await lead.getByRole("tab", { name: t }).isVisible(), `tab ${t}`);
await lead.getByRole("tab", { name: "Services" }).click();
check(await lead.getByText("Waiting for first payment").first().isVisible(), "service waits for the first payment");
check(await lead.getByRole("button", { name: "+ Add service" }).isVisible(), "Services tab has + Add service");
await lead.getByRole("button", { name: "Add to this client" }).click();
for (const item of ["Task", "Request", "Service", "User", "Brand or location", "Note"]) check(await lead.getByRole("menuitem", { name: item, exact: true }).isVisible(), `+ Add menu: ${item}`);
await lead.keyboard.press("Escape");
await lead.getByRole("tab", { name: "History" }).click();
await lead.getByTestId("history-tab").waitFor();
check(true, "History tab renders");
await shot(lead, "04-client360-services");
noErrors(lead, "client 360");

console.log("Finance confirms the offline payment");
const fin = await as(browser, "finance@bmu.demo");
const box = await apiCall(fin, "GET", "/actions/approvals?box=mine");
const ap = box.body.find((a) => a.action === "clients.confirm_payment" && a.summary.includes(name));
check(!!ap, "Finance has the payment confirmation in Approvals");
const dec = await apiCall(fin, "POST", `/actions/approvals/${ap.id}/decide`, { decision: "approve", note: "Seen in bank statement" });
check(dec.status === 200, "Finance approves");
await go(lead, `/team/clients/${clientId}?tab=services`);
await lead.getByTestId("client360-actions").waitFor();
check(!(await lead.getByText("Waiting for first payment").count()), "payment gate is open after Finance confirms");
await shot(lead, "05-after-payment");

console.log("Phone width");
const phoneLead = await as(browser, "am.lead@bmu.demo", { mobile: true });
await go(phoneLead, "/team/clients");
await phoneLead.getByTestId("clients-add").waitFor();
check(await noSideScroll(phoneLead), "Clients list: no sideways scroll at 390px");
await go(phoneLead, `/team/clients/${clientId}`);
await phoneLead.getByTestId("client360-actions").waitFor();
check(await noSideScroll(phoneLead), "Client 360: no sideways scroll at 390px");
await shot(phoneLead, "06-client360-phone");
noErrors(phoneLead, "phone");

await browser.close();
done();
