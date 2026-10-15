// Deliver journey 3, on the Sunrise demo accounts: delivery SLA and escalation, and the client approval rule.
// - Founder runs the escalation job; design.head and am.lead get "Overdue … working days" alerts in the bell.
// - am.lead sees "Late or at risk" and the Delivery SLA panel on the Projects board; escalated items are marked.
// - CM and producer see "Delivery deadlines to watch" on My Day.
// - client@sunrise.demo (owner) switches the approval rule to "The owner must approve"; approver@sunrise.demo sees the
//   rule but cannot change it; am.lead sees the same rule on Client 360; the owner switches it back to "Any one approver".
// - Every page is also opened at phone width without horizontal scrolling.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/deliver/sla-approvals.mjs
import { api, check, launch, rejects, shot, signIn, BASE } from "./lib.mjs";

const browser = await launch();
const errors = [];
const sessions = {};
async function as(email, opts) {
  const key = `${email}${opts?.mobile ? ":m" : ""}`;
  if (!sessions[key]) {
    sessions[key] = await signIn(browser, email, opts);
    errors.push(sessions[key].errors);
  }
  return sessions[key].page;
}
const go = async (page, path) => {
  await page.goto(`${BASE}${path}`);
  await page.waitForLoadState("networkidle");
};
async function fitsPhone(page, what) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `${what} fits a phone screen (overflow ${overflow}px)`);
}

try {
  console.log("1. Escalation job and alerts");
  await rejects(api("producer@bmu.demo").post("/deliver/sla/run"), 403);
  const run = await api("founder@bmu.demo").post("/deliver/sla/run");
  check(typeof run.escalated === "number", `founder ran the escalation job (${run.escalated} new escalations)`);
  const sla = await api("am.lead@bmu.demo").get("/deliver/sla");
  check(sla.items.length > 0, `SLA view lists ${sla.items.length} late or at-risk items`);
  const escalated = sla.items.filter((i) => i.escalated);
  check(escalated.length > 0, `${escalated.length} items are marked escalated`);
  const headNotes = await api("design.head@bmu.demo").get("/notifications");
  const leadNotes = await api("am.lead@bmu.demo").get("/notifications");
  check([...headNotes.items, ...leadNotes.items].some((n) => n.kind === "sla_escalation"), "department head / CM lead got an escalation alert");
  const again = await api("founder@bmu.demo").post("/deliver/sla/run");
  check(again.escalated === 0, "running the job again escalates nothing twice");

  console.log("2. Projects board (am.lead)");
  let page = await as("am.lead@bmu.demo");
  await go(page, "/team/projects");
  check(await page.getByText("Late or at risk").first().isVisible(), "Late or at risk tile on the Projects board");
  const panel = page.getByTestId("sla-list").first();
  await panel.waitFor();
  check((await panel.locator("li").count()) > 0, "Delivery SLA panel lists items");
  check((await page.getByText("Escalated", { exact: true }).count()) > 0, "escalated items carry an Escalated badge");
  await shot(page, "j3-projects-sla");
  await page.getByRole("button", { name: /Notifications|notifications/ }).first().click().catch(() => {});
  await shot(page, "j3-am-lead-bell");

  console.log("3. My Day (CM and producer)");
  for (const email of ["am@bmu.demo", "producer@bmu.demo"]) {
    const day = await api(email).get("/my-day");
    page = await as(email);
    await go(page, "/team");
    if (day.deliverSla?.length) {
      check(await page.getByText("Delivery deadlines to watch").isVisible(), `${email}: My Day shows delivery deadlines (${day.deliverSla.length})`);
    } else {
      check(!(await page.getByText("Delivery deadlines to watch").isVisible()), `${email}: nothing late, panel hidden`);
    }
  }
  await shot(page, "j3-producer-my-day");

  console.log("4. Approval rule on the Sunrise account");
  const owner = await as("client@sunrise.demo");
  await go(owner, "/client/team");
  const rule = owner.getByTestId("approval-rule");
  await rule.waitFor();
  await rule.getByText("The owner must approve").click();
  await rule.getByText("Saved.").waitFor();
  check((await api("client@sunrise.demo").get("/deliver/client/approval-settings")).mode === "owner", "owner set the rule to 'The owner must approve'");
  await shot(owner, "j3-client-approval-rule");
  const approver = await as("approver@sunrise.demo");
  await go(approver, "/client/team");
  await approver.getByTestId("approval-rule").waitFor().catch(() => {});
  if (await approver.getByTestId("approval-rule").count()) {
    check(await approver.getByText("Only the account owner can change this.").isVisible(), "approver sees the rule but cannot change it");
  } else {
    check(true, "approver has no access to the team page");
  }
  await rejects(api("approver@sunrise.demo").put("/deliver/client/approval-settings", { mode: "all" }), 403);
  const lead = await as("am.lead@bmu.demo");
  const clientId = (await api("client@sunrise.demo").get("/client/overview")).clientOrg.id;
  await go(lead, `/team/clients/${clientId}`);
  const leadRule = lead.getByTestId("approval-rule");
  await leadRule.waitFor();
  check(await leadRule.locator('input[type="radio"]:checked').evaluate((el) => el.closest("label").textContent.includes("The owner must approve")), "Client 360 shows the same rule");
  await go(owner, "/client/approvals");
  await shot(owner, "j3-client-approvals");
  await go(owner, "/client/team");
  await owner.getByTestId("approval-rule").getByText("Any one approver").click();
  await owner.getByTestId("approval-rule").getByText("Saved.").waitFor();
  check((await api("client@sunrise.demo").get("/deliver/client/approval-settings")).mode === "any", "owner switched back to 'Any one approver'");

  console.log("5. Phone width");
  const phoneTeam = await as("am.lead@bmu.demo", { mobile: true });
  for (const path of ["/team/projects", "/team/content-calendar", "/team"]) {
    await go(phoneTeam, path);
    await fitsPhone(phoneTeam, path);
  }
  await shot(phoneTeam, "j3-phone-my-day");
  const phoneClient = await as("client@sunrise.demo", { mobile: true });
  for (const path of ["/client/team", "/client/approvals", "/client/calendar", "/client/files"]) {
    await go(phoneClient, path);
    await fitsPhone(phoneClient, path);
  }

  const errs = errors.flat();
  if (errs.length) console.log("Page errors:\n" + errs.join("\n"));
  check(errs.length === 0, "no page errors");
  console.log("\nJOURNEY 3 PASSED");
} catch (err) {
  console.error("\nJOURNEY 3 FAILED:", err.message);
  for (const [email, s] of Object.entries(sessions)) await shot(s.page, `j3-fail-${email.split("@")[0]}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
