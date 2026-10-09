// Journey: AM Lead migrates an existing client and sets the current gate of its service (with a reason); the
// service shows as migrated at that gate, earlier gates count as approved, and the AM can move the gate later.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/clients-actions/migrated-client.mjs
import { apiCall, as, check, done, go, launch, noErrors, shot, stamp, toast } from "./lib.mjs";

const browser = await launch();
const name = `Journey Legacy ${stamp}`;

console.log("AM Lead migrates an existing client");
const lead = await as(browser, "am.lead@bmu.demo");
await go(lead, "/team/clients");
await lead.getByRole("button", { name: "Migrate existing client" }).click();
const drawer = lead.getByTestId("add-client-drawer");
await drawer.waitFor();
check(await drawer.getByRole("radio", { name: /Existing client migration/ }).getAttribute("aria-checked") === "true", "drawer opens in migration mode");
await drawer.locator("#ac-name").fill(name);
await drawer.locator("#ac-industry").fill("Retail");
await drawer.locator("#ac-cname").fill("Arjun Shah");
await drawer.locator("#ac-phone").fill(`97${String(stamp).padStart(6, "0")}22`.slice(0, 10));
await drawer.locator("#ac-email").fill(`arjun.${stamp}@example.com`);
await drawer.locator("#ac-bname").fill(`${name} Pvt Ltd`);
await drawer.locator("#ac-addr").fill("5 Linking Road, Mumbai");
await drawer.getByRole("button", { name: "+ Add a service" }).click();
await drawer.locator("#ac-s0").selectOption({ index: 1 });
await drawer.locator("#ac-g0").selectOption("G3");
await drawer.locator("#ac-r0").fill("Plan approved in August, production running");
await drawer.locator("#ac-mig").fill("Existing client from the old spreadsheet");
await shot(lead, "10-migrate-drawer");
await drawer.getByRole("button", { name: "Migrate client", exact: true }).click();
await toast(lead).waitFor({ timeout: 15000 });
noErrors(lead, "migrate");

const list = await apiCall(lead, "GET", `/clients-actions/list?q=${encodeURIComponent(name)}`);
const row = list.body.find((c) => c.name === name);
check(!!row, "migrated client is in the list");
check(row?.startMode === "migration", "client is marked as migrated");
await go(lead, `/team/clients/${row.id}?tab=services`);
await lead.getByTestId("client360-actions").waitFor();
check(await lead.getByTestId("client360-actions").getByText("Migrated").isVisible(), "360 header shows Migrated");
check(await lead.getByText("Migrated at G3").isVisible(), "service shows Migrated at G3");
check(!(await lead.getByText("Waiting for first payment").count()), "no payment hold for a migrated client");
await shot(lead, "11-migrated-services");

console.log("The AM moves the migrated service to G4");
const am = await as(browser, "am@bmu.demo");
const detail = await apiCall(lead, "GET", `/clients-actions/${row.id}`);
const svc = detail.body.services[0];
const amId = (await apiCall(am, "GET", "/auth/me")).body.id;
if (detail.body.am?.id !== amId) await apiCall(lead, "POST", "/actions/reassign/client_am/apply", { ids: [row.id], toUserId: amId, reason: "skill_fit", handoverNote: "Migrated client, history in the old spreadsheet" });
await go(am, `/team/clients/${row.id}?tab=services`);
await am.getByRole("button", { name: `Actions for ${svc.serviceName}` }).click();
await am.getByRole("menuitem", { name: "Set current gate" }).click();
const dlg = am.getByTestId("gate-dialog");
await dlg.locator("#sg-gate").selectOption("G4");
await dlg.locator("#sg-reason").fill("Drafts are with the client now");
await dlg.getByRole("button", { name: "Save" }).click();
await toast(am).waitFor({ timeout: 15000 });
await am.waitForTimeout(800);
check(await am.getByText("Migrated at G4").isVisible(), "service now at G4");
await shot(am, "12-gate-moved");
noErrors(am, "set gate");

await browser.close();
done();
