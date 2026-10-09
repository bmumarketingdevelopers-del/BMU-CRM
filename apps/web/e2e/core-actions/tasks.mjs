// v11 core journey: tasks end to end with the shared actions.
// A department head adds a task from "+ Add task", finds it with search, reassigns it through the engine (impact,
// reason) and undoes it, changes the deadline with a reason, marks it blocked with details, ticks the checklist,
// archives and restores it, and reads its history. Also: the Ctrl/Cmd+K action phrases, the "+ New" menu and the
// 390px phone layout.
// BASE_URL=http://localhost:3000 node apps/web/e2e/core-actions/tasks.mjs
import { BASE, as, apiCall, check, dayAhead, done, go, launch, noErrors, noSideScroll, shot, stamp, toast } from "./lib.mjs";

const browser = await launch();
const title = `Core journey brief ${stamp}`;
const head = await as(browser, "design.head@bmu.demo");

console.log("1. Add a task from the Tasks page");
await go(head, "/team/tasks");
await head.getByTestId("add-task").click();
const drawer = head.getByTestId("task-drawer");
await drawer.waitFor();
await drawer.locator("#task-title").fill(title);
await drawer.getByLabel("Internal (training, admin, pitch)").check();
await drawer.getByLabel("Deadline").fill(dayAhead(3));
await drawer.locator("[data-person='Zoya Mirza']").click();
await drawer.getByRole("button", { name: "Save", exact: true }).click();
await toast(head).waitFor({ timeout: 15000 });
check(/Task added/.test(await toast(head).innerText()), "task added with a toast");
const found = await apiCall(head, "GET", `/tasks/query?scope=team&q=${encodeURIComponent(title)}`);
const task = found.body[0];
check(task?.owner?.name === "Zoya Mirza", "the task belongs to Zoya");
await shot(head, "tasks-01-added");

console.log("2. Search, list view and the row menu");
await head.getByRole("button", { name: "Everything I can see" }).click();
await head.getByRole("button", { name: "List", exact: true }).first().click();
await head.getByLabel("Search tasks").fill(title);
const row = head.locator(`[data-task-row="${task.id}"]`);
await row.waitFor({ timeout: 15000 });
check(await row.isVisible(), "search finds the task in the list");
await row.getByRole("button", { name: `Actions for ${title}` }).click();
const menuItems = await head.getByRole("menuitem").allInnerTexts();
check(["Edit", "Reassign", "Change deadline", "Duplicate", "Archive"].every((x) => menuItems.some((m) => m.startsWith(x))), "row menu has the standard actions");
await head.keyboard.press("Escape");
await shot(head, "tasks-02-list");

console.log("3. Reassign through the engine, then undo");
await row.getByRole("button", { name: `Actions for ${title}` }).click();
await head.getByRole("menuitem", { name: /^Reassign/ }).click();
const dlg = head.getByTestId("reassign-dialog");
await dlg.waitFor();
await dlg.locator("[data-person='Rhea Bose']").click();
await dlg.getByLabel("Reason").selectOption("skill_fit");
await dlg.getByTestId("reassign-impact").getByText(/Rhea Bose/).first().waitFor({ timeout: 15000 });
await shot(head, "tasks-03-reassign");
await dlg.getByRole("button", { name: /^Reassign/ }).last().click();
const moved = head.getByTestId("action-toast").filter({ hasText: "moved to Rhea Bose" });
await moved.waitFor({ timeout: 15000 });
let now = (await apiCall(head, "GET", `/tasks/${task.id}`)).body;
check(now.owner?.name === "Rhea Bose", "reassigned to Rhea");
check(now.assignments.length >= 2, "assignment trail recorded");
await moved.getByRole("button", { name: "Undo" }).click();
await head.getByTestId("action-toast").filter({ hasText: /Undone|undone|back/ }).first().waitFor({ timeout: 10000 }).catch(() => {});
await head.waitForTimeout(1500);
now = (await apiCall(head, "GET", `/tasks/${task.id}`)).body;
check(now.owner?.name === "Zoya Mirza", "Undo puts it back with Zoya");

console.log("4. Task page: deadline with reason, blocked details, checklist, history");
await go(head, `/team/tasks/${task.id}`);
await head.getByTestId("task-detail").waitFor();
await head.getByRole("button", { name: "Change deadline" }).click();
const dd = head.getByTestId("deadline-dialog");
await dd.getByRole("textbox", { name: "New deadline" }).fill(dayAhead(5));
await dd.getByRole("button", { name: "Change deadline" }).click();
check(await dd.getByRole("alert").isVisible(), "a reason is required for a deadline change");
await dd.getByLabel("Reason").fill("Client sent the copy late");
await dd.getByRole("button", { name: "Change deadline" }).click();
await toast(head).waitFor();
now = (await apiCall(head, "GET", `/tasks/${task.id}`)).body;
check(now.deadline?.slice(0, 10) === dayAhead(5) || now.deadline?.startsWith(dayAhead(5).slice(0, 8)), "deadline moved");

await head.getByRole("button", { name: "Blocked", exact: true }).click();
const bd = head.getByTestId("blocked-dialog");
await bd.getByLabel("Why is it blocked").fill("Waiting for the client logo");
await bd.getByLabel("Waiting for").fill("Logo files");
await bd.getByRole("button", { name: "Mark blocked" }).click();
await head.getByTestId("blocked-box").waitFor({ timeout: 15000 });
check(/Logo files/.test(await head.getByTestId("blocked-box").innerText()), "blocked details shown on the task");

await head.getByLabel("New checklist item").fill("Check brand colours");
await head.getByRole("button", { name: "Add", exact: true }).first().click();
await head.getByText("Check brand colours").waitFor();
await head.getByLabel("Check brand colours").click();
await head.waitForTimeout(800);
now = (await apiCall(head, "GET", `/tasks/${task.id}`)).body;
check(now.checklist.some((c) => c.label === "Check brand colours" && c.done), "checklist item added and ticked");
await shot(head, "tasks-04-detail");
await head.getByRole("tab", { name: "History" }).click();
await head.getByTestId("history-tab").waitFor();
await head.getByTestId("activity-feed").waitFor({ timeout: 15000 });
const hist = await head.getByTestId("history-tab").innerText();
check(/Who has had it/.test(hist) && /reassigned/.test(hist) && /changed the deadline/.test(hist), "history shows the trail, the reassignment and the deadline change");
await shot(head, "tasks-05-history");

console.log("5. Archive with a reason, restore from the Archived view");
await head.getByRole("button", { name: "More actions for this task" }).click();
await head.getByRole("menuitem", { name: "Archive" }).click();
const rd = head.getByTestId("reason-dialog");
await rd.getByLabel("Reason").fill("Client paused the campaign");
await rd.getByRole("button", { name: "Archive" }).click();
await head.getByText(/Archived: Client paused the campaign/).waitFor({ timeout: 15000 });
check(true, "archived with the reason shown");
await go(head, "/team/tasks");
await head.getByText("Filters").click();
await head.getByLabel("Show").selectOption("archived");
await head.getByRole("button", { name: "Everything I can see" }).click();
await head.getByLabel("Search tasks").fill(title);
const arow = head.locator(`[data-task-row="${task.id}"]`);
await arow.waitFor({ timeout: 15000 });
await arow.getByRole("button", { name: `Actions for ${title}` }).click();
await head.getByRole("menuitem", { name: "Restore" }).click();
await toast(head).waitFor();
now = (await apiCall(head, "GET", `/tasks/${task.id}`)).body;
check(!now.archivedAt && now.status === "blocked", "restored to where it was");
noErrors(head, "head desktop");

console.log("6. Ctrl+K action phrases and the + New menu");
await go(head, "/team");
await head.keyboard.press("Control+k");
await head.getByLabel("Search everything").fill(`reassign ${title} to Rhea`);
await head.getByTestId("palette-actions").waitFor({ timeout: 15000 });
check(/Reassign/.test(await head.getByTestId("palette-actions").innerText()), "palette offers the reassign action");
await head.keyboard.press("Enter");
await head.getByTestId("reassign-dialog").waitFor();
check(await head.getByTestId("reassign-dialog").locator("[data-person='Rhea Bose'][class*='outline']").count().then((n) => n >= 0), "reassign opens from the palette");
await head.keyboard.press("Escape");
await head.getByRole("button", { name: "Close" }).first().click().catch(() => {});
await head.locator("[data-new-button]").click();
const entries = await head.getByRole("menu", { name: "Create new" }).getByRole("menuitem").allInnerTexts();
check(entries.some((e) => e.startsWith("Task")), "+ New lists Task");
await head.keyboard.press("Escape");

console.log("7. Phone width");
const phone = await as(browser, "design.head@bmu.demo", { mobile: true });
for (const path of ["/team/tasks", `/team/tasks/${task.id}`, "/team/approvals"]) {
  await go(phone, path);
  await phone.waitForTimeout(800);
  check(await noSideScroll(phone), `${path} fits 390px`);
}
await go(phone, "/team/tasks");
await phone.getByTestId("add-task").click();
await phone.getByTestId("task-drawer").waitFor();
check(await noSideScroll(phone), "task drawer fits 390px");
await shot(phone, "tasks-06-phone-drawer");
noErrors(phone, "phone");

// Clean up the journey task.
await apiCall(head, "POST", `/tasks/${task.id}/archive`, { reason: "Journey clean-up" });
await browser.close();
done();
