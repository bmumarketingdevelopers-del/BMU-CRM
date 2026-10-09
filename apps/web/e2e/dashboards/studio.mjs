// v12 Dashboard Studio journey: edit a built-in dashboard (hide, move, add, change, save, history, reset), build a
// custom dashboard for the sales team's home, check what each role sees, edit the client home, and the forbidden roles.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/dashboards/studio.mjs
import { apiCall, check, done, launch, newPage, shot, signIn, BASE } from "../team/lib.mjs";

const stamp = Date.now().toString(36);
const browser = await launch();
const founder = await newPage(browser);
const cleanup = { reset: new Set(), archive: [] };

async function openEditorFor(page, name) {
  await page.goto(`${BASE}/admin/dashboards`);
  await page.locator("main").getByRole("link", { name, exact: true }).first().click();
  await page.getByTestId("dashboard-editor").waitFor();
  await page.getByTestId("edit-cell").first().waitFor();
}
const cell = (page, label) => page.locator(`[data-testid="edit-cell"][data-label="${label}"]`);

try {
  console.log("1. Founder opens the Dashboard Studio");
  await signIn(founder, "founder@bmu.demo");
  await founder.goto(`${BASE}/admin/dashboards`);
  await founder.getByText("Built-in dashboards").waitFor();
  for (const n of ["Weekly Review", "Scorecard", "My Day", "Manager workspace", "Specialist workspace", "Client home"]) check(await founder.locator("main").getByRole("link", { name: n, exact: true }).count(), `${n} is listed`);
  check(await founder.getByRole("link", { name: "Dashboard Studio" }).count(), "Dashboard Studio is in the Command Centre menu");
  await shot(founder, "dash-studio");

  console.log("2. Edit the Weekly Review: hide, move, resize, add a number, change it, save");
  await openEditorFor(founder, "Weekly Review");
  const wr = (await apiCall(founder, "GET", "/dashboards/builtin/command_centre")).body;
  cleanup.reset.add(wr.id);
  await cell(founder, "Pipeline by stage").waitFor();
  await founder.getByRole("button", { name: "Hide Pipeline by stage" }).click();
  check((await cell(founder, "Pipeline by stage").count()) === 0, "Pipeline section hidden");
  check(await founder.getByTestId("hidden-sections").getByText("Pipeline by stage").count(), "hidden sections are listed so they can come back");
  await founder.getByRole("button", { name: "Move Clients at risk up" }).click();
  const order = await founder.getByTestId("edit-cell").evaluateAll((els) => els.map((e) => e.getAttribute("data-label")));
  check(order.indexOf("Clients at risk") < order.indexOf("Overdue invoices"), "Clients at risk moved above Overdue invoices");
  await founder.getByLabel("Width of Blocked tasks").selectOption("full");
  await founder.getByTestId("add-widget").click();
  await founder.getByTestId("widget-library").getByRole("button", { name: "Numbers", exact: true }).click();
  await founder.getByRole("button", { name: "Add Leads", exact: true }).click();
  await cell(founder, "Leads").waitFor();
  check(true, "a Leads number was added from the library");
  await founder.getByRole("button", { name: "Move Leads up" }).waitFor();
  for (let i = 0; i < 12; i++) {
    const up = founder.getByRole("button", { name: "Move Leads up" });
    if (await up.isDisabled()) break;
    await up.click();
  }
  await founder.getByRole("button", { name: "Change Leads" }).click();
  await founder.getByTestId("widget-settings").getByLabel("Title").fill("New leads this month");
  await founder.getByTestId("widget-settings").getByLabel("Period").selectOption("this_month");
  await founder.getByTestId("widget-settings").getByRole("button", { name: "Apply" }).click();
  await cell(founder, "New leads this month").waitFor();
  check(true, "the number's title and period were changed");
  await founder.getByLabel("Note for the history").fill(`Journey ${stamp}`);
  await founder.getByTestId("save-dashboard").click();
  await founder.getByText("Saved. People see the new layout").waitFor();
  await shot(founder, "dash-editor-weekly");

  await founder.goto(`${BASE}/admin`);
  await founder.getByText("New leads this month").waitFor();
  check(true, "Weekly Review shows the new number");
  check((await founder.getByText("Leads by stage").count()) === 0, "Weekly Review no longer shows the pipeline");
  const first = await founder.locator("[data-widget-id]").first().getAttribute("data-widget");
  check(first === "kpi", "the new number is first");
  await shot(founder, "dash-weekly-after");

  console.log("3. History: reset to original, then restore the saved version");
  await founder.getByTestId("customise-dashboard").click();
  await founder.getByTestId("dashboard-editor").waitFor();
  await founder.getByRole("button", { name: "More dashboard actions" }).click();
  await founder.getByRole("menuitem", { name: "Reset to original" }).click();
  await founder.getByTestId("editor-confirm").getByRole("button", { name: "Reset" }).click();
  await founder.getByText("Back to the original layout").waitFor();
  await cell(founder, "Pipeline by stage").waitFor();
  check((await cell(founder, "New leads this month").count()) === 0, "reset brings back the original layout");
  await founder.getByRole("button", { name: "More dashboard actions" }).click();
  await founder.getByRole("menuitem", { name: "History and restore" }).click();
  const hist = founder.getByTestId("dashboard-history");
  await hist.getByText(`Journey ${stamp}`).waitFor();
  check(await hist.getByText("Reset to original").count(), "History lists the reset");
  await hist.locator("li", { hasText: `Journey ${stamp}` }).getByRole("button", { name: "Restore" }).click();
  await founder.getByText("Earlier version restored").waitFor();
  await cell(founder, "New leads this month").waitFor();
  check(true, "restored the saved version from History");

  console.log("4. New dashboard for the sales team's home");
  await founder.goto(`${BASE}/admin/dashboards`);
  await founder.getByTestId("new-dashboard").click();
  const nd = founder.getByTestId("new-dashboard-drawer");
  await nd.getByRole("textbox", { name: "Name *" }).fill(`Sales floor ${stamp}`);
  await nd.getByLabel("What it is for").fill("Leads, wins and follow-ups for the sales team");
  await nd.getByText("Sales overview").click();
  await nd.getByLabel("Where it shows").selectOption("team_home");
  await nd.getByTestId("role-sales_executive").click();
  await nd.getByRole("button", { name: "Create and open the editor" }).click();
  await founder.getByTestId("dashboard-editor").waitFor();
  await founder.getByRole("heading", { name: `Sales floor ${stamp}` }).waitFor();
  const salesDashId = founder.url().split("/").pop();
  cleanup.archive.push(salesDashId);
  check((await founder.getByTestId("edit-cell").count()) >= 6, "started from the Sales overview template");
  await founder.getByTestId("add-widget").click();
  await founder.getByTestId("widget-library").getByRole("button", { name: "Notes & links", exact: true }).click();
  await founder.getByRole("button", { name: "Add Note", exact: true }).click();
  await founder.getByRole("button", { name: "Change Note" }).click();
  await founder.getByTestId("widget-settings").getByLabel("Title").fill("This week's goal");
  await founder.getByTestId("widget-settings").getByLabel("Text").fill(`Call every new lead within an hour ${stamp}`);
  await founder.getByTestId("widget-settings").getByRole("button", { name: "Apply" }).click();
  await founder.getByTestId("add-widget").click();
  await founder.getByTestId("widget-library").getByRole("button", { name: "Sections", exact: true }).click();
  await founder.getByTestId("widget-library").getByRole("button", { name: "Add My sales pipeline" }).click();
  await founder.getByTestId("save-dashboard").click();
  await founder.getByText("Saved. People see the new layout").waitFor();
  await shot(founder, "dash-editor-sales");

  console.log("5. A sales executive lands on it; others don't");
  const sales = await newPage(browser);
  await signIn(sales, "sales@bmu.demo");
  await sales.goto(`${BASE}/team`);
  await sales.getByRole("heading", { name: `Sales floor ${stamp}` }).waitFor();
  check(true, "the sales executive's home is the new dashboard");
  await sales.getByText(`Call every new lead within an hour ${stamp}`).waitFor();
  check(await sales.getByText("New leads to contact").count(), "the new-leads list shows");
  await sales.locator('[data-widget="kpi"]').first().getByText(/your own/).waitFor();
  check(true, "numbers are the sales executive's own");
  check((await sales.getByTestId("customise-dashboard").count()) === 0, "no Customise link for a sales executive");
  check(await sales.getByRole("link", { name: "Dashboards", exact: true }).count(), "Dashboards is in their menu");
  await shot(sales, "dash-sales-home");

  const finance = await newPage(browser);
  await signIn(finance, "finance@bmu.demo");
  await finance.goto(`${BASE}/team/dashboards/${salesDashId}`);
  await finance.getByText("has not been shared with you").waitFor();
  check(true, "finance cannot open a dashboard not made for them");

  console.log("6. Edit the client home: add a note, hide the Account Manager panel");
  await openEditorFor(founder, "Client home");
  const ch = (await apiCall(founder, "GET", "/dashboards/builtin/client_home")).body;
  cleanup.reset.add(ch.id);
  await founder.getByRole("button", { name: "Hide Your Account Manager" }).click();
  await founder.getByTestId("add-widget").click();
  const lib = founder.getByTestId("widget-library");
  check((await lib.getByRole("button", { name: "Numbers", exact: true }).count()) === 0, "no team numbers offered for the client home");
  await lib.getByRole("button", { name: "Notes & links", exact: true }).click();
  await lib.getByRole("button", { name: "Add Note", exact: true }).click();
  await founder.getByRole("button", { name: "Change Note" }).click();
  await founder.getByTestId("widget-settings").getByLabel("Title").fill("Festive hours");
  await founder.getByTestId("widget-settings").getByLabel("Text").fill(`We are closed 1 to 3 November ${stamp}`);
  await founder.getByTestId("widget-settings").getByRole("button", { name: "Apply" }).click();
  await founder.getByTestId("save-dashboard").click();
  await founder.getByText("Saved. People see the new layout").waitFor();
  const client = await newPage(browser);
  await signIn(client, "client@sunrise.demo");
  await client.goto(`${BASE}/client`);
  await client.getByText(`We are closed 1 to 3 November ${stamp}`).waitFor();
  check((await client.getByText("Your Account Manager").count()) === 0, "client home: note shown, Account Manager panel hidden");
  await shot(client, "dash-client-home");

  console.log("7. Every built-in editor opens with a live preview");
  for (const n of ["Scorecard", "My Day", "Manager workspace", "Specialist workspace"]) {
    await openEditorFor(founder, n);
    check((await founder.getByTestId("edit-cell").count()) >= 4, `${n} editor shows its sections`);
  }

  console.log("8. Forbidden: only the Founder and Admins change dashboards");
  const am = await newPage(browser);
  await signIn(am, "am@bmu.demo");
  check((await apiCall(am, "GET", "/dashboards")).status === 403, "an Account Manager cannot open the Studio");
  check((await apiCall(am, "PATCH", `/dashboards/${wr.id}`, { layout: [] })).status === 403, "an Account Manager cannot change a dashboard");
  check((await apiCall(sales, "POST", "/dashboards", { name: "x" })).status === 403, "a sales executive cannot create one");
  await am.goto(`${BASE}/team`);
  check((await am.getByTestId("customise-dashboard").count()) === 0, "no Customise link for an Account Manager");

  console.log("9. Phone width");
  const phone = await newPage(browser, { mobile: true });
  await signIn(phone, "founder@bmu.demo");
  await phone.goto(`${BASE}/admin/dashboards/${salesDashId}`);
  await phone.getByTestId("edit-cell").first().waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `editor fits a phone (${overflow}px sideways)`);
  await shot(phone, "dash-editor-phone");

  console.log("10. Archive the custom dashboard: the sales home goes back to My Day");
  await founder.goto(`${BASE}/admin/dashboards`);
  await founder.getByRole("button", { name: `Actions for Sales floor ${stamp}` }).click();
  await founder.getByRole("menuitem", { name: "Archive" }).click();
  await founder.getByTestId("archive-dashboard").getByLabel("Why").fill("Journey finished");
  await founder.getByTestId("archive-dashboard").getByRole("button", { name: "Archive" }).click();
  await founder.getByText("archived. Restore it from the Archived tab").waitFor();
  cleanup.archive = [];
  await sales.goto(`${BASE}/team`);
  await sales.getByText("End-of-day report").first().waitFor();
  check((await sales.getByRole("heading", { name: `Sales floor ${stamp}` }).count()) === 0, "sales home is My Day again");

  for (const p of [founder, sales, finance, client, am, phone]) check(p.errors.length === 0, `no page errors (${p.errors.slice(0, 3).join(" | ")})`);
} finally {
  for (const id of cleanup.reset) await apiCall(founder, "POST", `/dashboards/${id}/reset`).catch(() => {});
  for (const id of cleanup.archive) await apiCall(founder, "POST", `/dashboards/${id}/archive`, { reason: "Journey clean-up" }).catch(() => {});
  await browser.close();
}
done();
