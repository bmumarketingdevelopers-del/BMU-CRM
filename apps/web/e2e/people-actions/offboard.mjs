// v11 people journey: offboarding. An Admin starts offboarding from the Users list; it can't finish while the person
// owns open work (blockers listed), the work moves through the reassign engine, the checklist (assets, access) is
// ticked, then the final confirmation. HR's confirmation goes to an Admin. Someone whose last day has passed loses
// sign-in and shows under "Former" on the tree.
// BASE_URL=http://localhost:3000 node apps/web/e2e/people-actions/offboard.mjs
import { BASE, apiCall, as, check, cleanUp, dayAhead, done, go, journeyEmail, journeyPhone, launch, noErrors, shot, stamp, toast } from "./lib.mjs";

const browser = await launch();
const admin = await as(browser, "admin@bmu.demo");
await go(admin, "/admin/users");
const opts = (await apiCall(admin, "GET", "/people-actions/options")).body;
const design = opts.departments.find((d) => d.name === "Creative / Design");
const producerRole = opts.roles.find((r) => r.baseRole === "producer");
const add = async (tag, n) => {
  const r = await apiCall(admin, "POST", "/people-actions/people", { name: `Journey Leaver ${tag} ${stamp}`, phone: journeyPhone(n), email: journeyEmail(`leaver-${tag}`), roleIds: [producerRole.id], departmentId: design.id, teamId: design.teams[0]?.id ?? null, managerId: design.headId, branchId: design.branchId, joiningDate: dayAhead(0), employmentType: "full_time", sendInvite: false });
  // They accepted the invite (only active people can own work).
  await apiCall(admin, "PATCH", `/org/users/${r.body.id}`, { status: "active" });
  return r.body.id;
};

console.log("1. Set up a leaver who owns a task");
const leaverId = await add("a", 11);
check(!!leaverId, "leaver added");
const taskOpts = (await apiCall(admin, "GET", "/tasks/form-options")).body;
const task = await apiCall(admin, "POST", "/tasks", { title: `Leaver task ${stamp}`, internal: true, departmentId: design.id, ownerId: leaverId, deadline: dayAhead(4) });
check(task.status === 201, `task assigned to the leaver${task.status === 201 ? "" : ` (${task.status} ${JSON.stringify(task.body).slice(0, 160)})`}`);

console.log("2. Start offboarding from the Users list");
await go(admin, `/admin/users`);
await admin.getByLabel("Search people").fill(`Journey Leaver a ${stamp}`);
const row = admin.locator(`[data-person-row="${leaverId}"]`);
await row.waitFor({ timeout: 15000 });
await row.getByRole("button", { name: /^Actions for/ }).click();
await admin.getByRole("menuitem", { name: /^Offboard/ }).click();
const dlg = admin.getByTestId("offboard-dialog");
await dlg.waitFor();
await admin.locator("#ob-reason").fill("Moving cities");
await dlg.getByRole("button", { name: "Start offboarding" }).click();
await admin.getByTestId("offboard-blockers").waitFor({ timeout: 15000 });
const blockers = await admin.getByTestId("offboard-blockers").innerText();
check(/Still owns/.test(blockers) && /task/.test(blockers), "blocked: still owns a task");
check(await dlg.getByRole("button", { name: "Confirm offboarding" }).isDisabled(), "confirm is disabled while blocked");
await shot(admin, "offboard-01-blocked");
const forced = await apiCall(admin, "POST", `/people-actions/people/${leaverId}/offboard/confirm`);
check(forced.status === 400 || forced.status === 409, `API refuses to finish while they own work (${forced.status})`);
await dlg.getByRole("button", { name: "Close", exact: true }).last().click();

console.log("3. Move their work, tick the checklist, confirm");
const zoya = taskOpts.people.find((p) => p.name === "Zoya Mirza");
const re = await apiCall(admin, "POST", "/actions/reassign/task/apply", { ids: [task.body.task.id], toUserId: zoya.id, reason: "offboarding" });
check(re.status === 201 || re.status === 200, `task reassigned through the engine${re.status < 300 ? "" : ` (${re.status} ${JSON.stringify(re.body).slice(0, 160)})`}`);
const st = (await apiCall(admin, "GET", `/people-actions/people/${leaverId}/offboarding`)).body;
const proc = (await apiCall(admin, "GET", `/team-flows/people/${st.processId}`)).body;
for (const i of proc.items.filter((x) => !x.done && !x.auto)) await apiCall(admin, "POST", `/team-flows/people/${st.processId}/tick`, { key: i.key, done: true });
await row.getByRole("button", { name: /^Actions for/ }).click();
await admin.getByRole("menuitem", { name: /^Offboard/ }).click();
await dlg.waitFor();
const confirm = dlg.getByRole("button", { name: "Confirm offboarding" });
await confirm.waitFor();
await admin.waitForFunction(() => !document.querySelector('[data-testid="offboard-blockers"]'), null, { timeout: 15000 }).catch(() => {});
check(await confirm.isEnabled(), "nothing left: confirm is enabled");
await shot(admin, "offboard-02-ready");
await confirm.click();
await dlg.waitFor({ state: "detached", timeout: 15000 }).catch(async () => console.log(`  dialog says: ${(await dlg.innerText()).slice(-300)}`));
check(/confirmed|offboard/i.test(await toast(admin).innerText()), "toast confirms");
const after = (await apiCall(admin, "GET", `/people-actions/people/${leaverId}/offboarding`)).body;
check(after.status === "done", `offboarding confirmed (${JSON.stringify(after).slice(0, 300)})`);
const person = (await apiCall(admin, "GET", `/people-actions/people/${leaverId}`)).body;
check(person.leftAt === null && person.status !== "suspended", "last day is today: they can still sign in until the end of the day");
noErrors(admin, "admin offboarding");

console.log("4. HR's confirmation goes to an Admin; past last day → Former");
const pastId = await add("b", 12);
const hr = await as(browser, "hr@bmu.demo");
const yesterday = new Date(Date.now() + 5.5 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
const started = await apiCall(hr, "POST", `/people-actions/people/${pastId}/offboard`, { lastDay: yesterday, reason: "Contract ended" });
check(started.status < 300, `HR starts offboarding (${started.status} ${JSON.stringify(started.body).slice(0, 200)})`);
const proc2 = (await apiCall(hr, "GET", `/team-flows/people/${started.body.processId}`)).body;
for (const i of proc2.items.filter((x) => !x.done && !x.auto)) await apiCall(hr, "POST", `/team-flows/people/${started.body.processId}/tick`, { key: i.key, done: true });
const hrConfirm = await apiCall(hr, "POST", `/people-actions/people/${pastId}/offboard/confirm`);
check(hrConfirm.body.outcome === "approval", "HR's final confirmation becomes an approval for an Admin");
const appr = await apiCall(admin, "POST", `/actions/approvals/${hrConfirm.body.approval.id}/decide`, { decision: "approve" });
check(appr.status === 201 || appr.status === 200, "Admin approves");
await apiCall(admin, "POST", "/people-actions/jobs/run");
const gone = (await apiCall(admin, "GET", `/people-actions/people/${pastId}`)).body;
check(!!gone.leftAt && gone.status === "suspended", "sign-in disabled after the last day");
await go(admin, "/admin/hierarchy");
await admin.getByTestId("former-list").waitFor({ timeout: 15000 });
await admin.getByTestId("former-list").locator("summary").click();
check(await admin.getByTestId("former-list").getByText(`Journey Leaver b ${stamp}`).isVisible(), "shows under Former on the tree");
await shot(admin, "offboard-03-former");
noErrors(admin, "former");
noErrors(hr, "hr");

await apiCall(admin, "POST", `/tasks/${task.body.task.id}/archive`, { reason: "Journey clean-up" });
await cleanUp();
console.log(`(base ${BASE})`);
await browser.close();
done();
