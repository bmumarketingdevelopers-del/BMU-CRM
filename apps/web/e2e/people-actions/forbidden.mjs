// v11 people journey: forbidden roles. Producers and clients can't reach the tree or any people action. HR can add
// people but not change roles or make a Branch Manager. A Department Head's add and cross-department move become approvals
// for a Branch Manager, and they can't touch other departments. Making someone a Branch Manager needs the Founder.
// BASE_URL=http://localhost:3000 node apps/web/e2e/people-actions/forbidden.mjs
import { BASE, apiCall, as, check, cleanUp, dayAhead, done, go, journeyEmail, journeyPhone, launch, noErrors, shot, stamp } from "./lib.mjs";

const browser = await launch();
const admin = await as(browser, "admin@bmu.demo");
await go(admin, "/admin/users");
const opts = (await apiCall(admin, "GET", "/people-actions/options")).body;
const role = (b) => opts.roles.find((r) => r.baseRole === b);
const dept = (n) => opts.departments.find((d) => d.name === n);
const design = dept("Creative / Design");
const strategy = dept("Strategy");
const people = (await apiCall(admin, "GET", "/people-actions/people")).body;
const who = (email) => people.find((p) => p.email === email);
const rhea = who("design@bmu.demo");
const priya = who("sales@bmu.demo");
const newPerson = (tag, n, roleId, d = design) => ({ name: `Journey Forbidden ${tag} ${stamp}`, phone: journeyPhone(n), email: journeyEmail(`forbidden-${tag}`), roleIds: [roleId], departmentId: d.id, teamId: d.teams.length ? d.teams[0].id : null, managerId: d.headId ?? who("admin@bmu.demo").id, branchId: d.branchId, joiningDate: dayAhead(1), employmentType: "full_time", sendInvite: false });
const cleanupApprovals = [];

console.log("1. Producer");
const producer = await as(browser, "producer@bmu.demo");
await go(producer, "/admin/hierarchy");
check(!new URL(producer.url()).pathname.startsWith("/admin"), "the tree is closed to producers");
check((await apiCall(producer, "GET", "/people-actions/tree")).status === 403, "API: tree 403");
check((await apiCall(producer, "POST", "/people-actions/people", newPerson("p", 21, role("producer").id))).status === 403, "API: can't add people");
check((await apiCall(producer, "POST", `/people-actions/people/${rhea.id}/move`, { departmentId: strategy.id, effectiveDate: dayAhead(0), reason: "nope" })).status === 403, "API: can't move people");
const self = await apiCall(producer, "PATCH", `/people-actions/people/${who("producer@bmu.demo").id}`, { name: "Someone Else" });
check(self.status === 400 || self.status === 403, "editing themselves: can't change their name");
check((await apiCall(producer, "GET", "/team")).status !== 500, "team app still fine");
noErrors(producer, "producer");

console.log("2. Client");
const client = await as(browser, "client@sunrise.demo");
for (const path of ["/people-actions/tree", "/people-actions/options", "/people-actions/people"]) check((await apiCall(client, "GET", path)).status === 403, `client GET ${path} is 403`);

console.log("3. HR");
const hr = await as(browser, "hr@bmu.demo");
check((await apiCall(hr, "POST", `/people-actions/people/${rhea.id}/role`, { roleIds: [role("qc_reviewer").id], effectiveDate: dayAhead(0), reason: "Trying" })).status === 403, "HR can't change roles");
const hrAdmin = await apiCall(hr, "POST", "/people-actions/people", newPerson("hradmin", 22, role("admin").id));
check(hrAdmin.status === 400 || hrAdmin.status === 403, "HR can't add a Branch Manager");
const hrAdd = await apiCall(hr, "POST", "/people-actions/people", newPerson("hr", 23, role("producer").id));
check(hrAdd.body.outcome === "approval", "an HR member's new person waits for a Founder or the HR Department Head");
if (hrAdd.body.approval) {
  check((await apiCall(admin, "POST", `/actions/approvals/${hrAdd.body.approval.id}/decide`, { decision: "approve" })).status === 403, "a Branch Manager can't approve a new person");
  cleanupApprovals.push([hr, hrAdd.body.approval.id]);
}
await go(hr, "/admin/hierarchy");
await hr.locator(`[data-person-node="${rhea.id}"] button`).first().click();
await hr.getByTestId("person-actions").waitFor({ timeout: 15000 });
check(!(await hr.getByTestId("person-drawer").getByRole("button", { name: "Change role", exact: true }).count()), "HR's drawer has no Change role");
check(await hr.getByTestId("person-drawer").getByRole("button", { name: "Offboard", exact: true }).isVisible(), "HR can offboard");
await shot(hr, "forbidden-01-hr-drawer");
noErrors(hr, "hr");

console.log("4. Department Head");
const head = await as(browser, "design.head@bmu.demo");
const dhAdd = await apiCall(head, "POST", "/people-actions/people", newPerson("dh", 24, role("producer").id));
check(dhAdd.status === 403, "a Department Head can't add people (only the Founder, a Branch Manager or HR)");
const cross = await apiCall(head, "POST", `/people-actions/people/${rhea.id}/move`, { departmentId: strategy.id, teamId: strategy.teams[0]?.id ?? null, effectiveDate: dayAhead(0), reason: "Joins strategy", openWork: "keep" });
check(cross.body.outcome === "approval", "cross-department move goes to a Branch Manager");
if (cross.body.approval) cleanupApprovals.push([head, cross.body.approval.id]);
const other = await apiCall(head, "POST", `/people-actions/people/${priya.id}/move`, { departmentId: design.id, effectiveDate: dayAhead(0), reason: "Poaching", openWork: "keep" });
check(other.status === 403 || other.status === 404, `can't move someone from another department (${other.status} ${JSON.stringify(other.body).slice(0, 120)})`);
check((await apiCall(head, "POST", `/people-actions/people/${rhea.id}/role`, { roleIds: [role("qc_reviewer").id], effectiveDate: dayAhead(0), reason: "Trying" })).status === 403, "can't change roles");
await go(head, "/admin/hierarchy");
await head.locator('[data-node^="department:"]').first().waitFor({ timeout: 20000 });
check((await head.locator("[data-add-team]").count()) === 0, "no + Add team for a Department Head");
noErrors(head, "head");

console.log("5. Admin: making a Branch Manager needs the Founder");
const mk = await apiCall(admin, "POST", `/people-actions/people/${rhea.id}/role`, { roleIds: [role("admin").id], effectiveDate: dayAhead(0), reason: "Trying" });
check(mk.body.outcome === "approval" && /Founder/i.test(mk.body.message), "Admin role change waits for the Founder");
if (mk.body.approval) cleanupApprovals.push([admin, mk.body.approval.id]);
const decided = mk.body.approval ? await apiCall(admin, "POST", `/actions/approvals/${mk.body.approval.id}/decide`, { decision: "approve" }) : { status: 0 };
check(decided.status >= 400, `another Admin can't approve it (${decided.status})`);
const me = who("admin@bmu.demo");
check((await apiCall(admin, "POST", `/people-actions/people/${me.id}/role`, { roleIds: [role("founder").id], effectiveDate: dayAhead(0), reason: "Trying" })).status >= 400, "can't change their own role");
const legacy = await apiCall(admin, "PATCH", `/org/users/${rhea.id}`, { roleId: role("admin").id });
check(legacy.status === 400 || legacy.status === 403, "the old Users endpoint can't make a Branch Manager either");

for (const [page, id] of cleanupApprovals) await apiCall(page, "POST", `/actions/approvals/${id}/cancel`, {});
await cleanUp();
console.log(`(base ${BASE})`);
await browser.close();
done();
