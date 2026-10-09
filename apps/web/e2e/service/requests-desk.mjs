// Journey: client request desk end to end.
// Client raises every request type → AM inbox with working-hour reply timers → scope decisions →
// quote from the add-on list (and a Founder custom price) → approver can't approve → owner approves →
// pays (dev test payment) → work task created → AM marks done → client rates and can reopen.
// Plus decline / reschedule / question reply paths, and notifications deep links on both sides.
import { BASE, apiCall, browser, check, done, shot, signIn, sleep } from "./lib.mjs";

const stamp = Date.now().toString().slice(-6);
const b = await browser();
const client = await signIn(b, "client@sunrise.demo");
const am = await signIn(b, "am@bmu.demo");
const founder = await signIn(b, "founder@bmu.demo");
const approver = await signIn(b, "approver@sunrise.demo");

console.log("Client raises one request of every type");
const types = [
  ["change", "Change something"],
  ["new_scope", null],
  ["urgent", null],
  ["question", null],
  ["billing", null],
];
await client.goto(`${BASE}/client/requests`);
await client.getByRole("button", { name: "Send request" }).waitFor();
const labels = await client.locator("form label span.font-medium").allTextContents();
check(labels.length === 5, `request form offers 5 types (${labels.join(", ")})`);
const ids = {};
for (let i = 0; i < types.length; i++) {
  const [type] = types[i];
  await client.locator("form input[type=radio]").nth(i).check();
  await client.getByPlaceholder("What do you need?").fill(`[e2e ${stamp}] ${type} request from the client journey`);
  await Promise.all([client.waitForResponse((r) => r.url().endsWith("/api/client/requests") && r.request().method() === "POST"), client.getByRole("button", { name: "Send request" }).click()]);
  await client.getByText(/Got it\./).waitFor();
  const list = await apiCall(client, "GET", "/client/requests");
  const r = list.json.find((x) => x.description.includes(`[e2e ${stamp}] ${type}`));
  ids[type] = r?.id;
  check(!!r && r.type === type, `${type}: created and listed (${r?.status})`);
}
await client.getByText(`[e2e ${stamp}] billing`).first().waitFor();
check((await client.locator(`a:has-text("[e2e ${stamp}]")`).count()) >= 5, "client list shows all five");

console.log("AM inbox shows them with working-hours reply timers");
await am.goto(`${BASE}/team/requests`);
await am.getByText(`[e2e ${stamp}] urgent`).first().waitFor();
check((await am.locator(`a:has-text("[e2e ${stamp}]")`).count()) === 5, "all five in the AM inbox");
check((await am.locator(`a:has-text("[e2e ${stamp}] urgent") >> text=/Reply in|Reply overdue/`).count()) === 1, "urgent request shows a reply timer");
const notes = await apiCall(am, "GET", "/notifications");
check(notes.json.items.some((n) => n.kind === "request_created" && n.link === `/team/requests/${ids.urgent}` && n.critical), "AM got a critical bell alert linking to the urgent request");

console.log("Change request: in scope → work task → done → client rates → reopen");
await am.goto(`${BASE}/team/requests/${ids.change}`);
await am.getByRole("button", { name: "In scope: start work" }).click();
await am.getByRole("button", { name: "Mark done" }).waitFor();
const tasks = await apiCall(am, "GET", "/tasks?scope=mine");
check(JSON.stringify(tasks.json).includes(`[e2e ${stamp}] change`), "work task created for the AM");
await am.getByPlaceholder(/Reply to the client/).fill("All fixed, please have a look.");
await am.getByRole("button", { name: "Mark done" }).click();
await am.getByText("Client satisfaction").waitFor();
await client.goto(`${BASE}/client/requests/${ids.change}`);
await client.getByText("How did we do?").waitFor();
check((await client.getByText("All fixed, please have a look.").count()) > 0, "client sees the AM's note");
await client.getByPlaceholder("Anything to add? (optional)").fill("Super quick, thanks");
await client.getByRole("button", { name: "Thumbs up" }).click();
await client.getByTestId("request-rating").waitFor();
check((await client.getByTestId("request-rating").textContent()).includes("thumbs up"), "client rated thumbs up");
await am.goto(`${BASE}/team/requests/${ids.change}`);
check((await am.getByTestId("team-request-rating").textContent()).includes("Happy"), "AM sees the rating");
await client.getByRole("button", { name: "Reopen it" }).click();
await client.getByPlaceholder("What still needs fixing?").fill("The footer link is still wrong");
await client.getByRole("button", { name: "Reopen request" }).click();
await client.getByText(/Reopened once/).waitFor();
const reopened = await apiCall(client, "GET", `/client/requests/${ids.change}`);
check(reopened.json.status === "in_progress" && reopened.json.reopenCount === 1, "request reopened and back in progress");
const amNotes = await apiCall(am, "GET", "/notifications");
check(amNotes.json.items.some((n) => n.kind === "request_reopened" && n.link === `/team/requests/${ids.change}`), "AM alerted about the reopen");
await shot(client, "requests-client-reopened");

console.log("Extra request: AM quotes from the add-on list → approver can't approve → owner approves → pays → task");
await am.goto(`${BASE}/team/requests/${ids.new_scope}`);
const addOnSelect = am.locator("select").first();
await am.waitForFunction(() => (document.querySelector("select")?.options.length ?? 0) > 1);
const opts = await addOnSelect.locator("option").allTextContents();
check(opts.length > 1, `add-on price list loaded (${opts.length - 1} priced add-ons)`);
await addOnSelect.selectOption({ index: 1 });
await am.getByPlaceholder("Timeline, e.g. 3 working days").fill("3 working days");
check((await am.getByPlaceholder(/custom amount/).count()) === 0, "AM cannot enter a custom price");
await am.getByRole("button", { name: "Send quote for approval" }).click();
await am.getByText(/Quote/).first().waitFor();
await sleep(500);
const q = await apiCall(am, "GET", `/requests/${ids.new_scope}`);
check(q.json.status === "quoted" && q.json.quote?.amountPaise > 0, `quoted ${q.json.quote?.totalPaise / 100} incl. GST`);
await approver.goto(`${BASE}/client/requests/${ids.new_scope}`);
await approver.getByText("Quote", { exact: true }).waitFor();
check((await approver.getByText("Only your account owner can approve extra costs").count()) === 1, "approver sees they cannot approve");
const appr = await apiCall(approver, "POST", `/client/requests/${ids.new_scope}/approve-quote`);
check(appr.status === 403, "API refuses approval from the approver (403)");
const ownerNotes = await apiCall(client, "GET", "/notifications");
check(ownerNotes.json.items.some((n) => n.kind === "request_quote" && n.link === `/client/requests/${ids.new_scope}`), "owner got a quote alert deep-linking to the request");
await client.goto(`${BASE}/client/requests/${ids.new_scope}`);
await client.getByRole("button", { name: "Approve quote" }).click();
await client.getByText(/Approved by/).waitFor();
await client.getByRole("button", { name: /^Pay / }).click();
await client.getByText(/Paid ✓/).waitFor({ timeout: 15000 });
const paid = await apiCall(client, "GET", `/client/requests/${ids.new_scope}`);
check(paid.json.status === "paid" && paid.json.invoice?.status === "paid", "request paid, invoice paid");
const amTasks = await apiCall(am, "GET", "/tasks?scope=mine");
check(JSON.stringify(amTasks.json).includes(`Extra request: [e2e ${stamp}] new_scope`), "paid extra request created a work task");
await am.goto(`${BASE}/team/requests/${ids.new_scope}`);
await am.getByRole("button", { name: "Mark done" }).click();
await am.getByText("Client satisfaction").waitFor();
await client.goto(`${BASE}/client/requests`);
check((await client.locator(`a:has-text("[e2e ${stamp}] new_scope")`).textContent()).match(/Done|done/i) !== null, "client list shows it done");

console.log("Urgent: accept → done. Question: reply. Billing: decline. Founder custom quote → owner declines.");
await am.goto(`${BASE}/team/requests/${ids.urgent}`);
await am.getByRole("button", { name: "Accept urgent request" }).click();
await am.getByRole("button", { name: "Mark done" }).click();
await am.getByText("Client satisfaction").waitFor();
await am.goto(`${BASE}/team/requests/${ids.question}`);
await am.getByPlaceholder(/Reply to the client/).fill("Your next report goes out on Monday.");
await am.getByRole("button", { name: "Reply", exact: true }).click();
await am.getByText("Your next report goes out on Monday.").first().waitFor();
// The reply can show on screen (live updates) a moment before the request records its first-reply time.
let qv = await apiCall(am, "GET", `/requests/${ids.question}`);
for (let i = 0; i < 20 && qv.json.sla.state !== "met"; i++) {
  await am.waitForTimeout(250);
  qv = await apiCall(am, "GET", `/requests/${ids.question}`);
}
check(qv.json.sla.state === "met", `first reply recorded on time (SLA met: ${JSON.stringify(qv.json.sla)})`);
await am.getByPlaceholder(/Reply to the client/).fill("Internal: check with SEO team");
await am.getByLabel("🔒 Internal").check();
await am.getByRole("button", { name: "Add internal note" }).click();
await am.getByText("Internal: check with SEO team").waitFor();
const cq = await apiCall(client, "GET", `/client/requests/${ids.question}`);
check(cq.json.comments.some((c) => c.body.includes("Monday")) && !cq.json.comments.some((c) => c.body.includes("Internal:")), "client sees the reply but not the internal note");
await am.goto(`${BASE}/team/requests/${ids.billing}`);
await am.getByPlaceholder(/Reply to the client/).fill("This is covered by your retainer invoice, nothing extra to pay.");
await am.getByRole("button", { name: "Decline with note" }).click();
await sleep(800);
check((await apiCall(am, "GET", `/requests/${ids.billing}`)).json.status === "declined", "billing request declined with a note");

// Reschedule + founder custom price on a fresh request
const extra = await apiCall(client, "POST", "/client/requests", { engagementId: (await apiCall(client, "GET", `/client/requests/${ids.change}`)).json.engagement.id, type: "new_scope", description: `[e2e ${stamp}] custom work needing a Founder price` });
await founder.goto(`${BASE}/team/requests/${extra.json.id}`);
await founder.getByPlaceholder(/custom amount/).fill("12500");
await founder.getByPlaceholder("Timeline, e.g. 3 working days").fill("Next week");
await founder.getByRole("button", { name: "Send quote for approval" }).click();
await sleep(800);
const fq = await apiCall(founder, "GET", `/requests/${extra.json.id}`);
check(fq.json.quote?.amountPaise === 1250000, "Founder sent a custom ₹12,500 quote");
await client.goto(`${BASE}/client/requests/${extra.json.id}`);
await client.getByPlaceholder("Reason (optional)").fill("Not this month");
await client.getByRole("button", { name: "Decline" }).click();
await client.getByText(/Declined|declined/).first().waitFor();
check((await apiCall(client, "GET", `/client/requests/${extra.json.id}`)).json.status === "declined", "owner declined the quote");
const rs = await apiCall(client, "POST", "/client/requests", { engagementId: fq.json.engagement.id, type: "change", description: `[e2e ${stamp}] change to do next cycle` });
await am.goto(`${BASE}/team/requests/${rs.json.id}`);
await am.getByPlaceholder(/Reply to the client/).fill("We'll do this in the next cycle.");
await am.getByPlaceholder("Timeline, e.g. 3 working days").fill("Next cycle");
await am.getByRole("button", { name: /Reschedule/ }).click();
await sleep(800);
check((await apiCall(am, "GET", `/requests/${rs.json.id}`)).json.status === "rescheduled", "request rescheduled");

console.log("SLA breaches are visible (AM lead sees the whole team)");
const lead = await signIn(b, "am.lead@bmu.demo");
const leadList = await apiCall(lead, "GET", "/requests");
check(leadList.status === 200, "AM lead can open the team request desk");
const late = leadList.json.filter((r) => r.sla.state === "overdue" || r.sla.state === "breached");
check(late.length > 0, `AM lead sees ${late.length} late request(s) across the team`);
const amCount = (await apiCall(am, "GET", "/requests")).json.length;
check(leadList.json.length >= amCount, `AM lead sees at least what one AM sees (${leadList.json.length} vs ${amCount})`);
await lead.goto(`${BASE}/team/requests`);
const lateBadge = lead.getByText(/Reply overdue|Replied late/).first();
check(await lateBadge.waitFor({ timeout: 30_000 }).then(() => true, () => false), "late requests are flagged in the inbox (Reply overdue / Replied late)");
if (late.some((r) => r.sla.state === "overdue")) check(await lead.getByText(/past the first-reply target/).isVisible(), "inbox header counts requests past the first-reply target");
await shot(lead, "requests-lead-sla");

console.log("Bell deep links work on both sides");
for (const [page, who] of [[client, "client"], [am, "AM"]]) {
  const list = (await apiCall(page, "GET", "/notifications")).json.items.filter((n) => n.link).slice(0, 8);
  for (const n of list) {
    const r = await page.goto(`${BASE}${n.link}`);
    const status = r?.status() ?? 0;
    check(status < 400 && !(await page.getByText("This page could not be found").count()), `${who} bell link opens: ${n.kind} → ${n.link}`);
  }
}
await shot(am, "requests-am-inbox");

const errors = [client, am, founder, approver, lead].flatMap((p) => p.errors);
check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(" | ")})`);
await b.close();
done();
