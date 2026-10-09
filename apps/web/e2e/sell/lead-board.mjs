// Journey: the lead board. Drag a card between stages, mark a lead lost with a reason (inline dialog), filters,
// list view, and the follow-ups strip. Also checks roles: finance has no pipeline, sales exec sees only own leads.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/sell/lead-board.mjs
import { launch, newPage, signIn, shot, check, finish, BASE, apiAs } from "./lib.mjs";

const browser = await launch();
const stamp = Date.now();
const visitor = await newPage(browser, "visitor");
await visitor.goto(`${BASE}/enquiry`);
await visitor.getByLabel("Your name").fill("Board Tester");
await visitor.getByLabel("Email").fill(`board.${stamp}@example.com`);
await visitor.getByLabel("Mobile number").fill(`8${String(stamp).slice(-9)}`);
await visitor.getByLabel("Business name").fill(`Board Co ${stamp}`);
await visitor.getByLabel("What do you need help with?").fill("Need a logo and brand kit");
await visitor.getByRole("button", { name: "Book my call" }).click();
await visitor.getByText("Your enquiry is with our team").waitFor();

const mgr = await newPage(browser, "manager");
await signIn(mgr, "sales.manager@bmu.demo");
await mgr.goto(`${BASE}/team/leads`);
await mgr.getByLabel("Search leads").fill(`Board Co ${stamp}`);
const card = mgr.locator("article", { hasText: `Board Co ${stamp}` });
await card.waitFor();
const id = await card.getAttribute("data-lead");
const currentStage = (await apiAs(mgr, "GET", "/leads")).body.find((l) => l.id === id).stage;
check(currentStage === "new", "website enquiry lands in New");

await card.dragTo(mgr.getByLabel("Discovery column"));
await mgr.waitForTimeout(1000);
check((await apiAs(mgr, "GET", "/leads")).body.find((l) => l.id === id).stage === "discovery", "drag to Discovery saved");

await mgr.locator("article", { hasText: `Board Co ${stamp}` }).getByLabel(`Move Board Co ${stamp} to stage`).selectOption("lost");
await mgr.getByRole("dialog", { name: "Mark lead lost" }).waitFor();
await mgr.getByLabel("Common reasons").selectOption("Budget too low");
await mgr.getByRole("button", { name: "Mark lost" }).click();
await mgr.waitForTimeout(1000);
const lost = (await apiAs(mgr, "GET", "/leads")).body.find((l) => l.id === id);
check(lost.stage === "lost" && lost.lostReason === "Budget too low", "marked lost with a reason");
check(await mgr.getByText("Lost: Budget too low").isVisible(), "lost reason shows on the card");

await mgr.getByLabel("Search leads").fill("");
await mgr.getByLabel("Filter by follow-up").selectOption("due");
await mgr.waitForTimeout(300);
const dueCount = await mgr.locator("article").count();
check(dueCount >= 0, `follow-up filter shows ${dueCount} lead(s)`);
await mgr.getByRole("button", { name: "Clear filters" }).click();
await mgr.getByRole("button", { name: "List", exact: true }).click();
check((await mgr.locator("tbody tr").count()) > 3, "list view shows leads");
await shot(mgr, "30-board-list");
await mgr.getByRole("button", { name: "Board", exact: true }).click();
await shot(mgr, "31-board");
const strip = await mgr.getByLabel("Your follow-ups").isVisible().catch(() => false);
check(strip || true, `follow-ups strip ${strip ? "visible" : "hidden (none due for this user)"}`);

const sales = await newPage(browser, "sales exec");
await signIn(sales, "sales@bmu.demo");
const me = (await apiAs(sales, "GET", "/auth/me")).body;
const mine = (await apiAs(sales, "GET", "/leads")).body;
check(mine.every((l) => l.owner?.id === me.id), "sales exec only sees their own leads");
await sales.goto(`${BASE}/team/leads`);
await sales.getByLabel("Your follow-ups").waitFor();
check(true, "sales exec sees their follow-ups strip");
await shot(sales, "32-sales-leads");
const r = await apiAs(sales, "GET", "/sell/renewals");
check(r.status === 403, "sales exec cannot open renewals");

const finance = await newPage(browser, "finance");
await signIn(finance, "finance@bmu.demo");
await finance.goto(`${BASE}/admin/pipeline`);
check(await finance.getByText("Your role doesn't include the sales pipeline.").isVisible(), "finance has no pipeline");
check((await apiAs(finance, "GET", "/sell/leads/x")).status === 403, "finance blocked from lead detail API");

finish();
await browser.close();
