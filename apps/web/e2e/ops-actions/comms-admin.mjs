// v11 ops journey: communication and admin configuration. Start a project discussion, message → request, + New →
// Note on a lead, + New → Announcement (founder only), WhatsApp approval status on notification templates,
// integrations connect / disconnect panel, a department head's SOP going to a Branch Manager, and forbidden roles.
// BASE_URL=http://localhost:3000 node apps/web/e2e/ops-actions/comms-admin.mjs
import { as, apiCall, check, done, go, launch, noErrors, noSideScroll, shot, stamp, toast } from "./lib.mjs";

const browser = await launch();

console.log("1. AM starts a project discussion and turns a message into a request");
const am = await as(browser, "am@bmu.demo");
await go(am, "/team/messages");
await am.getByTestId("start-discussion").click();
const dd = am.getByTestId("discussion-drawer");
await dd.waitFor({ timeout: 15000 });
const opts = (await apiCall(am, "GET", "/ops/threads/options")).body;
const client = opts.clients.find((c) => c.name.startsWith("Sunrise")) ?? opts.clients[0];
await dd.getByLabel("Client").selectOption(client.id);
await dd.getByLabel("Title").fill(`Diwali shoot plan ${stamp}`);
await dd.getByLabel("First message").fill("Please share the store photos and the offer details by Friday.");
await dd.getByRole("button", { name: "Start discussion" }).click();
await am.waitForURL(/\/team\/discussions\/.+/, { timeout: 15000 });
await am.getByText("Please share the store photos").first().waitFor({ timeout: 15000 });
check(true, "discussion opens with the first message");
await am.getByRole("button", { name: "Message actions" }).first().click();
check(await am.getByRole("menuitem", { name: "Create task" }).isVisible(), "message ⋯ offers Create task");
await am.getByRole("menuitem", { name: "Create request" }).click();
const rd = am.getByTestId("message-request-drawer");
await rd.waitFor();
if ((await rd.getByLabel("Service").inputValue()) === "") await rd.getByLabel("Service").selectOption({ index: 1 });
await rd.getByRole("button", { name: "Create request" }).click();
await rd.waitFor({ state: "detached", timeout: 15000 });
check(/request/i.test(await toast(am).innerText()), "request created from the message");
await shot(am, "comms-01-discussion");
const thread = am.url().split("/").pop();
const view = (await apiCall(am, "GET", `/ops/threads/${thread}`)).body;
const again = await apiCall(am, "POST", "/ops/messages/to-request", { messageId: view.messages[0].id, engagementId: client.engagements[0]?.id ?? "x", type: "change", description: "again please" });
check(again.status === 400, `the same message can't become two requests (${again.status})`);
noErrors(am, "am comms");

console.log("2. Sales adds a note on a lead from + New");
const sales = await as(browser, "sales@bmu.demo");
await go(sales, "/team/leads");
await sales.locator("[data-new-button]").click();
await sales.getByRole("menuitem", { name: /^Note/ }).click();
const nd = sales.getByTestId("client-note-drawer");
await nd.waitFor();
const leads = (await apiCall(sales, "GET", "/leads")).body.filter((l) => l.owner?.id && !["won", "lost"].includes(l.stage));
const mine = leads.find((l) => l.owner.name) ?? leads[0];
if (await nd.getByLabel("About").isVisible().catch(() => false)) await nd.getByLabel("About").selectOption("lead");
await nd.getByLabel("Lead").selectOption(mine.id);
await nd.getByRole("textbox", { name: "Note" }).fill(`Called back, wants a quote ${stamp}`);
await nd.getByRole("button", { name: "Save" }).click();
await nd.waitFor({ state: "detached", timeout: 15000 });
check(true, "note saved on the lead");
const s1 = await apiCall(sales, "POST", "/ops/announcements", { title: "Hello all", body: "Not allowed here", audience: "all_team", channels: ["in_app"] });
check(s1.status === 403, `sales cannot send announcements (${s1.status})`);
noErrors(sales, "sales");

console.log("3. Founder sends an announcement to one department");
const founder = await as(browser, "founder@bmu.demo");
await go(founder, "/team");
await founder.locator("[data-new-button]").click();
await founder.getByRole("menuitem", { name: /^Announcement/ }).click();
const ad = founder.getByTestId("announcement-drawer");
await ad.waitFor();
await ad.getByLabel("Audience").selectOption("department");
await ad.getByLabel("Department").selectOption({ index: 1 });
await ad.getByLabel("Title").fill(`Office closed Friday ${stamp}`);
await ad.getByLabel("Message").fill("The office is closed this Friday for Diwali. Deadlines have moved.");
founder.once("dialog", (d) => d.accept());
await ad.getByRole("button", { name: "Send announcement" }).click();
await ad.waitFor({ state: "detached", timeout: 15000 });
const sent = (await apiCall(founder, "GET", "/ops/announcements")).body.find((a) => a.title === `Office closed Friday ${stamp}`);
check(!!sent && sent.recipientCount > 0, `announcement sent to ${sent?.recipientCount ?? 0} people`);
noErrors(founder, "founder");

console.log("4. Admin: WhatsApp approval on templates, integrations");
const admin = await as(browser, "admin@bmu.demo");
await go(admin, "/admin/notification-templates");
const wa = admin.getByRole("checkbox", { name: /: WhatsApp$/ }).first();
check(await wa.isDisabled(), "WhatsApp can't be ticked before Meta approval");
await admin.getByLabel(/: WhatsApp approval$/).first().selectOption("approved");
check(await wa.isEnabled(), "WhatsApp can be ticked once approved");
await shot(admin, "admin-01-templates");
await go(admin, "/admin/integrations");
await admin.getByTestId("integration-switches").waitFor();
check((await admin.locator("[data-integration]").count()) > 0, "integrations connect / disconnect panel lists services");
const dis = await apiCall(admin, "POST", "/ops/admin/integrations/razorpay/disconnect", {});
check(dis.status === 400, `disconnect needs a reason (${dis.status})`);
noErrors(admin, "admin");

console.log("5. Department head's SOP goes to a Branch Manager to publish");
const head = await as(browser, "design.head@bmu.demo");
const meta = (await apiCall(head, "GET", "/admin-platform/sops/meta")).body;
const dept = meta.editableDepartmentIds?.[0];
if (dept) {
  const r = await apiCall(head, "POST", "/admin-platform/sops", { title: `Journey SOP ${stamp}`, departmentId: dept, body: "# Steps\n1. Check the brief\n2. Export at 1080px", status: "published" });
  check(r.status < 300 && /Admin/i.test(r.body.notice ?? ""), `SOP saved as a draft and sent to a Branch Manager (${r.body.notice ?? r.status})`);
} else check(true, "department head has no editable department (skipped)");
const h1 = await apiCall(head, "POST", "/ops/admin/integrations/email/connect");
check(h1.status === 403, `department head cannot connect integrations (${h1.status})`);

console.log("6. 390px");
const mob = await as(browser, "am@bmu.demo", { mobile: true });
await go(mob, "/team/discussions");
check(await noSideScroll(mob), "discussions page has no side scroll at 390px");
await shot(mob, "comms-02-mobile");

await browser.close();
done();
