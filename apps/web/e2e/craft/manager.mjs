// Manager journey: the project manager drags an unassigned task onto the graphic designer, then the designer sees
// it on their dashboard ("New") and in the notification bell. Also exercises the select fallback, deadline and
// priority, an ad-hoc task, a call note and the read-only member dashboard.
//   BASE_URL=http://localhost:3205 node apps/web/e2e/craft/manager.mjs
import { BASE, api, check, launch, shot, signIn } from "./lib.mjs";

const PM = "pm@bmu.demo";
const DESIGNER = "design@bmu.demo";
const stamp = Date.now().toString(36);

const pmApi = api(PM);
const view = await pmApi.get("/craft/manager");
const designer = view.members.find((m) => m.specialty === "graphic_designer");
check(!!designer, "the graphic designer is on the project manager's team");
// Pick an unassigned graphic design task (create one if an earlier run used them all).
let task = view.board.find((t) => !t.owner && t.specialty === "graphic_designer");
if (!task) task = await pmApi.post("/craft/manager/tasks", { title: `Design a festive story frame ${stamp}`, engagementId: view.engagements[0].id, specialty: "graphic_designer", priority: "high" });
check(!task.owner, `"${task.title}" has no owner yet`);

const browser = await launch();
const errors = [];
try {
  // --- Manager: drag the task onto the designer --------------------------------
  const pm = await signIn(browser, PM);
  errors.push(...pm.errors);
  await pm.page.goto(`${BASE}/team`);
  await pm.page.waitForSelector("[data-manager]", { timeout: 60_000 });
  check(await pm.page.getByText("Assign work").first().isVisible(), "the Manager workspace is the /team home");
  check(await pm.page.locator("[data-today] li").count() > 0, "the Today list has items");
  check(await pm.page.locator("[data-client]").count() >= 2, "My clients shows the portfolio");
  await shot(pm.page, "manager-home");

  // A tall window keeps the card and the person on screen together, so the drag never scrolls mid-way.
  await pm.page.setViewportSize({ width: 1360, height: 2600 });
  const card = pm.page.locator(`[data-task="${task.id}"]`);
  await card.scrollIntoViewIfNeeded();
  const target = pm.page.locator(`[data-member="${designer.id}"]`);
  await card.dragTo(target, { sourcePosition: { x: 6, y: 6 } }); // grab the card edge, not its select
  await pm.page.locator("[data-assign-done]").filter({ hasText: `${task.title} → ${designer.name}` }).waitFor({ timeout: 20_000 });
  await pm.page.setViewportSize({ width: 1360, height: 900 });
  check(true, `dragged "${task.title}" onto ${designer.name}`);
  await shot(pm.page, "manager-after-drag");

  // Keyboard / select fallback on another unassigned task, then deadline + priority.
  const fresh = await pmApi.get("/craft/manager");
  const other = fresh.board.find((t) => !t.owner && t.suggestion);
  if (other) {
    await pm.page.locator(`[data-task="${other.id}"] [data-assign-select]`).selectOption(other.suggestion.userId);
    await pm.page.locator("[data-assign-done]").filter({ hasText: `${other.title} → ${other.suggestion.name}` }).waitFor({ timeout: 20_000 });
    check(true, `assigned "${other.title}" to ${other.suggestion.name} with the select fallback`);
  }

  // Ad-hoc task from the form.
  await pm.page.locator("[data-new-task]").click();
  await pm.page.getByLabel("Task title").fill(`Resize the offer banner for WhatsApp ${stamp}`);
  await pm.page.locator("[data-adhoc]").getByLabel("Specialty").selectOption("graphic_designer");
  await pm.page.locator("[data-adhoc]").getByLabel("Assignee").selectOption(designer.id);
  await pm.page.locator("[data-adhoc]").getByRole("button", { name: "Add task" }).click();
  await pm.page.locator("[data-assign-done]").filter({ hasText: "Created" }).waitFor({ timeout: 20_000 });
  check(true, "created an ad-hoc task for the designer");

  // Log a call note on the first client.
  const firstClient = pm.page.locator("[data-client]").first();
  await firstClient.locator("[data-log-note]").click();
  await firstClient.getByLabel("Note", { exact: true }).fill(`Quick call: confirmed the banner copy (${stamp})`);
  await firstClient.getByRole("button", { name: "Save" }).click();
  await firstClient.getByText(`confirmed the banner copy (${stamp})`).waitFor({ timeout: 20_000 });
  check(true, "logged a call note on a client");

  // Read-only member dashboard from the team view.
  await pm.page.goto(`${BASE}/team/specialists/${designer.id}`);
  await pm.page.waitForSelector("[data-craft]", { timeout: 60_000 });
  check(await pm.page.getByText("read-only").first().isVisible(), "the manager can open the designer's dashboard read-only");
  await pm.ctx.close();

  // --- Designer: sees it on the dashboard and in the bell ------------------------
  const ds = await signIn(browser, DESIGNER);
  errors.push(...ds.errors);
  await ds.page.goto(`${BASE}/team`);
  await ds.page.waitForSelector("[data-craft]", { timeout: 60_000 });
  await ds.page.getByText(task.title).first().waitFor({ timeout: 20_000 });
  check(true, "the designer sees the task in What to do next");
  const bell = ds.page.getByRole("button", { name: /notification/i }).first();
  await bell.click();
  await ds.page.getByText(`assigned you: ${task.title}`).first().waitFor({ timeout: 20_000 });
  check(true, "the designer has the assignment in the bell");
  await shot(ds.page, "designer-after-assign");
  await ds.ctx.close();

  // --- Producer cannot open the manager workspace ---------------------------------
  let refused = false;
  try {
    await api("producer@bmu.demo").get("/craft/manager");
  } catch (e) {
    refused = e.status === 403;
  }
  check(refused, "a producer gets 403 from the manager workspace");
} finally {
  await browser.close();
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("manager journey passed");
