// v11 ops journey: leads & sales. + Add lead (top button and the column "+ Add") with required fields, the live
// duplicate warning and "Add anyway", owner by round-robin, the ⋯ menu (mark lost with a reason, merge), list view with
// bulk actions and export, the lead page's History, account managers adding referrals only, and forbidden roles.
// BASE_URL=http://localhost:3000 node apps/web/e2e/ops-actions/leads.mjs
import { as, apiCall, check, done, go, launch, noErrors, noSideScroll, shot, stamp, toast } from "./lib.mjs";

const browser = await launch();
const phone = `9${String(stamp).padStart(6, "0")}321`.slice(0, 10);
const company = `Journey Bakes ${stamp}`;

console.log("1. Sales manager adds a lead from the pipeline");
const mgr = await as(browser, "sales.manager@bmu.demo");
await go(mgr, "/team/leads");
await mgr.getByTestId("add-lead").click();
const drawer = mgr.getByTestId("lead-drawer");
await drawer.waitFor();
await drawer.getByRole("button", { name: "Save lead" }).click();
check(await drawer.getByText("Enter the contact's name").isVisible(), "required fields are checked before saving");
await drawer.getByLabel("Contact name").fill("Meera Iyer");
await drawer.getByLabel("Mobile number").fill(phone);
await drawer.getByLabel("Business name").fill(company);
await drawer.getByLabel("Source").selectOption("walk_in");
await drawer.getByRole("button", { name: "Social Media Management", exact: true }).click();
check((await drawer.getByLabel("Owner").inputValue()) === "", "owner defaults to round-robin for a manager");
await shot(mgr, "leads-01-drawer");
await drawer.getByRole("button", { name: "Save lead" }).click();
await drawer.waitFor({ state: "detached", timeout: 15000 });
check(/added|owner|Lead/i.test(await toast(mgr).innerText()), "toast confirms the new lead");
const leads = (await apiCall(mgr, "GET", "/leads")).body;
const lead = leads.find((l) => l.contact.company === company);
check(!!lead, "lead saved");
check(!!lead?.owner, `owner set by round-robin (${lead?.owner?.name ?? "none"})`);

console.log("2. Duplicate warning and Add anyway");
await mgr.getByTestId("add-lead").click();
await drawer.waitFor();
await drawer.getByLabel("Mobile number").fill(phone);
await drawer.getByText(/looks like|already|duplicate/i).first().waitFor({ timeout: 10000 });
check(true, "live duplicate warning shows for the same mobile");
await drawer.getByLabel("Contact name").fill("Meera I");
await drawer.getByLabel("Business name").fill(`${company} 2`);
await drawer.getByLabel("Source").selectOption("referral");
await drawer.getByRole("button", { name: "Social Media Management", exact: true }).click();
await drawer.getByRole("button", { name: "Save lead" }).click();
await drawer.getByRole("button", { name: "Add anyway" }).waitFor({ timeout: 10000 });
check(true, "server refuses the duplicate until confirmed");
await drawer.getByRole("button", { name: "Add anyway" }).click();
await drawer.waitFor({ state: "detached", timeout: 15000 });
const dup = (await apiCall(mgr, "GET", "/leads")).body.find((l) => l.contact.company === `${company} 2`);
check(!!dup, "Add anyway saves the duplicate");

console.log("3. Column + Add opens the drawer for that stage");
await mgr.getByRole("button", { name: "Add a lead to Discovery" }).click();
await drawer.waitFor();
check(true, "column + Add opens the lead drawer");
await drawer.getByRole("button", { name: "Cancel" }).click();

console.log("4. Row menu: merge the duplicate, mark a lead lost");
await go(mgr, "/team/leads");
await mgr.getByRole("button", { name: `More actions for ${company} 2` }).first().click();
await mgr.getByRole("menuitem", { name: "Merge into another lead" }).click();
const merge = mgr.getByTestId("merge-dialog");
await merge.waitFor();
await merge.getByLabel("Find the lead to keep").fill(company);
await merge.getByRole("radio").first().check();
await merge.getByRole("button", { name: "Merge" }).click();
await merge.waitFor({ state: "detached", timeout: 15000 });
check(!(await apiCall(mgr, "GET", "/leads")).body.some((l) => l.id === dup?.id), "merged lead leaves the pipeline");
await mgr.getByRole("button", { name: `More actions for ${company}` }).first().click();
await mgr.getByRole("menuitem", { name: "Mark lost" }).click();
const reason = mgr.getByTestId("reason-dialog");
await reason.getByRole("button", { name: "Mark lost" }).click();
check(await reason.getByText(/short reason/).isVisible(), "lost needs a reason");
await reason.getByLabel("Common reasons").selectOption("Budget too low");
await reason.getByRole("button", { name: "Mark lost" }).click();
await reason.waitFor({ state: "detached", timeout: 15000 });
const lost = (await apiCall(mgr, "GET", "/leads")).body.find((l) => l.id === lead.id);
check(lost?.stage === "lost" && lost.lostReason === "Budget too low", "lead marked lost with the reason");

console.log("5. List view: bulk bar, export, saved views");
await mgr.getByRole("button", { name: "List", exact: true }).click();
await mgr.getByLabel(/^Select /).nth(1).check();
await mgr.getByTestId("bulk-bar").waitFor();
check(await mgr.getByTestId("bulk-bar").getByRole("button", { name: "Reassign" }).isVisible(), "bulk bar offers reassign");
check(await mgr.getByRole("button", { name: /Export/ }).first().isVisible(), "export is offered");
check(await mgr.getByRole("button", { name: /views/i }).first().isVisible(), "saved views menu is offered");
await shot(mgr, "leads-02-list-bulk");

console.log("6. Lead page: ⋯ menu, required follow-up for calls, History");
await go(mgr, `/team/leads/${lead.id}`);
check(await mgr.getByTestId("history-tab").isVisible(), "History on the lead page");
check(await mgr.getByRole("button", { name: `More actions for ${company}` }).isVisible(), "⋯ menu on the lead page");
noErrors(mgr, "sales manager");

console.log("7. Account manager adds referrals only");
const am = await as(browser, "am@bmu.demo");
await go(am, "/team/tasks");
await am.locator("[data-new-button]").click();
await am.getByRole("menuitem", { name: /^Lead/ }).click();
await am.getByText("Add a referral").first().waitFor();
check(!(await am.getByTestId("lead-drawer").getByLabel("Source").isVisible().catch(() => false)), "no source picker for an AM (referral)");
const amTry = await apiCall(am, "POST", "/ops/leads", { name: "X Y", phone: "9876500011", company: "AM Direct", source: "walk_in", serviceIds: ["smm"] });
check(amTry.status === 403 || amTry.status === 400, `AM cannot add a non-referral lead (${amTry.status})`);
noErrors(am, "am");

console.log("8. Forbidden: producer");
const producer = await as(browser, "producer@bmu.demo");
const p1 = await apiCall(producer, "POST", "/ops/leads", { name: "No Way", phone: "9876500012", company: "Nope", source: "referral", serviceIds: ["smm"] });
check(p1.status === 403, `producer cannot add leads (${p1.status})`);
const p2 = await apiCall(producer, "POST", `/ops/leads/${lead.id}/merge`, { intoId: lead.id });
check(p2.status === 403, `producer cannot merge leads (${p2.status})`);
await go(producer, "/team/leads");
check(!producer.url().includes("/team/leads"), "producer is sent away from the pipeline");

console.log("9. 390px");
const mob = await as(browser, "sales.manager@bmu.demo", { mobile: true });
await go(mob, "/team/leads");
check(await noSideScroll(mob), "leads page has no side scroll at 390px");
await shot(mob, "leads-03-mobile");

await browser.close();
done();
