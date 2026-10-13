// v11 people journey: the Hierarchy Tree. A Branch Manager adds a person from a team node in under 60 seconds (pre-filled
// department, team and manager, permission preview, invite), drags someone onto another team (Move dialog with the
// access preview, effective date and reason), opens the profile drawer (Change role diff) and toggles load / leave.
// On a phone (390px) the tree fits and Move works from the drawer.
// BASE_URL=http://localhost:3000 node apps/web/e2e/people-actions/tree.mjs
import { BASE, apiCall, as, check, cleanUp, done, go, journeyEmail, journeyPhone, launch, noErrors, noSideScroll, pick, shot, stamp, toast } from "./lib.mjs";

const browser = await launch();
// Only the Founder or HR add people, so this journey (which adds one from the tree) signs in as the Founder.
const admin = await as(browser, "founder@bmu.demo");

console.log("0. A Branch Manager sees the tree but no Add person buttons");
const branchManager = await as(browser, "admin@bmu.demo");
await go(branchManager, "/admin/hierarchy");
await branchManager.locator('[data-node^="department:"]').first().waitFor({ timeout: 20000 });
check((await branchManager.locator("[data-add-person]").count()) === 0, "no Add person for a Branch Manager");

console.log("1. Tree loads with nodes, add buttons and toggles");
await go(admin, "/admin/hierarchy");
await admin.locator('[data-node^="department:"]').first().waitFor({ timeout: 20000 });
const tree = (await apiCall(admin, "GET", "/people-actions/tree")).body;
const design = tree.branches.flatMap((b) => b.departments).find((d) => d.name === "Creative / Design");
const brandPod = design.teams.find((t) => t.name === "Brand Pod");
check(!!design && !!brandPod, "Creative / Design and its Brand Pod are on the tree");
check((await admin.locator("[data-add-person]").count()) > 3, "+ Add person on department and team nodes");
check((await admin.locator("[data-add-team]").count()) > 0, "+ Add team on department nodes");
check(await admin.getByLabel("Load %").isChecked(), "load % toggle on");
await admin.getByLabel("Load %").uncheck();
check((await admin.locator('[data-person-node] .w-16').count()) === 0, "load bars hidden when toggled off");
await admin.getByLabel("Load %").check();
await shot(admin, "tree-01-departments");

console.log("2. Add a person from the Brand Pod node in under 60 seconds");
const t0 = Date.now();
await admin.locator(`[data-add-person="${brandPod.id}"]`).click();
const drawer = admin.getByTestId("add-person-drawer");
await drawer.waitFor();
await admin.locator("#ap-role option").nth(1).waitFor({ state: "attached" });
check((await admin.locator("#ap-dept").inputValue()) === design.id, "department pre-filled");
check((await admin.locator("#ap-team").inputValue()) === brandPod.id, "team pre-filled");
check((await admin.locator("#ap-manager").inputValue()) === (brandPod.lead?.id ?? design.head.id), "manager pre-filled with the team lead");
const name = `Journey Hire ${stamp}`;
await admin.locator("#ap-name").fill(name);
await admin.locator("#ap-phone").fill(journeyPhone(1));
await admin.locator("#ap-email").fill(journeyEmail("tree"));
await pick(admin.locator("#ap-role"), "Producer");
await admin.getByTestId("permission-preview").waitFor();
check((await admin.getByTestId("permission-preview").innerText()).includes("Tasks"), "permission preview lists what they can do");
await shot(admin, "tree-02-add-person");
await drawer.getByRole("button", { name: "Add and invite" }).click();
await toast(admin).waitFor({ timeout: 15000 });
const secs = (Date.now() - t0) / 1000;
check(secs < 60, `added in ${secs.toFixed(1)}s (under 60s)`);
check(/invite|added/i.test(await toast(admin).innerText()), "toast confirms the invite");
const hire = admin.locator(`[data-person-node][data-name="${name}"]`);
await hire.waitFor({ timeout: 15000 });
check((await hire.innerText()).includes("Invited"), "new person shows as Invited in the Brand Pod");
const hireRow = (await apiCall(admin, "GET", `/people-actions/people?q=${encodeURIComponent(name)}`)).body[0];
check(hireRow?.status === "invited" && hireRow.team?.id === brandPod.id, "API: invited, in the Brand Pod");
const detail = (await apiCall(admin, "GET", `/people-actions/people/${hireRow.id}`)).body;
check(!!detail.onboardingId, "onboarding checklist started for HR and the manager");
noErrors(admin, "add person");

console.log("3. Drag them out of the team onto the department (Move dialog)");
const target = admin.locator(`[data-drop="d:${design.id}"]`);
await hire.dragTo(target, { targetPosition: { x: 20, y: 10 } });
const move = admin.getByTestId("move-dialog");
await move.waitFor({ timeout: 10000 });
await admin.getByTestId("move-preview").waitFor({ timeout: 10000 });
check((await admin.locator("#mv-team").inputValue()) === "", "dropped on the department: no team");
const previewText = await admin.getByTestId("move-preview").innerText();
check(/sees|no change to what they can see|manager/i.test(previewText), `preview says what they gain or lose sight of (${previewText.replace(/\n/g, " / ").slice(0, 120)})`);
await move.getByRole("button", { name: "Move", exact: true }).click();
check(await move.getByText(/reason/i).first().isVisible(), "a reason is required");
await admin.locator("#mv-reason").fill("Floats across pods for now");
await move.getByRole("button", { name: "Move", exact: true }).click();
await move.waitFor({ state: "detached", timeout: 10000 });
await toast(admin).waitFor();
await shot(admin, "tree-03-moved");
const moved = (await apiCall(admin, "GET", `/people-actions/people/${hireRow.id}`)).body;
check(moved.team === null && moved.department?.id === design.id, "API: moved out of the team, same department");
noErrors(admin, "drag move");

console.log("4. Profile drawer: actions and Change role diff");
await admin.locator(`[data-person-node][data-name="${name}"] button`).first().click();
const pd = admin.getByTestId("person-drawer");
await pd.getByTestId("person-actions").waitFor({ timeout: 10000 });
for (const label of ["Reassign work", "Change role", "Move", "Offboard"]) check(await pd.getByRole("button", { name: label, exact: true }).isVisible(), `drawer offers ${label}`);
await pd.getByRole("button", { name: "Change role", exact: true }).click();
const rd = admin.getByTestId("role-dialog");
await rd.waitFor();
const roleSelect = rd.locator("#rl-main");
await roleSelect.locator("option").nth(2).waitFor({ state: "attached" });
await pick(roleSelect, "QC Reviewer");
await admin.getByTestId("role-diff").waitFor({ timeout: 10000 });
check((await admin.getByTestId("role-diff").innerText()).length > 10, "permission diff shown before saving");
await shot(admin, "tree-04-role-diff");
await rd.getByRole("button", { name: "Cancel" }).click();
noErrors(admin, "drawer");

console.log("5. Reporting lines view");
await admin.getByRole("tab", { name: "Reporting lines" }).click();
await admin.locator('[data-node^="person:"]').first().waitFor();
check((await admin.getByRole("button", { name: /^Add a person reporting to/ }).count()) > 3, "+ Add on each person in reporting lines");
await shot(admin, "tree-05-reporting");
await admin.getByRole("tab", { name: "By department" }).click();

console.log("6. Phone: tree fits, Move from the drawer");
const phone = await as(browser, "admin@bmu.demo", { mobile: true });
await go(phone, "/admin/hierarchy");
await phone.locator('[data-node^="department:"]').first().waitFor({ timeout: 20000 });
check(await noSideScroll(phone), "no sideways scroll at 390px");
await phone.locator(`[data-person-node][data-name="${name}"] button`).first().click();
await phone.getByTestId("person-drawer").getByRole("button", { name: "Move", exact: true }).click();
await phone.getByTestId("move-dialog").waitFor();
check(await noSideScroll(phone), "move dialog fits at 390px");
await shot(phone, "tree-06-phone-move");
await phone.getByTestId("move-dialog").getByRole("button", { name: "Cancel" }).click();
noErrors(phone, "phone");

await cleanUp();
console.log(`(base ${BASE})`);
await browser.close();
done();
