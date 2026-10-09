// Command Centre journeys: users (invite, edit, permission matrix, clone role, suspend/restore), departments & branches,
// every settings page saves and persists, holidays/working days change leave maths, catalogue versions, SOP draft -> publish -> read,
// flow template and QC editors, DPDP export.
// BASE_URL=http://localhost:3000 [DATABASE_URL=postgresql://...] node apps/web/e2e/team/admin.mjs
// With DATABASE_URL set, the staff user, department, branch, SOP and cloned role it creates are soft-deleted (or removed) at the end.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BASE, launch, newPage, signIn, apiCall, check, done } from "./lib.mjs";

const stamp = Date.now() % 1_000_000;
const browser = await launch();
const as = async (who) => {
  const page = await newPage(browser);
  await signIn(page, who);
  return page;
};
const body = (p) => p.locator("body").innerText();
const settle = (p) => p.waitForLoadState("networkidle").catch(() => {});
/** Picks the first option whose text starts with `prefix`. */
const pick = async (select, prefix) => {
  const value = await select.evaluate((el, pre) => [...el.options].find((o) => o.text.startsWith(pre))?.value, prefix);
  if (!value) throw new Error(`no option starting with ${prefix}`);
  await select.selectOption(value);
};
const founder = await as("founder@bmu.demo");
const hr = await as("hr@bmu.demo");

// ---------------------------------------------------------------------------
console.log("Users: invite, edit, permissions, clone role, suspend/restore");
const email = `team.journey.${stamp}@example.com`;
// v11: + Add person drawer (pre-filled placement, permission preview, invite) and Clone opens the custom-role drawer.
await hr.goto(`${BASE}/admin/users`, { waitUntil: "networkidle" });
await hr.getByRole("button", { name: "+ Add person" }).click();
await hr.getByTestId("add-person-drawer").waitFor();
await hr.locator("#ap-role option").nth(1).waitFor({ state: "attached" });
await hr.locator("#ap-name").fill(`Journey Person ${stamp}`);
await hr.locator("#ap-phone").fill(`8${String(stamp).padStart(6, "0")}321`);
await hr.locator("#ap-email").fill(email);
await pick(hr.locator("#ap-role"), "Producer");
await pick(hr.locator("#ap-dept"), "Creative / Design");
if (await hr.locator("#ap-team").isEnabled()) await hr.locator("#ap-team").selectOption({ index: 1 });
await hr.getByTestId("add-person-drawer").getByRole("button", { name: "Add and invite" }).click();
await hr.getByTestId("add-person-drawer").waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
await hr.getByText(email).waitFor({ timeout: 10000 }).catch(() => {});
check(await hr.getByText(email).isVisible(), "HR invites a producer");

await founder.goto(`${BASE}/admin/roles`, { waitUntil: "networkidle" });
const cloneName = `Producer journey ${stamp}`;
const producerHeader = founder.locator("th", { hasText: /^Producer/ }).first();
await producerHeader.getByRole("button", { name: "Clone" }).click();
await founder.locator("#cr-name").fill(cloneName);
await founder.getByTestId("custom-role-drawer").getByRole("button", { name: "Create role" }).click();
await founder.locator("th", { hasText: cloneName }).waitFor({ timeout: 10000 }).catch(() => {});
check(await founder.locator("th", { hasText: cloneName }).isVisible(), "Founder clones the Producer role");
const headers = await founder.locator("thead th").allInnerTexts();
const col = headers.findIndex((h) => h.includes(cloneName));
const leadsRow = founder.locator("tbody tr", { hasText: "Leads & pipeline" }).first();
await leadsRow.locator("td").nth(col).locator("select").selectOption("all");
await settle(founder);
const roles = await apiCall(founder, "GET", "/org/roles");
const clone = roles.body.find((r) => r.name === cloneName);
check(clone?.permissions.find((p) => p.capability === "leads_pipeline")?.scope === "all", "permission change saved on the cloned role");

// v11: role and department changes go through Change role and Move (reason + effective date).
let person = (await apiCall(founder, "GET", "/org/tree")).body.users.find((u) => u.email === email);
const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const dept = (await apiCall(founder, "GET", "/people-actions/options")).body.departments.find((d) => d.name === "Strategy").id;
await apiCall(founder, "POST", `/people-actions/people/${person.id}/role`, { roleIds: [clone.id], effectiveDate: today, reason: "Journey role" });
await apiCall(founder, "POST", `/people-actions/people/${person.id}/move`, { departmentId: dept, teamId: null, effectiveDate: today, reason: "Journey move", openWork: "keep" });
person = (await apiCall(founder, "GET", "/org/tree")).body.users.find((u) => u.email === email);
check(person?.roles?.[0]?.name === cloneName && person?.departmentId === dept, `role and department edited (${person?.roles?.[0]?.name}, ${person?.departmentId === dept})`);

const newbie = await as(email);
check(newbie.url().includes("/team"), "the invited person signs in to the Team app");
check((await body(newbie)).includes("Leads"), "the cloned role's leads access shows the Leads menu");
const leadsApi = await apiCall(newbie, "GET", "/leads");
check(leadsApi.status === 200, `the API lets them read leads (${leadsApi.status})`);

await founder.goto(`${BASE}/admin/roles`, { waitUntil: "networkidle" });
await founder.locator("tbody tr", { hasText: "Leads & pipeline" }).first().locator("td").nth(col).locator("select").selectOption("none");
await settle(founder);
await newbie.reload({ waitUntil: "networkidle" });
const leadsAfter = await apiCall(newbie, "GET", "/leads");
check(!(await newbie.locator("nav").innerText().catch(() => "")).includes("Leads") && leadsAfter.status === 403, `turning it off removes the menu and the API access (${leadsAfter.status})`);

await founder.goto(`${BASE}/admin/users`, { waitUntil: "networkidle" });
const userRow = founder.locator(`[data-person-row="${person.id}"]`);
founder.once("dialog", (d) => d.accept());
await userRow.getByRole("button", { name: /^Actions for/ }).click();
await founder.getByRole("menuitem", { name: /^Suspend access/ }).click();
await userRow.getByText("suspended").waitFor({ timeout: 10000 }).catch(() => {});
const blocked = await apiCall(newbie, "GET", "/auth/me");
check(blocked.status === 401 || blocked.status === 403, `a suspended person loses access straight away (${blocked.status})`);
await userRow.getByRole("button", { name: /^Actions for/ }).click();
await founder.getByRole("menuitem", { name: /^Restore access/ }).click();
await userRow.getByText("active").waitFor({ timeout: 10000 }).catch(() => {});
const back = await as(email);
check(back.url().includes("/team"), "restored person can sign in again");
await founder.goto(`${BASE}/admin/users?u=${person.id}`, { waitUntil: "networkidle" });
check((await founder.locator(`#user-${person.id}`).getAttribute("class"))?.includes("outline"), "?u= highlights the person from search");
await founder.goto(`${BASE}/admin/hierarchy`, { waitUntil: "networkidle" });
check((await body(founder)).includes(`Journey Person ${stamp}`), "the hierarchy tree shows the new person");

// ---------------------------------------------------------------------------
console.log("Departments, teams, branches");
await hr.goto(`${BASE}/admin/departments`, { waitUntil: "networkidle" });
await hr.getByRole("button", { name: "New department" }).click();
await hr.getByPlaceholder("e.g. Performance Marketing").fill(`Journey Dept ${stamp}`);
await hr.getByRole("button", { name: "Create department" }).click();
await hr.getByText(`Journey Dept ${stamp}`).first().waitFor({ timeout: 10000 }).catch(() => {});
check(await hr.getByText(`Journey Dept ${stamp}`).first().isVisible(), "HR creates a department");
await founder.goto(`${BASE}/admin/branches`, { waitUntil: "networkidle" });
await founder.getByRole("button", { name: "New branch" }).click();
await founder.getByPlaceholder("e.g. Pune Studio").fill(`Journey Branch ${stamp}`);
await founder.getByPlaceholder("e.g. Pune", { exact: true }).fill("Pune");
await founder.getByRole("button", { name: "Create branch" }).click();
await founder.getByText(`Journey Branch ${stamp}`).first().waitFor({ timeout: 10000 }).catch(() => {});
check(await founder.getByText(`Journey Branch ${stamp}`).first().isVisible(), "Founder creates a branch");

// ---------------------------------------------------------------------------
console.log("Settings pages save and persist");
const SETTINGS = ["/admin/tenant", "/admin/branding", "/admin/sla-rules", "/admin/gate-rules", "/admin/notification-templates", "/admin/requirement-checklists", "/admin/finance/gst", "/admin/finance/accounting"];
const FIELDS = "main input:not([type=checkbox]):not([type=date]):not([type=file]), main textarea, main select:not([aria-label=Format])";
/** Picks a harmless field to change: a text value, then an empty text box, then a number, then a select. */
async function chooseField(page) {
  const all = page.locator(FIELDS);
  const n = await all.count();
  const info = [];
  for (let i = 0; i < n; i++) {
    const f = all.nth(i);
    if (!(await f.isVisible()) || (await f.isDisabled())) continue;
    const meta = await f.evaluate((el) => ({ tag: el.tagName, type: el.type, value: el.value, ph: el.placeholder ?? "", options: el.tagName === "SELECT" ? [...el.options].map((o) => o.value) : [] }));
    info.push({ i, ...meta });
  }
  const text = (x) => x.tag === "TEXTAREA" || (x.tag === "INPUT" && (x.type === "text" || x.type === ""));
  const safe = (v) => !/@|^\+?\d|^https?:|^#|^[0-9A-Z]{15}$/.test(v);
  const pickOne =
    info.find((x) => text(x) && x.value.length > 3 && safe(x.value) && !x.ph.toLowerCase().includes("search")) ??
    info.find((x) => text(x) && x.value === "" && !x.ph.toLowerCase().includes("search")) ??
    info.find((x) => x.tag === "INPUT" && x.type === "number") ??
    info.find((x) => x.tag === "SELECT" && x.options.length > 1);
  if (!pickOne) return null;
  const next =
    pickOne.tag === "SELECT"
      ? pickOne.options.find((o) => o !== pickOne.value)
      : pickOne.type === "number"
        ? String(Number(pickOne.value) + 1)
        : pickOne.value.includes("\n")
          ? `${pickOne.value}\nJourney ${stamp}`
          : `${pickOne.value}${pickOne.value ? " " : ""}J${stamp}`;
  return { ...pickOne, next };
}
async function setField(page, f, value) {
  const el = page.locator(FIELDS).nth(f.i);
  if (f.tag === "SELECT") await el.selectOption(value);
  else await el.fill(value);
}
async function saveSettings(page) {
  await page.getByRole("button", { name: /^Save/ }).first().click();
  await page.getByText(/Saved/).first().waitFor({ timeout: 10000 }).catch(() => {});
  return page.getByText(/Saved/).first().isVisible();
}
for (const url of SETTINGS) {
  await founder.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
  const f = await chooseField(founder);
  if (!f) {
    check(false, `${url}: no editable field found`);
    continue;
  }
  await setField(founder, f, f.next);
  const ok = await saveSettings(founder);
  await founder.reload({ waitUntil: "networkidle" });
  await founder.locator(FIELDS).nth(f.i).waitFor({ timeout: 10000 }).catch(() => {});
  const now = await founder.locator(FIELDS).nth(f.i).inputValue();
  check(ok && now === f.next, `${url}: saves (${f.tag.toLowerCase()} ${f.type || ""}) and the change is there after reload`);
  await setField(founder, f, f.value);
  await saveSettings(founder);
}
await founder.goto(`${BASE}/admin/discount-limits`, { waitUntil: "networkidle" });
const lim = founder.locator('input[type="number"]').first();
const limWas = await lim.inputValue();
await lim.fill(String((Number(limWas) + 1) % 100));
await founder.getByRole("button", { name: "Save limits" }).click();
await founder.getByText("Limits saved").waitFor({ timeout: 10000 }).catch(() => {});
check(await founder.getByText("Limits saved").isVisible(), "/admin/discount-limits saves");
await founder.locator('input[type="number"]').first().fill(limWas);
await founder.getByRole("button", { name: "Save limits" }).click();
await settle(founder);

// ---------------------------------------------------------------------------
console.log("Holidays and working days change the maths");
const producer = await as("producer@bmu.demo");
const wk = new Date(Date.UTC(2027, 5, 7 + 7 * (stamp % 20)));
const d = (n) => new Date(wk.getTime() + n * 86400000).toISOString().slice(0, 10);
const before = await apiCall(producer, "POST", "/workspace/leave", { from: d(0), to: d(4), type: "casual", reason: `holiday maths ${stamp}` });
const req1 = before.body.leave.requests.find((r) => r.reason === `holiday maths ${stamp}`);
await apiCall(producer, "POST", `/workspace/leave/${req1.id}/cancel`);
await founder.goto(`${BASE}/admin/holidays`, { waitUntil: "networkidle" });
await founder.locator('input[name="date"]').fill(d(2));
await founder.locator('input[name="name"]').fill(`Journey Holiday ${stamp}`);
await founder.getByRole("button", { name: "Add holiday" }).click();
await founder.getByText(`Journey Holiday ${stamp}`).first().waitFor({ timeout: 10000 }).catch(() => {});
const after = await apiCall(producer, "POST", "/workspace/leave", { from: d(0), to: d(4), type: "casual", reason: `holiday maths 2 ${stamp}` });
const req2 = after.body.leave.requests.find((r) => r.reason === `holiday maths 2 ${stamp}`);
check(req1.days === 5 && req2.days === 4, `a new holiday takes a day off leave maths (${req1.days} -> ${req2.days})`);
await apiCall(producer, "POST", `/workspace/leave/${req2.id}/cancel`);
founder.once("dialog", (x) => x.accept());
await founder.getByRole("button", { name: `Remove Journey Holiday ${stamp}` }).click();
await settle(founder);
const sat = founder.getByRole("button", { name: "Sat", exact: true });
const satOn = (await sat.getAttribute("aria-pressed")) === "true";
await sat.click();
await founder.getByRole("button", { name: "Save working hours" }).click();
await settle(founder);
const s1 = await apiCall(founder, "GET", "/settings");
check(s1.body.workingHours.days.includes(6) !== satOn, "working days save (Saturday toggled)");
await founder.getByRole("button", { name: "Sat", exact: true }).click();
await founder.getByRole("button", { name: "Save working hours" }).click();
await settle(founder);

// ---------------------------------------------------------------------------
console.log("Catalogue");
const v0 = await apiCall(founder, "GET", "/catalogue/versions");
await founder.goto(`${BASE}/admin/catalogue`, { waitUntil: "networkidle" });
const price = founder.locator('input[aria-label$="starter price"]').first();
const was = await price.inputValue();
await price.fill(String(Number(was) + 100));
await price.blur();
await founder.getByText(/new price book version/).waitFor({ timeout: 10000 }).catch(() => {});
const v1 = await apiCall(founder, "GET", "/catalogue/versions");
check(v1.body.length === v0.body.length + 1 && v1.body[0].status === "active", `price edit creates a new price book version (${v1.body[0].version})`);
await founder.locator('input[aria-label$="starter price"]').first().fill(was);
await founder.locator('input[aria-label$="starter price"]').first().blur();
await settle(founder);
await founder.getByLabel("Add-on name").last().fill(`Journey add-on ${stamp}`);
await founder.getByLabel("Price in rupees").last().fill("1500");
await founder.getByLabel("Unit").last().fill("per item");
await founder.getByRole("button", { name: "Add", exact: true }).click();
await founder.getByText(`Journey add-on ${stamp}`).first().waitFor({ timeout: 10000 }).catch(() => {});
check((await body(founder)).includes(`Journey add-on ${stamp}`), "add-on created");
founder.once("dialog", (x) => x.accept());
await founder.locator("li", { hasText: `Journey add-on ${stamp}` }).getByRole("button", { name: "Remove" }).click();
await settle(founder);
await founder.waitForTimeout(500);
check((await founder.locator("li", { hasText: `Journey add-on ${stamp}` }).count()) === 0, "add-on removed");
check((await founder.locator("#addons").count()) === 1 && (await founder.locator("#versions").count()) === 1, "Add-ons anchor matches the menu and history is shown");

// ---------------------------------------------------------------------------
console.log("SOP draft -> publish -> read");
const sopTitle = `Journey SOP ${stamp}`;
await founder.goto(`${BASE}/admin/sops`, { waitUntil: "networkidle" });
await founder.getByRole("button", { name: "New SOP" }).click();
await founder.getByPlaceholder("e.g. Design QC").fill(sopTitle);
await founder.getByRole("button", { name: "Save as draft" }).click();
await founder.getByText("draft, only editors can see it").waitFor({ timeout: 10000 }).catch(() => {});
const prodSops = await apiCall(producer, "GET", "/workspace/sops");
check(!JSON.stringify(prodSops.body).includes(sopTitle), "a draft SOP is hidden from the team");
await founder.getByRole("button", { name: "Publish", exact: true }).click();
await founder.getByRole("button", { name: "Unpublish", exact: true }).waitFor({ timeout: 10000 }).catch(() => {});
const all = await apiCall(founder, "GET", "/admin-platform/sops");
const sop = all.body.find((s) => s.title === sopTitle);
check(sop?.status === "published", "SOP published");
await producer.goto(`${BASE}/team/sops/${sop.id}`, { waitUntil: "networkidle" });
await producer.getByRole("button", { name: "I have read this" }).click();
await settle(producer);
await founder.reload({ waitUntil: "networkidle" });
const acked = (await apiCall(founder, "GET", "/admin-platform/sops")).body.find((s) => s.id === sop.id);
check(acked?.acknowledged === 1, "the team member's acknowledgement is counted");
await founder.goto(`${BASE}/admin/sops?sop=${sop.id}`, { waitUntil: "networkidle" });
check((await body(founder)).includes("1 read and acknowledged"), "?sop= opens that SOP with its read count");

// ---------------------------------------------------------------------------
console.log("Flow templates and QC checklists");
await founder.goto(`${BASE}/admin/templates`, { waitUntil: "networkidle" });
const qcBox = founder.locator("textarea").first();
const qcWas = await qcBox.inputValue();
await qcBox.fill(`${qcWas}\nJourney check ${stamp}`);
await founder.getByRole("button", { name: "Save", exact: true }).first().click();
await founder.getByText("Saved.").first().waitFor({ timeout: 10000 }).catch(() => {});
check(await founder.getByText("Saved.").first().isVisible(), "QC checklist saves a new version");
await founder.locator("textarea").first().fill(qcWas);
await founder.getByRole("button", { name: "Save", exact: true }).first().click();
await settle(founder);
await founder.getByRole("button", { name: "Save new version" }).first().click();
await founder.getByText("Saved as a new version.").first().waitFor({ timeout: 10000 }).catch(() => {});
check((await body(founder)).includes("Saved as a new version"), "flow template saves a new version");

// ---------------------------------------------------------------------------
console.log("DPDP");
await founder.goto(`${BASE}/admin/data`, { waitUntil: "networkidle" });
const [dl] = await Promise.all([founder.waitForEvent("download", { timeout: 15000 }), founder.getByRole("button", { name: "Export all data" }).first().click()]);
const json = JSON.parse(readFileSync(await dl.path(), "utf8"));
check(json && typeof json === "object" && Object.keys(json).length > 2, `client data export is valid JSON (${Object.keys(json).slice(0, 5).join(", ")})`);
const del = founder.getByRole("button", { name: "Delete personal data" }).first();
if (await del.isEnabled()) {
  await del.click();
  const confirmBox = founder.locator("section", { hasText: "Type the client name to confirm" });
  check(await confirmBox.getByRole("button", { name: "Delete personal data" }).isDisabled(), "deletion needs the client name typed first");
  await confirmBox.getByRole("button", { name: "Cancel" }).click();
}

// ---------------------------------------------------------------------------
const errs = [founder, hr, producer, newbie, back].flatMap((p) => p.errors);
check(errs.length === 0, `no page errors (${errs.slice(0, 3).join(" | ")})`);
await browser.close();

if (process.env.DATABASE_URL) {
  const sql = [
    `update users set "deletedAt" = now(), status = 'suspended' where email = '${email}'`,
    `update departments set "deletedAt" = now() where name = 'Journey Dept ${stamp}'`,
    `update branches set "deletedAt" = now() where name = 'Journey Branch ${stamp}'`,
    `delete from sop_acknowledgements where "sopId" in (select id from sops where title = '${sopTitle}')`,
    `delete from sops where title = '${sopTitle}'`,
    // the cloned role: the only user on it is the journey user, soft-deleted above
    `delete from permissions where "roleId" in (select id from roles where name = '${cloneName}')`,
    `delete from user_roles where "roleId" in (select id from roles where name = '${cloneName}')`,
    `delete from roles where name = '${cloneName}'`,
  ];
  for (const q of sql) {
    try {
      execFileSync("psql", [process.env.DATABASE_URL, "-qc", q], { stdio: "pipe" });
    } catch (e) {
      console.log(`  cleanup failed: ${q.slice(0, 60)}… ${String(e.stderr ?? e).slice(0, 120)}`);
    }
  }
  console.log("  cleaned up journey records");
} else console.log(`  note: set DATABASE_URL to soft-delete ${email} and the other journey records`);
done();
