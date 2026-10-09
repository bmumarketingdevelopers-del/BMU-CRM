// v13 foundation journey: two people on the same lead see each other (presence) and one screen updates by itself when
// the other person changes the lead (live updates). Smart search finds a misspelt client, filters by type and
// remembers recent records. System health shows the event bus and lets the Founder switch a feature off and on.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/platform/live.mjs
import { apiCall, check, done, launch, newPage, shot, signIn, BASE } from "../team/lib.mjs";

const browser = await launch();
const founder = await newPage(browser);
const manager = await newPage(browser);
let restoreFlag = false;

try {
  console.log("1. Founder and the sales manager open the same lead");
  await signIn(founder, "founder@bmu.demo");
  await signIn(manager, "sales.manager@bmu.demo");
  const founderMe = (await apiCall(founder, "GET", "/auth/me")).body;
  const managerMe = (await apiCall(manager, "GET", "/auth/me")).body;
  const leads = (await apiCall(founder, "GET", "/leads")).body;
  const lead = leads.find((l) => l.stage === "new");
  check(!!lead, "found a new lead to work on");
  await founder.goto(`${BASE}/team/leads/${lead.id}`);
  await manager.goto(`${BASE}/team/leads/${lead.id}`);
  await manager.getByRole("heading", { level: 1 }).waitFor();
  await manager.getByTestId("live-status").and(manager.locator('[data-status="live"]')).waitFor({ timeout: 15000 });
  check(true, "the sidebar shows Live");

  console.log("2. Presence: each sees the other");
  await manager.getByTestId("presence").waitFor({ timeout: 15000 });
  check((await manager.getByTestId("presence").innerText()).includes(founderMe.name), `the manager sees ${founderMe.name} is also here`);
  await founder.getByTestId("presence").waitFor({ timeout: 15000 });
  check((await founder.getByTestId("presence").innerText()).includes(managerMe.name), `the Founder sees ${managerMe.name} is also here`);
  await shot(manager, "live-presence");

  console.log("3. Live update: the Founder moves the lead, the manager's screen changes without a refresh");
  const navBefore = await manager.evaluate(() => performance.getEntriesByType("navigation").length + ":" + (window.__liveMarker = "same-page"));
  const moved = await apiCall(founder, "PATCH", `/leads/${lead.id}`, { stage: "contacted" });
  check(moved.status === 200, "the Founder moved the lead to Contacted");
  await manager.getByText(/^Contacted · from /).waitFor({ timeout: 10000 });
  check((await manager.evaluate(() => window.__liveMarker)) === "same-page", "the manager's page updated in place (no reload)");
  check(!!navBefore, "page marker was set");
  await shot(manager, "live-updated");

  console.log("4. Leaving the page removes the face");
  await founder.goto(`${BASE}/team`);
  await manager.getByTestId("presence").waitFor({ state: "detached", timeout: 15000 });
  check(true, "the Founder's face is gone after they left");

  console.log("5. Smart search: a typo still finds the client, filters, recent items");
  await manager.goto(`${BASE}/team`);
  await founder.keyboard.press("Control+k");
  const box = founder.getByRole("combobox", { name: "Search everything" });
  await box.fill("sunrse realty");
  const hit = founder.locator("#global-search-results").getByRole("option").filter({ hasText: "Sunrise Realty Pvt Ltd" }).first();
  await hit.waitFor();
  check(await founder.getByTestId("close-match").count(), "results found despite the typo are marked Close match");
  await founder.getByTestId("search-filters").getByRole("button", { name: "Projects" }).click();
  await founder.waitForFunction(() => {
    const g = [...document.querySelectorAll("#global-search-results p.uppercase")].map((p) => p.textContent);
    return g.length === 1;
  }, null, { timeout: 10000 }).catch(() => undefined);
  const groups = await founder.locator("#global-search-results p.uppercase").allInnerTexts();
  check(groups.length === 1 && /projects/i.test(groups[0]), `the Projects filter shows only projects (${groups.join(", ")})`);
  await shot(founder, "live-search");
  await founder.locator("#global-search-results").getByRole("option").first().click();
  await founder.waitForURL(/\/team\/projects\//);
  check(true, "opening a result goes to the project");
  await founder.keyboard.press("Control+k");
  await founder.getByTestId("search-recent").waitFor();
  check((await founder.getByTestId("search-recent").innerText()).includes("Sunrise Realty"), "the project is listed under Recent");
  await founder.keyboard.press("Escape");

  console.log("6. System health and feature switches");
  await founder.goto(`${BASE}/admin/system`);
  await founder.getByRole("heading", { name: "System health" }).waitFor();
  check(await founder.getByRole("link", { name: "System Health" }).count(), "System Health is in the Command Centre menu");
  await founder.getByText("Live updates", { exact: true }).first().waitFor();
  check(await founder.getByText("Search index", { exact: true }).count(), "the event bus listeners are listed");
  const people = await founder.getByText("People online now").locator("..").innerText();
  check(/\d/.test(people), `shows people online (${people.replace(/\s+/g, " ")})`);
  await founder.getByRole("button", { name: "Rebuild index" }).click();
  await founder.getByText(/Search index rebuilt: [\d,]+ records/).waitFor();
  check(true, "the search index can be rebuilt");
  await shot(founder, "system-health");

  // Switch presence off: the faces disappear for everyone, then come back.
  await manager.goto(`${BASE}/team/leads/${lead.id}`);
  const peek = await newPage(browser);
  await signIn(peek, "founder@bmu.demo");
  await peek.goto(`${BASE}/team/leads/${lead.id}`);
  await manager.getByTestId("presence").waitFor({ timeout: 15000 });
  await founder.getByRole("switch", { name: "Who else is here" }).click();
  restoreFlag = true;
  await founder.getByText("Who else is here is now off").waitFor();
  await manager.getByTestId("presence").waitFor({ state: "detached", timeout: 10000 });
  check(true, "switching presence off hides the faces on open screens");
  await founder.getByRole("switch", { name: "Who else is here" }).click();
  await founder.getByText("Who else is here is now on").waitFor();
  restoreFlag = false;
  await manager.getByTestId("presence").waitFor({ timeout: 30000 });
  check(true, "switching it back on brings them back");
  await peek.context().close();

  console.log("7. Not for everyone");
  const sales = await newPage(browser);
  await signIn(sales, "sales@bmu.demo");
  check((await apiCall(sales, "GET", "/system/health")).status === 403, "a sales executive cannot open System health");
  check((await apiCall(sales, "PATCH", "/system/flags/presence", { enabled: false, roles: [] })).status === 403, "or change a feature switch");
  const flags = (await apiCall(sales, "GET", "/system/flags")).body;
  check(flags.live_updates === true && flags.smart_search === true, "but gets their own switches");

  for (const p of [founder, manager, sales]) check(p.errors.length === 0, `no page errors (${p.errors.slice(0, 3).join(" | ")})`);
} finally {
  if (restoreFlag) await apiCall(founder, "PATCH", "/system/flags/presence", { enabled: true, roles: [] }).catch(() => undefined);
  await browser.close();
}
done();
