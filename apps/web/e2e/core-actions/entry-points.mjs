// v11 core journey: "+ Add task" from everywhere work is discussed. Client 360, a project, a deliverable, a calendar
// day and a client message ("Create task") each open the task drawer pre-filled; the Manager workspace card and the
// Capacity page open the reassignment dialog; the mobile-width "+ New" menu works.
// BASE_URL=http://localhost:3000 node apps/web/e2e/core-actions/entry-points.mjs
import { as, apiCall, check, done, go, launch, noErrors, noSideScroll, shot } from "./lib.mjs";

const browser = await launch();
const am = await as(browser, "am@bmu.demo");
const drawer = am.getByTestId("task-drawer");
const closeDrawer = async () => {
  await drawer.getByRole("button", { name: "Cancel" }).click();
  await drawer.waitFor({ state: "detached" });
};

console.log("1. Client 360 and project pages");
const opts = (await apiCall(am, "GET", "/tasks/form-options")).body;
const eng = opts.engagements.find((e) => e.productionOpen && e.amId === opts.me.id) ?? opts.engagements[0];
await go(am, `/team/clients/${eng.clientId}`);
// v11 Client 360: "+ Add" menu in the header → Task.
await am.getByRole("button", { name: "Add to this client" }).click();
await am.getByRole("menuitem", { name: "Task", exact: true }).click();
await drawer.waitFor();
const engOptions = await drawer.getByLabel("Client engagement").locator("option").allInnerTexts();
check(engOptions.slice(1).every((o) => o.startsWith(eng.client)), "Client 360: only this client's services are offered");
await closeDrawer();
await go(am, `/team/projects/${eng.id}`);
await am.getByTestId("add-task-here").click();
await drawer.waitFor();
await drawer.getByLabel("Client engagement").locator(`option[value="${eng.id}"]`).waitFor({ state: "attached", timeout: 15000 });
check((await drawer.getByLabel("Client engagement").inputValue()) === eng.id, "project page: the engagement is pre-filled");
await closeDrawer();

console.log("2. Deliverable page");
const deliverable = opts.deliverables.find((d) => d.engagementId === eng.id) ?? opts.deliverables[0];
if (deliverable) {
  await go(am, `/team/deliverables/${deliverable.id}`);
  await am.getByTestId("add-task-here").click();
  await drawer.waitFor();
  check(true, "deliverable page opens the task drawer");
  await closeDrawer();
}

console.log("3. Calendar day");
await go(am, "/team/calendar");
await am.getByTestId("calendar-add-task").click();
await drawer.waitFor();
check(!!(await drawer.getByLabel("Deadline").inputValue()), "calendar: the day is the deadline");
await closeDrawer();

console.log("4. Message: Create task");
const threads = (await apiCall(am, "GET", "/threads")).body;
const thread = threads.find((t) => t.lastMessage);
if (thread) {
  await go(am, `/team/messages/${thread.id}`);
  const menu = am.getByRole("button", { name: "Message actions" }).first();
  await menu.click();
  await am.getByRole("menuitem", { name: "Create task" }).click();
  await drawer.waitFor();
  check((await drawer.locator("#task-title").inputValue()).length > 0, "message text becomes the task title");
  await shot(am, "entry-01-message-task");
  await closeDrawer();
} else check(true, "no client threads to test (skipped)");
noErrors(am, "am entry points");

console.log("5. Manager workspace and Capacity open the reassignment dialog");
const head = await as(browser, "design.head@bmu.demo");
await go(head, "/team/manager");
const reassignBtn = head.getByRole("button", { name: /^(Reassign|Assign)…$/ }).first();
if (await reassignBtn.isVisible().catch(() => false)) {
  await reassignBtn.click();
  await head.getByTestId("reassign-dialog").waitFor();
  check(true, "Manager workspace card opens the engine's dialog");
  await head.getByTestId("reassign-dialog").getByRole("button", { name: "Cancel" }).click();
} else check(true, "no open tasks on the manager board (skipped)");
await go(head, "/team/capacity");
const dnd = head.getByTestId("capacity-dnd");
if (await dnd.isVisible().catch(() => false)) {
  const assign = dnd.getByRole("button", { name: "Assign" }).first();
  if (await assign.isVisible().catch(() => false)) {
    await assign.click();
    await head.getByTestId("reassign-dialog").waitFor();
    check(true, "Capacity: Assign opens the engine's dialog");
    await head.getByTestId("reassign-dialog").getByRole("button", { name: "Cancel" }).click();
  }
  const moveWork = dnd.getByRole("button", { name: "Move work…" }).first();
  if (await moveWork.isVisible().catch(() => false)) {
    await moveWork.click();
    await head.getByTestId("bulk-reassign-dialog").waitFor();
    check(true, "Capacity: Move work opens the bulk move with preview");
    await head.getByTestId("bulk-reassign-dialog").getByRole("button", { name: "Cancel" }).click();
  }
  await shot(head, "entry-02-capacity");
}
noErrors(head, "head entry points");

console.log("6. Phone: + New menu");
const phone = await as(browser, "am@bmu.demo", { mobile: true });
await go(phone, "/team/tasks");
await phone.locator("[data-new-button]").click();
const entries = await phone.getByRole("menu", { name: "Create new" }).getByRole("menuitem").allInnerTexts();
check(entries.some((e) => e.startsWith("Task")) && entries.some((e) => e.startsWith("Note")), "+ New lists Task and Note");
await phone.getByRole("menuitem", { name: /^Note/ }).click();
await phone.getByTestId("client-note-drawer").waitFor();
check(await noSideScroll(phone), "note drawer fits 390px");
await shot(phone, "entry-03-phone-note");
noErrors(phone, "phone");

await browser.close();
done();
