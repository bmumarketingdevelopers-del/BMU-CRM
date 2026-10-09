// Global search (Ctrl/Cmd+K) with keyboard navigation and permission-aware results; activity feeds on client, lead,
// engagement and invoice pages with drill-down.
// BASE_URL=http://localhost:3000 node apps/web/e2e/team/search-activity.mjs
import { BASE, launch, newPage, signIn, apiCall, check, done } from "./lib.mjs";

const browser = await launch();
const as = async (who) => {
  const page = await newPage(browser);
  await signIn(page, who);
  return page;
};

/** First id whose activity feed has entries with field changes (falls back to any entries). */
async function withActivity(page, entity, ids) {
  let fallback;
  for (const id of ids.slice(0, 25)) {
    const r = await apiCall(page, "GET", `/team-flows/activity?entity=${entity}&id=${id}&take=50`);
    if (r.status !== 200 || !r.body.total) continue;
    if (r.body.items.some((i) => i.changes.length)) return id;
    fallback ??= id;
  }
  return fallback;
}

async function search(page, q) {
  await page.keyboard.press("Control+k");
  const box = page.getByLabel("Search everything");
  await box.waitFor({ timeout: 5000 });
  await box.fill(q);
  await page.locator("#global-search-results [role=option]").first().waitFor({ timeout: 8000 }).catch(() => {});
  return page.locator("#global-search-results").innerText();
}

console.log("Founder in the Command Centre");
const founder = await as("founder@bmu.demo");
let results = await search(founder, "Sunrise");
check(/Clients/i.test(results), "Ctrl+K finds clients");
await founder.keyboard.press("ArrowDown");
await founder.keyboard.press("ArrowUp");
check((await founder.locator("[role=option][aria-selected=true]").count()) === 1, "arrow keys move the highlight");
await founder.keyboard.press("Enter");
await founder.waitForURL(/\/team\/clients\//, { timeout: 10000 }).catch(() => {});
check(/\/team\/clients\//.test(founder.url()), `Enter opens the result (${founder.url().replace(BASE, "")})`);
// v11: Client 360 keeps the activity feed on its History tab.
await founder.getByRole("tab", { name: "History" }).or(founder.getByRole("button", { name: "History", exact: true })).first().click().catch(() => {});
await founder.getByTestId("activity-feed").waitFor({ timeout: 10000 }).catch(() => {});
check(await founder.getByTestId("activity-feed").isVisible(), "client page shows the activity feed");
const clients = await apiCall(founder, "GET", "/clients");
const richClient = await withActivity(founder, "ClientOrg", (clients.body.rows ?? clients.body.items ?? clients.body).map((c) => c.id));
if (richClient) {
  await founder.goto(`${BASE}/team/clients/${richClient}?tab=history`, { waitUntil: "networkidle" });
  await founder.getByRole("tab", { name: "History" }).or(founder.getByRole("button", { name: "History", exact: true })).first().click().catch(() => {});
  await founder.getByTestId("activity-feed").waitFor({ timeout: 10000 }).catch(() => {});
  const details = founder.getByTestId("activity-feed").getByText("Details", { exact: true }).first();
  await details.waitFor({ timeout: 10000 }).catch(() => {});
  if (await details.count()) {
    await details.click();
    await founder.getByRole("columnheader", { name: "Before" }).first().waitFor({ timeout: 5000 }).catch(() => {});
    const heads = founder.getByTestId("activity-feed").locator("th", { hasText: "Before" });
    check((await heads.count()) > 0 && (await heads.first().isVisible()), `an activity entry drills down to before/after (${await heads.count()})`);
  } else check(false, `client activity has an entry with details (${founder.url().replace(BASE, "")})`);
} else check(false, "a client with recorded activity exists");
await founder.keyboard.press("Control+k");
await founder.getByLabel("Search everything").fill("zz");
await founder.keyboard.press("Escape");
check((await founder.getByRole("dialog", { name: "Search" }).count()) === 0, "Esc closes search");

console.log("Invoice and engagement pages");
const finance = await as("finance@bmu.demo");
const inv = await apiCall(finance, "GET", "/finance/invoices");
const invoiceId = await withActivity(finance, "Invoice", (inv.body.rows ?? []).map((r) => r.id));
const invoice = inv.body.rows?.find((r) => r.id === invoiceId) ?? inv.body.rows?.[0];
if (invoice?.id) {
  results = await search(finance, invoice.number ?? "INV");
  check(/Invoices/i.test(results), "finance can find invoices by number");
  await finance.goto(`${BASE}/admin/finance/invoices/${invoice.id}`, { waitUntil: "networkidle" });
  await finance.getByTestId("activity-feed").waitFor({ timeout: 10000 }).catch(() => {});
  check(await finance.getByTestId("activity-feed").isVisible(), "invoice page shows the activity feed");
} else check(false, "an invoice exists to open");
const amLead = await as("am.lead@bmu.demo");
const projects = await apiCall(amLead, "GET", "/engagements");
// A project with recorded activity (a brand-new demo project has none yet, so its feed shows the empty state).
let eng = null;
for (const e of (projects.body.items ?? projects.body).slice(0, 15)) {
  const feed = await apiCall(amLead, "GET", `/team-flows/activity?entity=Engagement&id=${e.id}`);
  if ((feed.body?.items ?? feed.body ?? []).length) {
    eng = e;
    break;
  }
}
if (eng?.id) {
  await amLead.goto(`${BASE}/team/projects/${eng.id}`, { waitUntil: "networkidle" });
  await amLead.getByTestId("activity-feed").waitFor({ timeout: 10000 }).catch(() => {});
  check(await amLead.getByTestId("activity-feed").isVisible(), "engagement page shows the activity feed");
} else check(false, "a project with activity exists to open");
await founder.goto(`${BASE}/admin/pipeline`, { waitUntil: "networkidle" });
const leadLink = founder.locator('main a[href^="/team/leads/"]').first();
if (await leadLink.count()) {
  await leadLink.click();
  await founder.waitForURL(/\/team\/leads\/[^/]+$/, { timeout: 30000 }).catch(() => {});
  await founder.getByTestId("activity-feed").waitFor({ timeout: 15000 }).catch(() => {});
  check(/\/team\/leads\/[^/]+$/.test(founder.url()) && /Activity|History/.test(await founder.locator("main").innerText()), "the pipeline board opens a lead page with an Activity panel");
  const leads = await apiCall(founder, "GET", "/leads");
  const richLead = await withActivity(founder, "Lead", (leads.body.rows ?? leads.body.items ?? leads.body).map((l) => l.id));
  await founder.goto(`${BASE}/team/leads/${richLead}`, { waitUntil: "networkidle" });
  await founder.getByTestId("activity-feed").waitFor({ timeout: 10000 }).catch(() => {});
  check(await founder.getByTestId("activity-feed").isVisible(), "lead page shows its activity feed");
} else check(false, "lead board links to lead details");

console.log("Permissions");
const producer = await as("producer@bmu.demo");
const pr = await apiCall(producer, "GET", "/team-flows/search?q=Sunrise");
const kinds = pr.body.groups.map((g) => g.kind);
check(!kinds.includes("client") && !kinds.includes("invoice") && !kinds.includes("lead"), `a producer's search leaves out clients, leads and invoices (${kinds.join(",") || "none"})`);
results = await search(producer, "Sunrise");
check(!/Invoices|Leads/.test(results), "the team-app search box shows the same limited results");
if (invoice?.id) {
  const denied = await apiCall(producer, "GET", `/team-flows/activity?entity=Invoice&id=${invoice.id}`);
  check(denied.status === 403, `a producer cannot read an invoice's activity (${denied.status})`);
}
const client = await as("client@sunrise.demo");
const cs = await apiCall(client, "GET", "/team-flows/search?q=Sunrise");
check(cs.status === 403, `clients cannot use team search (${cs.status})`);

const errs = [founder, finance, amLead, producer].flatMap((p) => p.errors);
check(errs.length === 0, `no page errors (${errs.slice(0, 3).join(" | ")})`);
await browser.close();
done();
