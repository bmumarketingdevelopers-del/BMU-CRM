// Journey (basic mode): sales manager opens a lead, writes the AI brief, drafts a WhatsApp follow-up, turns meeting
// notes into a summary and saves it to the timeline with a follow-up date. Strategist drafts a monthly plan with AI and
// fills the plan form (not saved until they click Save). On a deliverable: creative brief, QC pre-check on pasted copy,
// and posting the result as an internal note. Nothing is ever sent to a client by the AI.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/ai/sales-delivery.mjs
import { launch, newPage, signIn, shot, check, finish, BASE, apiAs } from "./lib.mjs";

const browser = await launch();

console.log("1. Lead page: brief, follow-up draft, meeting notes");
const mgr = await newPage(browser, "sales manager");
await signIn(mgr, "sales.manager@bmu.demo");
const leads = (await apiAs(mgr, "GET", "/leads")).body;
const lead = leads.find((l) => !["won", "lost"].includes(l.stage) && l.contact?.phone) ?? leads.find((l) => !["won", "lost"].includes(l.stage));
await mgr.goto(`${BASE}/team/leads/${lead.id}`);
const brief = mgr.getByRole("region", { name: "AI lead brief" });
await brief.getByRole("button", { name: "Write brief" }).click();
await brief.getByRole("button", { name: "Regenerate" }).first().waitFor();
const briefText = await brief.innerText();
check(/next best action/i.test(briefText), "lead brief includes a next best action");
check(/Basic suggestions/.test(briefText), "brief is labelled as a basic suggestion");
await shot(mgr, "05-lead-brief");

await mgr.getByRole("tab", { name: "Follow-up draft" }).click();
const fu = mgr.getByRole("region", { name: "Follow-up draft" });
await fu.getByRole("radio", { name: "WhatsApp" }).click();
await fu.getByRole("button", { name: "Draft follow-up" }).click();
await fu.getByRole("button", { name: "Copy" }).waitFor();
await fu.getByRole("button", { name: "Edit" }).click();
const box = fu.getByLabel("Edit the draft");
await box.fill((await box.inputValue()) + "\nThanks!");
await fu.getByRole("button", { name: "Done editing" }).click();
check(await fu.getByText("Thanks!").isVisible(), "the draft can be edited before use");
await shot(mgr, "06-lead-followup");

await mgr.getByRole("tab", { name: "Meeting notes" }).click();
const mt = mgr.getByRole("region", { name: "Meeting notes → summary and actions" });
await mt.getByLabel("Notes or transcript").fill("Met the owner. Wants 12 posts and 4 reels a month from next month. Budget 45k. We will send the proposal by Thursday. Call again next week to confirm.");
await mt.getByRole("button", { name: "Summarise" }).click();
await mt.getByRole("button", { name: "Save to timeline" }).waitFor();
const mtText = await mt.innerText();
check(/Action items/i.test(mtText), "meeting summary lists action items");
check(/Follow-up/i.test(mtText), "meeting summary suggests a follow-up date");
await mt.getByRole("button", { name: "Save to timeline" }).click();
await mt.getByRole("button", { name: "Inserted ✓" }).waitFor();
const after = (await apiAs(mgr, "GET", `/sell/leads/${lead.id}`)).body;
check(JSON.stringify(after).includes("Action items"), "meeting summary is saved on the lead timeline");
await shot(mgr, "07-lead-meeting");

console.log("2. Strategist drafts the monthly plan");
const strat = await newPage(browser, "strategist");
await signIn(strat, "strategist@bmu.demo");
const engagements = (await apiAs(strat, "GET", "/engagements")).body;
let planned = null;
for (const e of engagements.slice(0, 30)) {
  const d = (await apiAs(strat, "GET", `/engagements/${e.id}`)).body;
  if (d.can?.editPlan && d.cycle?.rcdAt) {
    planned = d;
    break;
  }
}
if (planned) {
  await strat.goto(`${BASE}/team/projects/${planned.id}`);
  const pp = strat.getByRole("region", { name: "Draft the plan with AI" });
  await strat.getByRole("heading", { name: "Plan", exact: true }).waitFor();
  if (await pp.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
    await pp.getByRole("button", { name: "Draft plan" }).click();
    await pp.getByRole("button", { name: "Fill the plan form" }).click();
    await pp.getByRole("button", { name: "Inserted ✓" }).waitFor();
    const objectives = await strat.getByPlaceholder("What this month must achieve").inputValue();
    check(objectives.length > 10, "AI plan fills the plan form (objectives)");
    check((await strat.getByLabel("Title").count()) > 0, "AI plan adds deliverables to the form");
    await shot(strat, "08-plan-draft");
  } else check(false, "plan AI panel shows for a strategist who can edit the plan");
} else console.log("  skip no project with an editable plan in the seed");

console.log("3. Deliverable: creative brief, QC pre-check, internal note");
const head = await newPage(browser, "design head");
await signIn(head, "design.head@bmu.demo");
let deliverable = null;
for (const e of (await apiAs(head, "GET", "/engagements")).body.slice(0, 30)) {
  const d = (await apiAs(head, "GET", `/engagements/${e.id}`)).body;
  const pick = d.deliverables?.find((x) => ["post", "carousel", "reel"].includes(x.type));
  if (pick) {
    const full = (await apiAs(head, "GET", `/deliverables/${pick.id}`)).body;
    if (full.versions?.length && full.can?.internal) {
      deliverable = full;
      break;
    }
  }
}
check(!!deliverable, "found a deliverable with a version");
if (deliverable) {
  await head.goto(`${BASE}/team/deliverables/${deliverable.id}`);
  const cb = head.getByRole("region", { name: "Creative brief" });
  await cb.getByRole("button", { name: "Write brief" }).click();
  await cb.getByRole("button", { name: "Post as internal note" }).waitFor();
  check(/Objective/.test(await cb.innerText()), "creative brief has an objective");
  check(await head.getByRole("tab", { name: "Captions & hooks" }).isVisible(), "social deliverable offers captions");
  await head.getByRole("tab", { name: "QC pre-check" }).click();
  const qc = head.getByRole("region", { name: "QC pre-check" });
  await qc.getByLabel("Copy to check").fill("Best clinic in Bangalore!!! 100% guaranteed results. Call 98450 12345 now");
  await qc.getByRole("button", { name: "Check copy" }).click();
  await qc.getByRole("button", { name: "Post as internal note" }).waitFor();
  const qcText = await qc.innerText();
  check(/claim/i.test(qcText), "QC pre-check flags the risky claim");
  await qc.getByRole("button", { name: "Post as internal note" }).click();
  await qc.getByRole("button", { name: "Inserted ✓" }).waitFor();
  const fresh = (await apiAs(head, "GET", `/deliverables/${deliverable.id}`)).body;
  const note = fresh.comments.at(-1);
  check(note.internal === true, "the QC pre-check is posted as an internal note only");
  await shot(head, "09-deliverable-ai");
}

await browser.close();
finish();
