// v11 people journey: the Users list and person page. Search, filters, multi-select bulk (Move, Add role, Export),
// Import, the ⋯ row menu, the person page with its History tab, and a custom role sent to the Founder.
// BASE_URL=http://localhost:3000 node apps/web/e2e/people-actions/users.mjs
import { BASE, apiCall, as, check, done, go, launch, noErrors, noSideScroll, pick, shot } from "./lib.mjs";

const browser = await launch();
const admin = await as(browser, "admin@bmu.demo");

console.log("1. List, search and filters");
await go(admin, "/admin/users");
await admin.locator("[data-person-row]").first().waitFor({ timeout: 20000 });
const all = await admin.locator("[data-person-row]").count();
check(all > 10, `list shows the team (${all})`);
await admin.getByLabel("Search people").fill("Zoya");
await admin.waitForFunction(() => document.querySelectorAll("[data-person-row]").length === 1, null, { timeout: 10000 }).catch(() => {});
check((await admin.locator("[data-person-row]").count()) === 1, "search narrows to one person");
await admin.getByLabel("Search people").fill("");
await pick(admin.getByLabel("Department", { exact: true }), "Creative / Design");
await admin.waitForTimeout(800);
const inDesign = await admin.locator("[data-person-row]").count();
check(inDesign > 2 && inDesign < all, `department filter (${inDesign})`);
check(await admin.getByRole("button", { name: "Export" }).first().isEnabled(), "export available");
check((await admin.getByRole("button", { name: /saved views|views/i }).count()) > 0, "saved views menu");
await shot(admin, "users-01-filtered");

console.log("2. Multi-select bulk actions");
const boxes = admin.locator("[data-person-row] input[type=checkbox]");
await boxes.nth(1).check();
await boxes.nth(2).check();
const bar = admin.getByTestId("bulk-bar");
await bar.waitFor();
check((await bar.innerText()).includes("2"), "bulk bar counts 2 people");
await bar.getByRole("button", { name: "Add role" }).click();
const bd = admin.getByTestId("bulk-people-dialog");
await bd.waitFor();
check(await bd.getByRole("button", { name: "Add role" }).isDisabled(), "Add role needs a role picked");
await shot(admin, "users-02-bulk-role");
await bd.getByRole("button", { name: "Cancel" }).click();
await bar.getByRole("button", { name: "Move" }).click();
await bd.waitFor();
check(await bd.getByLabel("Reason").isVisible(), "bulk move asks for a reason");
await bd.getByRole("button", { name: "Cancel" }).click();
check(await bar.getByRole("button", { name: "Export" }).isEnabled(), "export the selected people");

console.log("3. Row menu, import and person page");
const first = admin.locator("[data-person-row]").nth(1);
await first.getByRole("button", { name: /^Actions for/ }).click();
const items = await admin.getByRole("menuitem").allInnerTexts();
for (const label of ["Open profile", "Move", "Change role", "Offboard", "View history"]) check(items.some((i) => i.startsWith(label)), `row menu: ${label}`);
await admin.keyboard.press("Escape");
await admin.getByRole("button", { name: "Import", exact: true }).click();
await admin.getByText(/CSV/i).first().waitFor({ timeout: 10000 });
check(true, "import wizard opens");
await shot(admin, "users-03-import");
await admin.keyboard.press("Escape");
await go(admin, "/admin/users");
const zoya = (await apiCall(admin, "GET", "/people-actions/people?q=Zoya")).body[0];
await go(admin, `/admin/users/${zoya.id}`);
await admin.getByTestId("open-records").waitFor({ timeout: 15000 });
check(await admin.getByTestId("person-actions").isVisible(), "person page has the actions");
await admin.getByRole("tab", { name: "History" }).click();
await admin.getByTestId("history-tab").waitFor({ timeout: 10000 });
check(admin.url().includes("tab=history"), "History tab has its own link");
await shot(admin, "users-04-history");
noErrors(admin, "users");

console.log("4. Custom role: a Branch Manager's goes to the Founder");
await go(admin, "/admin/roles");
await admin.getByRole("button", { name: "New custom role" }).click();
const cr = admin.getByTestId("custom-role-drawer");
await cr.waitFor();
await admin.locator("#cr-name").fill(`Journey Senior Producer ${Date.now() % 100000}`);
await pick(admin.locator("#cr-base"), "Producer");
await cr.locator("select").nth(2).selectOption("team");
await shot(admin, "users-05-custom-role");
await cr.getByRole("button", { name: "Send for approval" }).click();
await cr.waitFor({ state: "detached", timeout: 10000 });
const pending = (await apiCall(admin, "GET", "/actions/approvals?box=requested")).body;
const req = (Array.isArray(pending) ? pending : (pending.items ?? [])).find((a) => a.action === "role.custom" || /custom role/i.test(a.summary ?? ""));
check(!!req, "custom role request is waiting for the Founder");
if (req) await apiCall(admin, "POST", `/actions/approvals/${req.id}/cancel`, {});
noErrors(admin, "roles");

console.log("5. Phone");
const phone = await as(browser, "admin@bmu.demo", { mobile: true });
await go(phone, "/admin/users");
await phone.getByTestId("people-cards").waitFor({ timeout: 20000 });
check(await noSideScroll(phone), "users list fits at 390px");
await shot(phone, "users-06-phone");
noErrors(phone, "phone");

console.log(`(base ${BASE})`);
await browser.close();
done();
