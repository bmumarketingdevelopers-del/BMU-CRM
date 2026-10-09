// v20 journey: intelligence. The Founder's dashboard shows the revenue forecast and clients at risk, each with
// reasons; the Metrics page lists every number with its formula; an alert is added and checked; a scheduled
// report is set up and its PDF previewed; a company goal follows a metric and a producer checks in on their own
// goal. HR sees no money in Forecast & Risks.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/intelligence/intelligence.mjs
import { apiCall, check, done, launch, newPage, shot, signIn, BASE } from "../team/lib.mjs";

const browser = await launch();
const founder = await newPage(browser);
const producer = await newPage(browser);
const stamp = Date.now().toString(36);

try {
  console.log("1. Forecast & risks on the founder dashboard");
  await signIn(founder, "founder@bmu.demo");
  await founder.goto(`${BASE}/admin`);
  await founder.getByText("Clients at risk of leaving").waitFor({ timeout: 90_000 });
  check(true, "clients at risk are on the dashboard");
  check(await founder.getByText(/Next month about ₹/).count(), "the revenue forecast shows next month's amount");
  const o = (await apiCall(founder, "GET", "/intelligence/overview")).body;
  check(o.revenue && o.revenue.reasons.length > 0, `the revenue forecast has reasons (${o.revenue?.reasons.map((r) => r.label).slice(0, 2).join("; ")})`);
  check(o.churn.length > 0 && o.churn.every((c) => c.reasons.length > 0), `each client at risk has reasons (${o.churn.length} clients)`);
  check(o.win.every((w) => w.reasons.length > 0), "each likely deal has reasons");
  await shot(founder, "intelligence-dashboard");

  console.log("2. Forecast & Risks page and Metrics");
  await founder.goto(`${BASE}/admin/intelligence`);
  await founder.getByRole("heading", { name: "Forecast & Risks", level: 1 }).waitFor();
  await founder.getByText("Work likely to slip").waitFor();
  check(await founder.getByText(/built-in model|forecasting service/).count(), "the page says which model worked it out");
  await shot(founder, "intelligence-page");
  await founder.goto(`${BASE}/admin/intelligence/metrics`);
  await founder.getByText("Monthly recurring revenue").waitFor({ timeout: 30_000 });
  check(await founder.getByText(/Monthly fee of every live retainer/).count(), "each metric shows its formula");
  await shot(founder, "intelligence-metrics");

  console.log("3. Alerts");
  await founder.goto(`${BASE}/admin/intelligence/alerts`);
  await founder.getByRole("heading", { name: "Alerts", level: 1 }).waitFor();
  await founder.getByText("Built in").first().waitFor();
  check((await founder.getByText("Built in").count()) >= 4, "four built-in alerts are ready");
  await founder.getByRole("button", { name: "New alert" }).click();
  await founder.getByLabel("Name").fill(`Overdue pile-up ${stamp}`);
  await founder.getByLabel("Number to watch").selectOption("overdue_tasks");
  await founder.getByLabel("When it").selectOption("above");
  await founder.getByLabel("Value").fill("0");
  await founder.getByRole("button", { name: "Save alert" }).click();
  await founder.getByText(`Overdue pile-up ${stamp}`).waitFor();
  await founder.getByRole("button", { name: "Check now" }).click();
  await founder.getByText(/alerts? fired:|Nothing to alert on/).waitFor({ timeout: 30_000 });
  const ev = (await apiCall(founder, "GET", "/intelligence/alerts")).body.events;
  check(ev.some((e) => e.alertName === `Overdue pile-up ${stamp}`), "the new alert fires when overdue tasks are above 0");
  await shot(founder, "intelligence-alerts");

  console.log("4. Scheduled report");
  await founder.goto(`${BASE}/admin/intelligence/reports`);
  await founder.getByRole("button", { name: "New report" }).click();
  await founder.getByLabel("Name").fill(`Monday numbers ${stamp}`);
  await founder.getByLabel("Email to (separate with commas)").fill("founder@bmu.demo");
  await founder.getByRole("button", { name: "Save report" }).click();
  await founder.getByText(`Monday numbers ${stamp}`).waitFor();
  check(await founder.getByText(/Every Monday at 09:00 IST/).count(), "the schedule is described in words");
  const rep = (await apiCall(founder, "GET", "/intelligence/reports")).body.reports.find((r) => r.name === `Monday numbers ${stamp}`);
  const pdf = await founder.evaluate(async (id) => {
    const r = await fetch(`/api/intelligence/reports/${id}/pdf`);
    const b = new Uint8Array(await r.arrayBuffer());
    return { type: r.headers.get("content-type"), head: String.fromCharCode(...b.slice(0, 5)), size: b.length };
  }, rep.id);
  check(pdf.type === "application/pdf" && pdf.head === "%PDF-" && pdf.size > 500, `the PDF preview is a real PDF (${pdf.size} bytes)`);
  await founder.getByRole("button", { name: "Send now" }).first().click();
  await founder.getByText(/Sent to 1 recipient/).waitFor({ timeout: 30_000 });
  check(true, "Send now emails it");
  await shot(founder, "intelligence-reports");

  console.log("5. Goals");
  await founder.goto(`${BASE}/admin/intelligence/goals`);
  await founder.getByRole("button", { name: "New goal" }).click();
  await founder.getByLabel("Goal").fill(`Grow MRR ${stamp}`);
  await founder.getByLabel("Target (₹)").fill("2000000");
  await founder.getByRole("button", { name: "Save goal" }).click();
  await founder.locator("li", { hasText: `Grow MRR ${stamp}` }).waitFor();
  check(await founder.locator("li", { hasText: `Grow MRR ${stamp}` }).getByText(/follows Monthly recurring revenue/).count(), "the company goal follows MRR automatically");

  await signIn(producer, "producer@bmu.demo");
  await producer.goto(`${BASE}/team/goals`);
  await producer.getByRole("heading", { name: "Goals", level: 1 }).waitFor();
  await producer.getByText("Company goals", { exact: true }).waitFor();
  check(await producer.getByText(`Grow MRR ${stamp}`).count(), "the team sees company goals");
  await producer.getByRole("button", { name: "New goal" }).click();
  await producer.getByLabel("Goal").fill(`Ship 20 reels ${stamp}`);
  await producer.getByLabel("Target").fill("20");
  await producer.getByLabel("Unit").fill("reels");
  await producer.getByRole("button", { name: "Save goal" }).click();
  const row = producer.locator("li", { hasText: `Ship 20 reels ${stamp}` });
  await row.waitFor();
  await row.getByLabel("Current value").fill("8");
  await row.getByRole("button", { name: "Check in" }).click();
  await row.getByText(/8 reels of 20 reels/).waitFor().catch(async (e) => {
    await shot(producer, "intelligence-goals-fail");
    throw e;
  });
  check(true, "a check-in moves a personal goal");
  await shot(producer, "intelligence-goals");

  console.log("6. Money stays with money roles");
  const hr = await newPage(browser);
  await signIn(hr, "hr@bmu.demo");
  const hrView = await apiCall(hr, "GET", "/intelligence/overview");
  check(hrView.status === 403 || (hrView.body.revenue === null && hrView.body.churn.every((c) => c.value === 0)), "HR sees no revenue forecast or money at risk");
  const pm = await apiCall(producer, "GET", "/intelligence/metrics/mrr");
  check(pm.status === 403, "a producer cannot read MRR");
} finally {
  await browser.close();
}
done();
