// v11 core journey: forbidden roles. Producers see no manager actions (reassign, archive, import, templates,
// recurring) and the API refuses them; client accounts can't reach team tasks or any action endpoint; the
// Command Centre approvals queue is closed to producers.
// BASE_URL=http://localhost:3000 node apps/web/e2e/core-actions/forbidden.mjs
import { BASE, as, apiCall, check, dayAhead, done, go, launch, noErrors, shot, stamp } from "./lib.mjs";

const browser = await launch();

console.log("1. Producer on the Tasks page");
const producer = await as(browser, "design@bmu.demo");
const opts = (await apiCall(producer, "GET", "/tasks/form-options")).body;
check(opts.canAssignOthers === false, "producer can't assign others");
const own = await apiCall(producer, "POST", "/tasks", { title: `Core forbidden own ${stamp}`, internal: true, departmentId: opts.me.departmentId, ownerId: opts.me.id, deadline: dayAhead(3) });
check(own.status === 201, "producer adds a task for themselves");
await go(producer, "/team/tasks");
for (const name of ["From template", "Import", "Recurring"]) check(!(await producer.getByRole("button", { name, exact: true }).isVisible()), `no "${name}" button`);
await producer.getByRole("button", { name: "List", exact: true }).first().click();
await producer.getByLabel("Search tasks").fill(`Core forbidden own ${stamp}`);
const row = producer.locator(`[data-task-row="${own.body.task.id}"]`);
await row.waitFor({ timeout: 15000 });
await row.getByRole("button", { name: /^Actions for/ }).click();
const items = await producer.getByRole("menuitem").allInnerTexts();
check(!items.some((i) => i.startsWith("Reassign") || i.startsWith("Archive") || i.startsWith("Change deadline")), "row menu has no reassign, archive or change deadline");
check(items.some((i) => i.startsWith("Ask for a new deadline")) && items.some((i) => i.startsWith("Can't take this")), "row menu offers the producer's own actions");
await producer.keyboard.press("Escape");
await shot(producer, "forbidden-01-producer-menu");

console.log("2. Producer: the API says no");
const zoya = opts.people.find((p) => p.name === "Zoya Mirza");
const other = await apiCall(producer, "POST", "/tasks", { title: `Core forbidden other ${stamp}`, internal: true, departmentId: opts.me.departmentId, ownerId: zoya.id, deadline: dayAhead(3) });
check(other.status === 403, "can't add a task for someone else");
const re = await apiCall(producer, "POST", "/actions/reassign/task/apply", { ids: [own.body.task.id], toUserId: zoya.id, reason: "overload" });
check(re.status === 403, "can't reassign");
check((await apiCall(producer, "GET", "/actions/approvals?box=all")).status === 403, "can't read the approvals queue");
check((await apiCall(producer, "POST", `/tasks/${own.body.task.id}/archive`, { reason: "Trying it" })).status === 403, "can't archive");
check((await apiCall(producer, "GET", "/imports")).body.length === 0, "no import entities offered");
await go(producer, "/admin/approvals");
check(!new URL(producer.url()).pathname.startsWith("/admin"), "Command Centre approvals is closed to producers");
noErrors(producer, "producer");

console.log("3. Client accounts");
const client = await as(browser, "client@sunrise.demo");
await go(client, "/team/tasks");
check(!new URL(client.url()).pathname.startsWith("/team"), "client is sent away from team tasks");
check(!(await client.locator("[data-new-button]").count()), "client sees no + New");
for (const path of ["/tasks/query", "/actions/approvals", "/actions/palette?q=new%20task", "/imports"]) check((await apiCall(client, "GET", path)).status === 403, `client GET ${path} is 403`);
noErrors(client, "client");

await apiCall(producer, "POST", `/tasks/${own.body.task.id}/archive`, { reason: "x" }).catch(() => {});
// Producers can't archive; a manager tidies the journey task.
const head = await as(browser, "design.head@bmu.demo");
await apiCall(head, "POST", `/tasks/${own.body.task.id}/archive`, { reason: "Journey clean-up" });
console.log(`(base ${BASE})`);
await browser.close();
done();
