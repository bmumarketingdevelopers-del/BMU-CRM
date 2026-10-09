// v14 journey: the Founder adds a template workflow and edits it in the visual builder, adds a custom field, fills it
// on a lead, filters the board by it and sees it on a dashboard; builds a website form, a visitor sends it (also
// through the website embed), the new-lead workflow runs on that lead, and the run shows in the log. Pipeline
// stages get renamed, the WhatsApp queue fills, and a sales executive cannot reach any of it.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/workflows/workflows.mjs
import { apiCall, check, done, launch, newPage, shot, signIn, BASE } from "../team/lib.mjs";

const browser = await launch();
const founder = await newPage(browser);
const stamp = Date.now().toString(36);
let pipelineChanged = false;
const switchOff = [];

try {
  console.log("1. Workflows page and a template");
  await signIn(founder, "founder@bmu.demo");
  await founder.goto(`${BASE}/admin/workflows`);
  await founder.getByRole("heading", { name: "Workflows", level: 1 }).waitFor();
  check(await founder.getByRole("link", { name: "Workflow Runs" }).count(), "Workflows and Workflow Runs are in the menu");
  check((await founder.getByRole("heading", { level: 3 }).allInnerTexts()).length >= 7, "seven templates are offered");
  const overdueCard = founder.locator("article").filter({ hasText: "Overdue invoice: day 1, 7, 14 and 30" });
  await overdueCard.getByRole("button", { name: /Use this|Add another/ }).click();
  await founder.waitForURL(/\/admin\/workflows\/[a-z0-9]+$/);
  switchOff.push(founder.url().split("/").pop());
  await founder.getByText("Wait 6 days").waitFor();
  check(await founder.getByText("Rejected or no answer").count(), "the approval shows its two paths");
  check((await founder.getByText("Yes", { exact: true }).count()) >= 3, "each check shows a Yes path");
  await shot(founder, "workflow-builder");

  console.log("2. Edit a step and save a new version");
  await founder.getByRole("button", { name: /Wait 6 days/ }).click();
  const amount = founder.getByLabel("Wait for");
  await amount.fill("5");
  await founder.getByText("Wait 5 days").waitFor();
  await founder.getByRole("button", { name: "Save changes" }).click();
  await founder.getByText(/Saved as version 2/).waitFor();
  check(true, "editing a wait saves version 2");
  check(await founder.getByText("Live", { exact: true }).count(), "the versions list marks the live one");

  console.log("3. Build a workflow from scratch with + inserts");
  await founder.goto(`${BASE}/admin/workflows/new`);
  await founder.getByRole("heading", { name: "New workflow" }).waitFor();
  await founder.getByRole("button", { name: "Add a step here" }).last().click();
  await founder.getByRole("button", { name: /^Wait Pause for/ }).click();
  await founder.getByLabel("Wait for").fill("2");
  await founder.getByRole("button", { name: "Add a step here" }).last().click();
  await founder.getByRole("button", { name: /^If \/ else/ }).click();
  check((await founder.getByText("Nothing on this path: the workflow carries on below.").count()) === 2, "the new If step opens two empty paths");
  await founder.getByPlaceholder("A new lead comes in").fill(`Scratch flow ${stamp}`);
  await founder.getByRole("button", { name: "Test against current data" }).click();
  await founder.getByText(/Nothing was sent or changed/).waitFor();
  check(true, "testing a draft shows matches without changing anything");
  await founder.getByRole("button", { name: "Create workflow" }).click();
  await founder.waitForURL((u) => /\/admin\/workflows\/(?!new$)[a-z0-9]+$/.test(u.pathname));
  await founder.getByRole("button", { name: /Wait 2 days/ }).waitFor();
  check(true, "the new workflow saves with its wait and check");
  const scratchId = founder.url().split("/").pop();
  await apiCall(founder, "PATCH", `/workflows/${scratchId}`, { enabled: false });

  console.log("4. Custom field: add, fill on a lead, filter the board");
  await founder.goto(`${BASE}/admin/custom-fields`);
  await founder.getByRole("button", { name: "Add field" }).click();
  await founder.getByPlaceholder("e.g. Industry").fill(`Industry ${stamp}`);
  await founder.locator("select").filter({ hasText: "Short text" }).selectOption("select");
  await founder.getByPlaceholder(/Retail/).fill("Retail\nHealthcare\nEducation");
  await founder.getByRole("button", { name: "Add field" }).last().click();
  await founder.getByText(`Industry ${stamp}`).waitFor();
  const field = (await apiCall(founder, "GET", "/custom-fields?entity=lead")).body.find((f) => f.label === `Industry ${stamp}`);
  check(!!field, `the field was created with key ${field?.key}`);
  const leads = (await apiCall(founder, "GET", "/leads")).body.filter((l) => l.stage !== "won" && l.stage !== "lost");
  const lead = leads[0];
  await founder.goto(`${BASE}/team/leads/${lead.id}`);
  await founder.getByTestId("custom-fields").waitFor();
  await founder.getByRole("heading", { name: "More details" }).locator("..").locator("..").getByRole("button", { name: "Edit" }).click();
  await founder.getByTestId("custom-fields-form").getByLabel(`Industry ${stamp}`).selectOption("Healthcare");
  await founder.getByTestId("custom-fields-form").getByRole("button", { name: "Save" }).click();
  await founder.getByTestId("custom-fields").waitFor();
  const vals = (await apiCall(founder, "GET", `/custom-fields/values/lead/${lead.id}`)).body;
  check(vals.values[field.key] === "Healthcare", "the lead shows Healthcare under More details");
  await founder.goto(`${BASE}/team/leads?cf.${field.key}=Healthcare`);
  await founder.getByTestId("cf-filter").waitFor();
  await founder.getByText(/^1 of \d+ leads/).waitFor({ timeout: 15000 });
  check(true, "the lead board opened from a link is filtered to the one Healthcare lead");
  await shot(founder, "board-custom-filter");

  console.log("5. The field on a dashboard");
  const dash = await apiCall(founder, "POST", "/dashboards", { name: `Industries ${stamp}`, audience: { roles: ["founder"], userIds: [] } });
  const dashId = dash.body.id ?? dash.body.dashboard?.id;
  const put = await apiCall(founder, "PATCH", `/dashboards/${dashId}`, { layout: [{ id: "cf1", type: "custom_field", size: "half", entity: "lead", field: field.key, scope: "open" }] });
  check(put.status === 200, "a dashboard gets a custom field breakdown widget");
  await founder.goto(`${BASE}/team/dashboards/${dashId}`);
  await founder.getByText(/Leads by industry/i).waitFor();
  await founder.getByText("Healthcare").first().waitFor();
  check(true, "the dashboard shows leads by the custom field");

  console.log("6. A form, sent by a visitor, starts the new-lead workflow");
  await founder.goto(`${BASE}/admin/workflows`);
  const newLeadCard = founder.locator("article").filter({ hasText: "New lead: score, assign, welcome, follow up" });
  await newLeadCard.getByRole("button", { name: /Use this|Add another/ }).click();
  await founder.waitForURL(/\/admin\/workflows\/[a-z0-9]+$/);
  const newLeadFlowId = founder.url().split("/").pop();
  switchOff.push(newLeadFlowId);
  await founder.goto(`${BASE}/admin/forms`);
  await founder.getByRole("button", { name: "New form" }).click();
  await founder.waitForURL(/\/admin\/forms\/[a-z0-9]+$/);
  await founder.getByLabel("Add a question").selectOption("select");
  const q = founder.getByTestId("form-questions").locator("li").last();
  await q.getByRole("textbox").first().fill("Your industry");
  await q.locator("textarea").fill("Retail\nHealthcare");
  await q.locator("select").selectOption(field.key);
  await founder.getByRole("button", { name: "Save form" }).click();
  await founder.getByText("Saved. The live form has changed.").waitFor();
  const snippet = await founder.getByTestId("embed-code").inputValue();
  check(snippet.includes("<iframe") && snippet.includes("?embed=1"), "the website code is an iframe with a resize script");
  const slug = snippet.match(/\/f\/([a-z0-9-]+)\?embed=1/)[1];
  await shot(founder, "form-builder");

  const visitor = await newPage(browser);
  await visitor.goto(`${BASE}/f/${slug}`);
  await visitor.getByTestId("public-form").waitFor();
  await visitor.getByLabel(/Your name/).fill("Meera");
  await visitor.getByLabel(/Business name/).fill(`Meera Clinics ${stamp}`);
  await visitor.getByLabel(/Phone/).fill(`+91 98${String(Date.now()).slice(-8)}`);
  await visitor.getByLabel(/Your industry/).selectOption("Healthcare");
  await visitor.getByRole("button", { name: "Send" }).click();
  await visitor.getByTestId("form-done").waitFor();
  check(true, "the visitor sees the thank-you message");
  const formLead = (await apiCall(founder, "GET", "/leads")).body.find((l) => l.contact.company === `Meera Clinics ${stamp}`);
  check(!!formLead && formLead.source === "form", "the form created a lead");
  check(formLead?.customFields?.[field.key] === "Healthcare", "the answer was saved into the custom field");

  // The embed on a website: the frame resizes itself to the form.
  const site = await newPage(browser);
  await site.goto(`${BASE}/f/${slug}`);
  await site.setContent(`<html><body><h1>Client website</h1>${snippet.replace(/https?:\/\/[^/]+/, BASE)}</body></html>`);
  await site.waitForFunction((s) => parseInt(document.getElementById(`bmu-form-${s}`)?.style.height || "0", 10) > 300, slug, { timeout: 20000 });
  check(true, "the embedded form tells the website its height");
  await site.context().close();

  await founder.goto(`${BASE}/admin/workflows`);
  await founder.getByRole("button", { name: "Run now" }).click();
  await founder.getByText(/Started \d+ run|Checked every workflow/).waitFor();
  await founder.goto(`${BASE}/admin/workflows/runs?workflowId=${newLeadFlowId}`);
  const row = founder.locator("tr").filter({ hasText: `Meera Clinics ${stamp}` });
  await row.waitFor({ timeout: 20000 });
  check((await row.innerText()).includes("Waiting"), "the form lead is in the new-lead workflow, waiting 2 working days");
  await row.getByRole("button", { name: "Details" }).click();
  await founder.getByRole("dialog", { name: "Workflow run" }).getByText("(here now)").waitFor();
  check(await founder.getByText(/Queued a WhatsApp to Meera/).count(), "the run log shows the WhatsApp welcome");
  await shot(founder, "workflow-run");
  await founder.keyboard.press("Escape");

  console.log("7. WhatsApp queue in the Outbox");
  await founder.goto(`${BASE}/admin/outbox`);
  await founder.getByText("WhatsApp queue").waitFor();
  await founder.getByText(/Hi Meera, thank you for contacting BMU Marketing/).first().waitFor();
  check(true, "the welcome WhatsApp waits in the queue");

  console.log("8. Pipeline settings rename a stage on the board");
  await founder.goto(`${BASE}/admin/pipelines`);
  await founder.getByLabel("Name for Contacted").fill("First call");
  await founder.getByRole("button", { name: "Save changes" }).click();
  pipelineChanged = true;
  await founder.getByText("Saved.").waitFor();
  await founder.goto(`${BASE}/team/leads`);
  await founder.getByRole("region", { name: "First call column" }).waitFor();
  check(true, "the lead board shows the renamed stage");

  console.log("9. Not for everyone");
  const sales = await newPage(browser);
  await signIn(sales, "sales@bmu.demo");
  check((await apiCall(sales, "GET", "/workflows/overview")).status === 403, "a sales executive cannot open workflows");
  check((await apiCall(sales, "POST", "/custom-fields", { entity: "lead", label: "Nope", type: "text" })).status === 403, "or add custom fields");
  check((await apiCall(sales, "PUT", "/pipelines/lead", { stages: [] })).status === 403, "or change pipelines");
  await sales.goto(`${BASE}/team/leads/${formLead.id}`).catch(() => undefined);

  for (const p of [founder, visitor, sales]) check(p.errors.length === 0, `no page errors (${p.errors.slice(0, 3).join(" | ")})`);
} finally {
  // Leave the demo data as it was for the other journeys (the new-lead template would assign their leads).
  for (const id of switchOff) await apiCall(founder, "PATCH", `/workflows/${id}`, { enabled: false }).catch(() => undefined);
  if (pipelineChanged) await apiCall(founder, "DELETE", "/pipelines/lead").catch(() => undefined);
  await browser.close();
}
done();
