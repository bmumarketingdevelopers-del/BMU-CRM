// Journey: AM Lead reassigns a client's Account Manager from Client 360 with a handover note; the client sees the
// new AM's introduction in Messages; the previous AM keeps read-only access for 7 days.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/clients-actions/am-reassign.mjs
import { apiCall, as, check, done, go, launch, noErrors, shot, stamp, toast } from "./lib.mjs";

const browser = await launch();
const name = `Journey Handover ${stamp}`;
const ownerEmail = `handover.owner.${stamp}@example.com`;

console.log("Set up: a client with Neha (am@) as AM and an Owner user");
const lead = await as(browser, "am.lead@bmu.demo");
const am = await as(browser, "am@bmu.demo");
const amMe = (await apiCall(am, "GET", "/auth/me")).body;
const opts = (await apiCall(lead, "GET", "/clients-actions/form-options")).body;
const created = await apiCall(lead, "POST", "/clients-actions", {
  businessName: name,
  contactName: "Ritu Menon",
  contactPhone: `96${String(stamp).padStart(6, "0")}33`.slice(0, 10),
  contactEmail: ownerEmail,
  industry: "Fitness & wellness",
  billingName: `${name} LLP`,
  billingAddress: "8 Indiranagar, Bengaluru",
  branchId: opts.branches[0].id,
  amUserId: amMe.id,
  inviteNow: true,
  invites: [{ name: "Ritu Menon", email: ownerEmail, role: "client_owner" }],
});
check(created.status === 201, "client created");
const id = created.body.client.id;

console.log("AM Lead reassigns from Client 360");
await go(lead, `/team/clients/${id}`);
await lead.getByRole("button", { name: "Reassign AM" }).click();
const dlg = lead.getByTestId("reassign-dialog");
await dlg.waitFor();
const person = dlg.locator("[data-person]:not([disabled])").filter({ hasNotText: amMe.name }).first();
await person.waitFor({ timeout: 10000 });
const newAm = await person.getAttribute("data-person");
await person.click();
await dlg.getByLabel("Reason").selectOption("skill_fit");
await dlg.getByLabel("Handover note").fill("Ritu prefers calls after 4pm; renewal due in March");
await shot(lead, "20-reassign-dialog");
await dlg.getByRole("button", { name: "Reassign", exact: true }).click();
await toast(lead).waitFor({ timeout: 15000 });
await lead.waitForTimeout(800);
check((await lead.locator("h1").first().locator("..").innerText()).includes(newAm) || (await lead.getByText(`Account Manager: ${newAm}`).count()) > 0, `360 shows ${newAm} as AM`);
await lead.getByRole("tab", { name: "History" }).click();
check(await lead.getByTestId("history-tab").getByText("Ritu prefers calls").isVisible(), "History shows the handover");
noErrors(lead, "reassign");

console.log("The client sees the introduction");
const client = await as(browser, ownerEmail);
await go(client, "/client/messages");
const intro = client.getByText(/your new account manager/).first();
await intro.waitFor({ timeout: 10000 });
check(await intro.isVisible(), "client sees the new AM's introduction");
check(!(await client.getByText("Ritu prefers calls").count()), "the internal handover note stays internal");
await shot(client, "21-client-intro");
noErrors(client, "client messages");

console.log("The previous AM can read for 7 days but not change");
await go(am, `/team/clients/${id}`);
await am.getByText("You handed this client over").waitFor({ timeout: 10000 });
check(true, "previous AM sees the read-only banner");
check(!(await am.getByRole("button", { name: "Edit", exact: true }).count()), "previous AM has no Edit");
const edit = await apiCall(am, "PATCH", `/clients-actions/${id}`, { contactName: "Not Allowed" });
check(edit.status === 403, "previous AM can't change the client (403)");
await shot(am, "22-old-am-read-only");

await browser.close();
done();
