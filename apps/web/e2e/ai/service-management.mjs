// Journey (basic mode): AM triages a client request and puts a suggested reply in the reply box (not sent until they
// click Reply). On a message thread the AM gets a suggested reply in the composer and a tone check. The Founder sees
// the weekly digest and "What stands out" notes on the Weekly Review and Scorecard, then uses Command Centre → AI
// Copilot to switch delivery features off (panels disappear) and back on.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/ai/service-management.mjs
import { launch, newPage, signIn, shot, check, finish, BASE, apiAs } from "./lib.mjs";

const browser = await launch();

console.log("1. Request: triage and suggested reply");
const am = await newPage(browser, "am");
await signIn(am, "am@bmu.demo");
const requests = (await apiAs(am, "GET", "/requests")).body;
const req = requests.find((r) => ["received", "scope_check"].includes(r.status) && r.can?.decide) ?? requests[0];
await am.goto(`${BASE}/team/requests/${req.id}`);
const before = (await apiAs(am, "GET", `/requests/${req.id}`)).body.comments.length;
const tri = am.getByRole("region", { name: "Triage" });
if (await tri.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
  await tri.getByRole("button", { name: "Triage request" }).click();
  await tri.getByRole("button", { name: "Copy" }).waitFor();
  check(/scope/i.test(await tri.innerText()), "triage says whether it is in scope");
} else console.log("  skip request already decided, no triage");
const rep = am.getByRole("region", { name: "Suggested reply" });
await rep.getByRole("button", { name: "Suggest reply" }).click();
await rep.getByRole("button", { name: "Put in reply box" }).click();
const boxText = await am.getByPlaceholder("Reply to the client, or add a note to send with an action").inputValue();
check(boxText.length > 20, "suggested reply lands in the reply box");
const afterInsert = (await apiAs(am, "GET", `/requests/${req.id}`)).body.comments.length;
check(afterInsert === before, "nothing is sent to the client until the AM clicks Reply");
await shot(am, "10-request-ai");

console.log("2. Message thread: suggested reply and tone");
const threads = (await apiAs(am, "GET", "/threads")).body;
const th = threads[0];
await am.goto(`${BASE}/team/messages/${th.id}`);
const trep = am.getByRole("region", { name: "Suggested reply" });
await trep.getByRole("button", { name: "Suggest reply" }).click();
await trep.getByRole("button", { name: "Put in message box" }).click();
const composer = am.locator("form textarea").first();
check((await composer.inputValue()).length > 10, "suggested reply lands in the message composer");
const tone = am.getByRole("region", { name: "How is the client feeling?" });
await tone.getByRole("button", { name: "Check tone" }).click();
await tone.getByRole("button", { name: "Copy" }).waitFor();
check(/Unhappy|Urgent|Happy|Neutral/.test(await tone.innerText()), "tone check gives a plain label");
await shot(am, "11-thread-ai");

console.log("3. Founder: digest, anomaly notes, settings");
const f = await newPage(browser, "founder");
await signIn(f, "founder@bmu.demo");
await f.goto(`${BASE}/admin`);
const dg = f.getByRole("region", { name: "Weekly digest" });
await dg.waitFor();
await dg.getByRole("button", { name: /Write this week's digest|Refresh now/ }).click();
await dg.getByText("What changed this week").waitFor();
check(/recommended actions/i.test(await dg.innerText()), "digest ends with recommended actions");
const ws = f.getByRole("region", { name: "What stands out" });
await ws.getByRole("button", { name: "Explain the numbers" }).click();
await ws.getByRole("button", { name: "Copy" }).waitFor();
check((await ws.innerText()).length > 80, "weekly anomaly notes are written");
await shot(f, "12-weekly-digest");
await f.goto(`${BASE}/admin/analytics`);
const sc = f.getByRole("region", { name: "What stands out" });
await sc.getByRole("button", { name: "Explain the numbers" }).click();
await sc.getByRole("button", { name: "Copy" }).waitFor();
check((await sc.innerText()).length > 80, "scorecard anomaly notes are written");
await shot(f, "13-scorecard-notes");

await f.goto(`${BASE}/admin/ai`);
await f.getByText("AI Copilot is running in basic mode").waitFor();
check(await f.getByText("console.anthropic.com").isVisible(), "page explains how to add the key");
await shot(f, "14-ai-settings");
const delivery = f.getByLabel(/^Delivery:/);
await delivery.uncheck();
await f.getByRole("button", { name: "Save settings" }).click();
await f.getByText("Saved. Changes apply straight away.").waitFor();
const head = await newPage(browser, "design head");
await signIn(head, "design.head@bmu.demo");
const engs = (await apiAs(head, "GET", "/engagements")).body;
let did = null;
for (const e of engs.slice(0, 20)) {
  const d = (await apiAs(head, "GET", `/engagements/${e.id}`)).body;
  if (d.deliverables?.length) {
    did = d.deliverables[0].id;
    break;
  }
}
await head.goto(`${BASE}/team/deliverables/${did}`);
await head.getByText("Review Studio").waitFor();
await head.waitForTimeout(1000);
check((await head.getByRole("region", { name: "Creative brief" }).count()) === 0, "delivery AI tools disappear when switched off");
const off = await apiAs(head, "POST", "/ai/generate", { feature: "creative_brief", targetId: did });
check(off.status === 403, "API refuses a switched-off feature");
await delivery.check();
await f.getByRole("button", { name: "Save settings" }).click();
await f.getByText("Saved. Changes apply straight away.").waitFor();
check((await apiAs(head, "POST", "/ai/generate", { feature: "creative_brief", targetId: did })).status < 300, "switched back on");

const usage = (await apiAs(f, "GET", "/ai/usage")).body;
check(usage.month.calls > 0 && usage.recent.length > 0, "every call shows in the usage log");

await browser.close();
finish();
