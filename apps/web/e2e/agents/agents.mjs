// v15 journey: the Founder sets up the Sales assistant (acting for the sales manager) and runs it on a website lead;
// the sales manager edits and approves the drafted reply in the Agent Inbox; the Founder undoes a step from the run
// log, runs the safety checks, switches the Analyst on and asks it a question with sources. A sales executive
// cannot reach the Agents page.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/agents/agents.mjs
import { apiCall, check, done, launch, newPage, shot, signIn, BASE } from "../team/lib.mjs";

const browser = await launch();
const founder = await newPage(browser);
const manager = await newPage(browser);
const sales = await newPage(browser);
const stamp = Date.now().toString(36);
const company = `Agent Cafe ${stamp}`;

try {
  console.log("1. Agents page");
  await signIn(founder, "founder@bmu.demo");
  await founder.goto(`${BASE}/admin/agents`);
  await founder.getByRole("heading", { name: "AI Agents", level: 1 }).waitFor();
  check(await founder.getByRole("link", { name: "AI Agents" }).count(), "AI Agents is in the Command Centre menu");
  check((await founder.locator('[data-testid^="agent-"]').count()) >= 4, "four agent cards");
  check(await founder.getByText(/No AI key yet/).count(), "basic mode is explained without a key");
  const card = founder.getByTestId("agent-sales_assistant");
  check(await card.getByText("Asks first (Agent Inbox)").count(), "client-facing actions are marked as asking first");
  await shot(founder, "agents-page");

  console.log("2. Switch the Sales assistant on, acting for the sales manager");
  const managerOption = await card.getByLabel("Sales assistant acts for").locator("option", { hasText: "Rahul Menon" }).getAttribute("value");
  await card.getByLabel("Sales assistant acts for").selectOption(managerOption);
  await founder.waitForTimeout(500);
  await card.getByRole("switch", { name: /Switch on Sales assistant/ }).click();
  await card.getByText("On", { exact: true }).waitFor();
  check(true, "the agent switches on");

  console.log("3. A website lead arrives and the agent runs");
  const enquiry = await apiCall(founder, "POST", "/leads/enquiry", {
    name: "Kavya Rao",
    email: `kavya.${stamp}@example.com`,
    phone: `98${String(Date.now()).slice(-8)}`,
    company,
    need: "Instagram and Facebook for our new cafe, about 12 posts a month",
    budgetRupees: 30000,
  });
  check(enquiry.status === 201 || enquiry.status === 200, "the enquiry is accepted");
  await card.getByRole("button", { name: "Run now" }).click();
  await founder.getByText(/Sales assistant ran/).waitFor({ timeout: 30_000 });
  check(true, "Run now processes the new lead");
  const runs = (await apiCall(founder, "GET", "/agents/runs?agent=sales_assistant")).body;
  const run = runs.find((r) => r.subject?.label === company);
  check(run && run.actions >= 3 && run.proposals >= 1, `the run scored, noted and set a follow-up, and asked first (${run?.actions} done, ${run?.proposals} asked)`);

  console.log("4. The sales manager approves the reply with an edit");
  await signIn(manager, "sales.manager@bmu.demo");
  await manager.goto(`${BASE}/team/agent-inbox`);
  await manager.getByRole("heading", { name: "Agent Inbox" }).waitFor();
  const proposal = manager.getByTestId("proposal").filter({ hasText: `Reply to ${company}` });
  await proposal.waitFor();
  await proposal.getByRole("button", { name: "Edit" }).click();
  const message = proposal.getByLabel("Message");
  await message.fill(`Hi Kavya, thanks for contacting BMU Marketing. Could we talk tomorrow at 11? (${stamp})`);
  await proposal.getByRole("button", { name: "Approve with my changes" }).click();
  await manager.getByRole("status").filter({ hasText: `Approved and done: Reply to ${company}` }).waitFor();
  check(true, "approving with an edit works");
  await shot(manager, "agent-inbox");
  const lead = (await apiCall(founder, "GET", `/sell/leads/${run.subject.id}`)).body;
  check(JSON.stringify(lead).includes(`(${stamp})`), "the edited reply is on the lead's timeline");

  console.log("5. Undo a step from the run log");
  await founder.goto(`${BASE}/admin/agents/runs/${run.id}`);
  const steps = founder.getByTestId("run-steps");
  await steps.waitFor();
  check(await steps.getByText(/Rahul Menon approved/).count(), "the approval shows in the run");
  const scoreStep = steps
    .locator("li")
    .filter({ hasText: /^.*Scored/ })
    .first();
  await scoreStep.getByRole("button", { name: "Undo" }).click();
  await founder.getByText(/Undone by Founder/).waitFor();
  check(true, "a single step can be undone");
  await shot(founder, "agent-run");

  console.log("6. Safety checks");
  await founder.goto(`${BASE}/admin/agents`);
  await founder.getByRole("button", { name: "Run safety checks" }).click();
  await founder.getByText(/All \d+ checks passed/).waitFor({ timeout: 60_000 });
  check(true, "all safety checks pass");

  console.log("7. Ask the Analyst");
  await founder
    .getByTestId("agent-analyst")
    .getByRole("switch", { name: /Switch on Analyst/ })
    .click();
  await founder.getByTestId("agent-analyst").getByText("On", { exact: true }).waitFor();
  await founder.getByLabel("Question for the Analyst").fill("What does the handling client revisions SOP say?");
  await founder.getByRole("button", { name: "Ask", exact: true }).click();
  const answer = founder.getByTestId("analyst-answer");
  await answer.waitFor({ timeout: 30_000 });
  check(await answer.getByText("Sources").count(), "the answer lists its sources");
  check(await answer.getByRole("link", { name: /Handling client revisions/ }).count(), "the SOP is linked");

  console.log("8. Not for everyone");
  await signIn(sales, "sales@bmu.demo");
  check((await apiCall(sales, "GET", "/agents")).status === 403, "a sales executive cannot open the Agents page");
  await sales.goto(`${BASE}/team/agent-inbox`);
  await sales.getByRole("heading", { name: "Agent Inbox" }).waitFor();
  await sales.getByText(/Nothing waiting/).waitFor();
  check(true, "their Agent Inbox is empty");

  for (const p of [founder, manager, sales]) check(p.errors.length === 0, `no page errors (${p.errors.slice(0, 3).join(" | ")})`);
} finally {
  // Agents left on would act on other journeys' leads.
  for (const key of ["sales_assistant", "request_triage", "producer", "analyst"]) await apiCall(founder, "PATCH", `/agents/${key}`, { enabled: false }).catch(() => undefined);
  await browser.close();
}
done();
