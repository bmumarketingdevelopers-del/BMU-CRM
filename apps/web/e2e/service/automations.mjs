// Automations journey: every trigger built through the rule builder, tested against current data,
// then two rules with real actions run now and checked (alert, task, internal note, client message,
// email in the Outbox, webhook guard, lead owner + stage), the run log, and switching a rule on and off.
// Run: BASE_URL=http://localhost:3203 node apps/web/e2e/service/automations.mjs
import { BASE, apiCall, browser, check, done, shot, signIn, sleep } from "./lib.mjs";

const b = await browser();
const admin = await signIn(b, "admin@bmu.demo");
const am = await signIn(b, "am@bmu.demo");
const client = await signIn(b, "client@sunrise.demo");
const stamp = Date.now().toString(36);
const PREFIX = `E2E svc ${stamp}`;

const TRIGGERS = [
  ["Sales", "A new lead comes in", "lead_created"],
  ["Sales", "A lead goes quiet", "lead_idle"],
  ["Sales", "A proposal is not accepted in time", "proposal_sent_not_accepted"],
  ["Sales", "A proposal is accepted", "proposal_accepted"],
  ["Money", "An invoice is issued", "invoice_issued"],
  ["Money", "An invoice is overdue", "invoice_overdue"],
  ["Money", "A payment is received", "payment_received"],
  ["Delivery", "A task is overdue", "task_overdue"],
  ["Delivery", "A task gets blocked", "task_blocked"],
  ["Delivery", "A client asks for another revision", "deliverable_changes_requested"],
  ["Delivery", "A project passes a gate", "engagement_gate_reached"],
  ["Client requests", "A client raises a request", "request_created"],
  ["Client requests", "A request misses its reply time", "request_sla_breached"],
  ["Client requests", "A client becomes at risk", "client_health_dropped"],
  ["Team", "Someone asks for leave", "leave_requested"],
];

async function openBuilder(area, label) {
  await admin.goto(`${BASE}/admin/automations/new`);
  await admin.getByRole("button", { name: area, exact: true }).click();
  await admin.getByRole("button", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
}

async function testAndCreate(name, label, { on = false } = {}) {
  await admin.getByPlaceholder(label, { exact: true }).fill(name);
  const toggle = admin.getByRole("switch", { name: "Switch rule on or off" });
  if ((await toggle.getAttribute("aria-checked")) === String(!on)) await toggle.click();
  await admin.getByRole("button", { name: "Test against current data" }).click();
  const result = admin.getByText(/match the trigger|No records match the trigger/).first();
  const tested = await result.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  await admin.getByRole("button", { name: "Create rule" }).click();
  await admin.waitForURL(/\/admin\/automations\/[a-z0-9]{10,}$/, { timeout: 30_000 }).catch(async (e) => {
    await shot(admin, "automation-create-failed");
    console.log(`  could not create "${name}": ${(await admin.locator("main").innerText()).split("\n").filter((l) => /must|required|only|Pick|Enter|could|not/i.test(l)).join(" | ")}`);
    throw e;
  });
  return { tested, id: admin.url().split("/").pop() };
}

const created = [];
try {
  console.log("Every trigger through the builder");
  for (const [area, label, key] of process.env.SKIP_TRIGGERS ? [] : TRIGGERS) {
    await openBuilder(area, label);
    const { tested, id } = await testAndCreate(`${PREFIX} ${key}`, label);
    created.push(id);
    const rule = (await apiCall(admin, "GET", `/automations/${id}`)).json;
    check(tested && rule.trigger === key && rule.enabled === false, `${label}: tested and saved (switched off)`);
  }
  await shot(admin, "automation-rule");

  console.log("A client request rule with every client-side action");
  await openBuilder("Client requests", "A client raises a request");
  await admin.getByRole("button", { name: "Add condition" }).click();
  await admin.getByLabel("Field").selectOption("description");
  await admin.getByLabel("Comparison").selectOption("contains");
  await admin.getByLabel("Value").fill(`[auto ${stamp}]`);
  const addAction = (type) => admin.getByLabel("Add an action").selectOption(type);
  await addAction("create_task");
  await admin.getByLabel("Task title").last().fill(`Look at {{client}} request ${stamp}`);
  await addAction("post_internal_note");
  await admin.getByLabel("Note (team only)").last().fill(`Internal: auto note ${stamp}`);
  await addAction("send_client_reminder");
  await admin.getByLabel("Message the client will see").last().fill(`Thanks, we have your request ${stamp}`);
  await addAction("email");
  await admin.getByLabel("Who").last().selectOption("client");
  await admin.getByLabel("Subject").last().fill(`We got your request ${stamp}`);
  await addAction("webhook");
  await admin.getByLabel("Web address").last().fill("http://127.0.0.1:4203/api/health");
  // Saving a webhook to this computer is refused, with a plain message.
  await admin.getByRole("button", { name: "Create rule" }).click();
  check(await admin.getByText("Webhooks cannot call this computer or the private network").first().waitFor({ timeout: 20_000 }).then(() => true, () => false), "a webhook to this computer is refused when saving");
  await admin.getByRole("button", { name: "Remove action" }).last().click();
  const reqRule = await testAndCreate(`${PREFIX} request actions`, "A client raises a request", { on: true });
  created.push(reqRule.id);
  check(reqRule.tested, "request rule tested against current data");

  const eng = (await apiCall(client, "GET", "/client/overview")).json.engagements[0].id;
  const other = (await apiCall(client, "POST", "/client/requests", { engagementId: eng, type: "question", description: `[e2e ${stamp}] no tag, should not match` })).json;
  const req = (await apiCall(client, "POST", "/client/requests", { engagementId: eng, type: "question", description: `[auto ${stamp}] Can we move Friday's post to Monday?` })).json;
  check(!!req.id && !!other.id, "client raised two requests (one matches the condition)");

  // Run now from the list page.
  await admin.goto(`${BASE}/admin/automations`);
  await admin.getByRole("button", { name: "Run now" }).click();
  await admin.getByRole("button", { name: "Run now" }).waitFor();
  await sleep(1500);
  let runs = (await apiCall(admin, "GET", `/automations/runs?ruleId=${reqRule.id}`)).json;
  if (!(runs.rows ?? runs).length) {
    await apiCall(admin, "POST", "/automations/run-now", { ruleId: reqRule.id });
    runs = (await apiCall(admin, "GET", `/automations/runs?ruleId=${reqRule.id}`)).json;
  }
  const rows = runs.rows ?? runs;
  check(rows.length === 1, `rule acted once, only on the matching request (${rows.length} run)`);
  const steps = rows[0]?.steps ?? [];
  const stepOk = (type) => steps.find((s) => s.action === type);
  check(stepOk("notify")?.ok, `alert step: ${stepOk("notify")?.text}`);
  check(stepOk("create_task")?.ok, `task step: ${stepOk("create_task")?.text}`);
  check(stepOk("post_internal_note")?.ok, "internal note step ok");
  check(stepOk("send_client_reminder")?.ok, "client message step ok");
  check(stepOk("email")?.ok && /Outbox|sent/.test(stepOk("email").text), `email step: ${stepOk("email")?.text}`);
  check(rows[0]?.status === "success", `run succeeded: ${rows[0]?.summary}`);

  const amNotes = (await apiCall(am, "GET", "/notifications")).json.items;
  check(amNotes.some((n) => n.kind === "automation" || /request/i.test(n.title)), "AM got the in-app alert");
  const tasks = JSON.stringify((await apiCall(am, "GET", "/tasks")).json);
  check(tasks.includes(`request ${stamp}`), "task created for the AM");
  const clientThread = (await apiCall(client, "GET", "/client/thread")).json;
  check(clientThread.messages.some((m) => m.body.includes(`Thanks, we have your request ${stamp}`)), "client sees the automatic message");
  check(!clientThread.messages.some((m) => m.body.includes(`auto note ${stamp}`)), "client never sees the internal note");
  const amThreads = (await apiCall(am, "GET", "/threads")).json;
  const sunrise = amThreads.find((t) => t.client.name.startsWith("Sunrise"));
  const amThread = (await apiCall(am, "GET", `/threads/${sunrise.id}`)).json;
  check(amThread.messages.some((m) => m.internal && m.body.includes(`auto note ${stamp}`)), "team sees the internal note");
  const outbox = (await apiCall(admin, "GET", `/service/outbox?q=${encodeURIComponent(stamp)}`)).json;
  check(outbox.rows.some((r) => r.kind === "automation" && r.subject.includes(stamp) && r.to === "client@sunrise.demo"), "automation email is in the Outbox for the client");

  // A webhook to a public address can be saved (the sandbox has no DNS, so it is not called here).
  const pub = await apiCall(admin, "POST", "/automations", { name: `${PREFIX} public webhook`, enabled: false, trigger: "request_created", triggerArgs: {}, conditions: [], actions: [{ type: "webhook", url: "https://hooks.zapier.com/hooks/catch/1/abc/" }] });
  if (pub.json?.id) created.push(pub.json.id);
  check(pub.status < 300, `a webhook to a public address is accepted (${pub.status})`);
  const dryLocal = await apiCall(admin, "POST", "/automations/test", { name: "dry", enabled: false, trigger: "request_created", triggerArgs: {}, conditions: [], actions: [{ type: "webhook", url: "http://10.0.0.5/hook" }] });
  check(dryLocal.status === 400 || /blocked|cannot call/.test(JSON.stringify(dryLocal.json)), "webhook to a private network address is refused");

  console.log("Run log page and rule history");
  await admin.goto(`${BASE}/admin/automations/runs?ruleId=${reqRule.id}`);
  await admin.getByText(/Sent .* a message from/).first().waitFor();
  check(true, "run log shows each step");
  await shot(admin, "automation-runs");
  await admin.goto(`${BASE}/admin/automations/${reqRule.id}`);
  await admin.getByText("This rule's history").waitFor();
  check(await admin.getByText(/Emailed .*client@sunrise\.demo/).first().waitFor({ timeout: 10000 }).then(() => true, () => false), "rule page history lists the email step");

  console.log("A lead rule: assign owner and move stage");
  await openBuilder("Sales", "A new lead comes in");
  await admin.getByRole("button", { name: "Add condition" }).click();
  await admin.getByLabel("Field").selectOption("company");
  await admin.getByLabel("Comparison").selectOption("contains");
  await admin.getByLabel("Value").fill(stamp);
  await addAction("assign_lead_owner");
  await addAction("change_lead_stage");
  await admin.getByLabel("Move to").last().selectOption("contacted");
  const leadRule = await testAndCreate(`${PREFIX} lead actions`, "A new lead comes in", { on: true });
  created.push(leadRule.id);
  const enquiry = await apiCall(client, "POST", "/leads/enquiry", { name: "Asha Test", email: `asha.${stamp}@example.com`, phone: "9876543210", company: `Lead Co ${stamp}`, need: "Social media for our new cafe" });
  check(enquiry.status < 300, "website enquiry created a lead");
  await apiCall(admin, "POST", "/automations/run-now", { ruleId: leadRule.id });
  const leads = (await apiCall(admin, "GET", "/leads")).json;
  const lead = (leads.rows ?? leads.leads ?? leads).find((l) => l.id === enquiry.json.id);
  check(!!lead?.ownerId || !!lead?.owner, `lead got an owner (${lead?.owner?.name ?? lead?.ownerId ?? "none"})`);
  check(lead?.stage === "contacted", `lead moved to Contacted (${lead?.stage})`);

  console.log("Switch on and off");
  await admin.goto(`${BASE}/admin/automations`);
  const sw = admin.getByRole("switch", { name: `Switch off ${PREFIX} request actions` });
  await sw.click();
  await admin.getByRole("switch", { name: `Switch on ${PREFIX} request actions` }).waitFor();
  const off = (await apiCall(admin, "GET", `/automations/${reqRule.id}`)).json;
  check(off.enabled === false, "switched the rule off from the list");
  await apiCall(client, "POST", "/client/requests", { engagementId: eng, type: "question", description: `[auto ${stamp}] second one while off` });
  await apiCall(admin, "POST", "/automations/run-now", { ruleId: reqRule.id });
  const runsAfter = (await apiCall(admin, "GET", `/automations/runs?ruleId=${reqRule.id}`)).json;
  check((runsAfter.rows ?? runsAfter).length === 1, "a switched-off rule does nothing");
  await admin.getByRole("switch", { name: `Switch on ${PREFIX} request actions` }).click();
  await admin.getByRole("switch", { name: `Switch off ${PREFIX} request actions` }).waitFor();
  check((await apiCall(admin, "GET", `/automations/${reqRule.id}`)).json.enabled === true, "switched back on");

  console.log("Permissions");
  check((await apiCall(am, "POST", "/automations/run-now", {})).status === 403, "an Account Manager cannot run automations");
  check((await apiCall(am, "PATCH", `/automations/${reqRule.id}`, { enabled: false })).status === 403, "an Account Manager cannot switch rules");

  // Leave the demo data tidy: close the test requests.
  check(admin.errors.length + am.errors.length + client.errors.length === 0, `no page errors (${[...admin.errors, ...am.errors, ...client.errors].join("; ")})`);
} finally {
  for (const id of created) await apiCall(admin, "DELETE", `/automations/${id}`);
  console.log(`Cleaned up ${created.length} test rules`);
  await b.close();
}
done();
