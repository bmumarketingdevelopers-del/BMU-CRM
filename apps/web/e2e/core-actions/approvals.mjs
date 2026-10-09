// v11 core journey: approvals ("Needs you"). A producer asks for a new deadline and hands a task back ("Can't take
// this"); the Department Head sees the "Needs you" count in the top bar, approves one, rejects one with a reason and
// picks the new owner for the hand-back. The Command Centre queue lists them.
// BASE_URL=http://localhost:3000 node apps/web/e2e/core-actions/approvals.mjs
import { as, apiCall, check, dayAhead, done, go, launch, noErrors, shot, stamp, toast } from "./lib.mjs";

const browser = await launch();
const producer = await as(browser, "design@bmu.demo");
const head = await as(browser, "design.head@bmu.demo");
const me = (await apiCall(producer, "GET", "/tasks/form-options")).body.me;
const mk = async (title) => {
  const r = await apiCall(producer, "POST", "/tasks", { title, internal: true, departmentId: me.departmentId, ownerId: me.id, deadline: dayAhead(3) });
  if (r.status !== 201) throw new Error(`create failed: ${JSON.stringify(r.body)}`);
  return r.body.task;
};
const t1 = await mk(`Core approval one ${stamp}`);
const t2 = await mk(`Core approval two ${stamp}`);
const t3 = await mk(`Core hand back ${stamp}`);

console.log("1. Producer asks for a new deadline (no direct change)");
await go(producer, `/team/tasks/${t1.id}`);
check(!(await producer.getByRole("button", { name: "Reassign" }).isVisible()), "producer has no Reassign button");
await producer.getByRole("button", { name: "Ask for a new deadline" }).click();
const dd = producer.getByTestId("deadline-dialog");
await dd.getByRole("textbox", { name: "New deadline" }).fill(dayAhead(6));
await dd.getByLabel("Reason").fill("Waiting on client copy");
await dd.getByRole("button", { name: "Send request" }).click();
await toast(producer).waitFor();
check(/Request sent/.test(await toast(producer).innerText()), "request sent to the manager");
const still = (await apiCall(producer, "GET", `/tasks/${t1.id}`)).body;
check(still.deadline === t1.deadline, "deadline unchanged until approved");
await shot(producer, "approvals-01-request");
await apiCall(producer, "POST", `/tasks/${t2.id}/deadline`, { deadline: dayAhead(7), reason: "Second ask" });

console.log("2. Producer: Can't take this");
await go(producer, `/team/tasks/${t3.id}`);
await producer.getByRole("button", { name: "Can't take this" }).click();
const rd = producer.getByTestId("reason-dialog");
await rd.getByLabel("Why can't you take it").fill("Booked on a shoot all week");
await rd.getByRole("button", { name: "Send to my manager" }).click();
await toast(producer).waitFor();
noErrors(producer, "producer");

console.log("3. Head: Needs you");
await go(head, "/team");
await head.getByTestId("needs-you-link").waitFor({ timeout: 15000 });
check(await head.getByTestId("needs-you-link").isVisible(), "Needs you count in the top bar");
await head.getByTestId("needs-you-link").click();
await head.waitForURL(/\/team\/approvals/);
const box = head.getByTestId("approvals-mine").first();
await box.getByText(`Core approval one ${stamp}`).first().waitFor({ timeout: 15000 });
await shot(head, "approvals-02-needs-you");
const card1 = box.locator("li", { hasText: `Core approval one ${stamp}` }).first();
await card1.getByRole("button", { name: "Approve" }).click();
await head.getByTestId("decide-dialog").getByRole("button", { name: "Approve" }).click();
await head.getByTestId("decide-dialog").waitFor({ state: "detached", timeout: 15000 });
const after = (await apiCall(head, "GET", `/tasks/${t1.id}`)).body;
check(after.deadline !== t1.deadline, "approved: the deadline moved");

const card2 = box.locator("li", { hasText: `Core approval two ${stamp}` }).first();
await card2.getByRole("button", { name: "Reject" }).click();
const rej = head.getByTestId("decide-dialog");
await rej.getByRole("button", { name: "Reject" }).click();
check(await rej.getByRole("alert").isVisible(), "rejecting needs a reason");
await rej.getByLabel("Decision note").fill("Keep the date, the client launch is fixed");
await rej.getByRole("button", { name: "Reject" }).click();
await rej.waitFor({ state: "detached", timeout: 15000 });
const t2now = (await apiCall(head, "GET", `/tasks/${t2.id}`)).body;
check(t2now.deadline === t2.deadline, "rejected: the deadline stays");

const card3 = box.locator("li", { hasText: `Core hand back ${stamp}` }).first();
await card3.getByRole("button", { name: "Approve" }).click();
const hb = head.getByTestId("decide-dialog");
await hb.locator("[data-person='Zoya Mirza']").click();
await hb.getByRole("button", { name: "Approve" }).click();
await hb.waitFor({ state: "detached", timeout: 15000 });
const t3now = (await apiCall(head, "GET", `/tasks/${t3.id}`)).body;
check(t3now.owner?.name === "Zoya Mirza", "hand-back approved: Zoya owns it");
noErrors(head, "head");

console.log("4. Command Centre queue");
await go(head, "/admin/approvals");
await head.getByTestId("approvals-all").waitFor();
await head.getByTestId("approvals-all").getByLabel("Status").selectOption("");
await head.getByTestId("approvals-all").getByText(`Core approval two ${stamp}`).first().waitFor({ timeout: 15000 });
check(true, "queue lists decided requests");
check(await head.getByRole("link", { name: "Approvals", exact: true }).first().isVisible(), "Approvals in the Command Centre menu");
await shot(head, "approvals-03-queue");
noErrors(head, "head queue");

for (const t of [t1, t2, t3]) await apiCall(head, "POST", `/tasks/${t.id}/archive`, { reason: "Journey clean-up" });
await browser.close();
done();
