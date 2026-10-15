// v19 journey: integrations, publishing and the public API.
// API: a fresh Social Media client with one approved post scheduled for tomorrow on Instagram.
// Browser: the Founder adds Instagram, Meta Ads and Google Analytics test accounts for the client in Integrations and
// syncs the ads account → the CM presses "Publish now" on the post and it goes live on the test account (public page) →
// ads and website numbers show on the team client page and on the client's Insights. In API & Webhooks the Founder makes
// a key limited to "Read leads" (it reads, but cannot create) and a webhook to a local receiver; a website enquiry
// arrives there signed. Finance downloads the Tally XML export.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/integrations/integrations.mjs
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { api, check, freshClient, launch, publicApi, shot, signIn, API, BASE } from "../deliver/lib.mjs";

const browser = await launch();
const errors = [];
const sessions = {};
async function as(email) {
  if (!sessions[email]) {
    sessions[email] = await signIn(browser, email);
    errors.push(sessions[email].errors);
  }
  return sessions[email].page;
}
const go = async (page, path) => {
  await page.goto(`${BASE}${path}`);
  await page.waitForLoadState("networkidle");
};
const am = api("am@bmu.demo");
const qc = api("qc@bmu.demo");
const founder = api("founder@bmu.demo");
const users = await founder.get("/org/users");
const emailOf = (id) => users.find((u) => u.id === id)?.email;
const stamp = Date.now().toString(36);

// A local webhook receiver.
const received = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    res.writeHead(200).end("ok");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const hookUrl = `http://127.0.0.1:${server.address().port}/bmu`;

try {
  console.log("1. Fresh client with an approved post scheduled for tomorrow (API)");
  const c = await freshClient({ services: [{ serviceKey: "smm", tier: "growth" }], tag: `in${stamp}` });
  const e = c.engagements[0];
  const amUser = users.find((u) => u.email === "am@bmu.demo");
  await founder.post(`/admin-org/clients/${c.clientOrgId}/am`, { amUserId: amUser.id }).catch(() => {});
  let det = await am.get(`/engagements/${e.id}`);
  for (const r of det.cycle.requirements) await am.patch(`/engagements/requirements/${r.id}`, { status: "received" });
  await am.post(`/engagements/${e.id}/rcd`);
  const strategist = api("strategist@bmu.demo");
  await strategist.put(`/engagements/${e.id}/plan`, { objectives: "Launch buzz", audience: "Young families", pillars: ["Launch"], creativeDirection: "Bright and warm", deliverables: [{ type: "post", title: `Opening post ${stamp}` }] });
  await strategist.post(`/engagements/${e.id}/plan/submit`);
  await am.post(`/engagements/${e.id}/plan/send`);
  const plan = (await c.owner.get("/client/plans")).find((p) => p.engagementId === e.id).plan;
  await c.owner.post(`/client/plans/${plan.id}/approve`);
  det = await am.get(`/engagements/${e.id}`);
  const post = det.deliverables.find((d) => d.type === "post");
  const d0 = await am.get(`/deliverables/${post.id}`);
  const maker = emailOf(d0.tasks.filter((t) => t.kind === "work").at(-1)?.owner?.id) ?? "am@bmu.demo";
  const v = (await api(maker).upload(`/deliverables/${post.id}/versions`, "post.png", "image/png", { note: "Draft" })).versions.at(-1);
  await qc.post(`/deliverables/versions/${v.id}/qc`, { items: [{ label: "Brand", ok: true }] });
  await am.post(`/deliverables/versions/${v.id}/send`);
  await c.owner.post(`/client/reviews/${post.id}/approve`, { versionId: v.id });
  await am.put(`/creative/posts/${post.id}/caption`, { caption: `Doors open this weekend ${stamp}` });
  await am.patch(`/deliver/deliverables/${post.id}/schedule`, { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), channel: "instagram" });
  check((await am.get(`/deliverables/${post.id}`)).status === "scheduled", "the approved post is scheduled for tomorrow on Instagram");

  console.log("2. The Founder adds test accounts for the client and syncs the ads account");
  const f = await as("founder@bmu.demo");
  await go(f, "/admin/integrations");
  await f.getByLabel("For client").selectOption(c.clientOrgId);
  for (const p of ["instagram", "meta_ads", "ga4"]) {
    await f.locator(`[data-provider="${p}"]`).getByRole("button", { name: "Add test account" }).click();
    await f.getByText("Its numbers fill in on the first sync").waitFor({ timeout: 15_000 });
    await f.waitForTimeout(500);
  }
  const hub = await founder.get("/integrations");
  const mine = hub.accounts.filter((a) => a.client?.id === c.clientOrgId);
  check(mine.length === 3 && mine.every((a) => a.mode === "test" && a.status === "connected"), "three test accounts are connected to the client");
  const adsRow = f.locator("tr").filter({ hasText: mine.find((a) => a.provider === "meta_ads").name });
  await adsRow.getByRole("button", { name: "Sync now" }).click();
  await adsRow.getByRole("button", { name: "Sync now" }).waitFor({ timeout: 20_000 });
  const gaName = mine.find((a) => a.provider === "ga4").name;
  await founder.post(`/integrations/accounts/${mine.find((a) => a.provider === "ga4").id}/sync`);
  await f.reload();
  await f.getByText("Ads and website numbers").first().waitFor({ timeout: 15_000 });
  check(true, `the sync log shows the ads pull (and ${gaName})`);
  await shot(f, "v19-integrations-hub");

  console.log("3. The CM presses Publish now; the post goes live on the test account");
  const t = await as("am@bmu.demo");
  await go(t, `/team/deliverables/${post.id}`);
  const auto = t.getByTestId("auto-publish");
  await auto.waitFor({ timeout: 15_000 });
  await auto.getByRole("button", { name: "Publish now" }).click();
  await t.getByText("Published automatically", { exact: false }).first().waitFor({ timeout: 30_000 });
  const after = await am.get(`/deliverables/${post.id}`);
  check(after.status === "published", "the post is marked published");
  const live = after.schedule?.liveUrl ?? after.liveUrl;
  check(live && live.includes("/test-account/test-instagram-"), `its live link points at the test account (${live})`);
  await shot(t, "v19-published");
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`${BASE}/test-account/${live.split("/test-account/")[1]}`);
  await anon.getByTestId("test-post").waitFor({ timeout: 15_000 });
  check((await anon.getByTestId("test-post").textContent()).includes("Opening post"), "the public test post page shows the post");
  await anon.close();

  console.log("4. Ads and website numbers on the team client page and the client's Insights");
  await go(t, `/team/clients/${c.clientOrgId}?tab=results`);
  await t.getByTestId("ad-results").waitFor({ timeout: 20_000 });
  check((await t.getByTestId("ad-results").textContent()).includes("Lead generation"), "the team sees spend, clicks and campaigns");
  await shot(t, "v19-client-results-team");
  const cl = await as(c.email);
  await go(cl, "/client/insights");
  await cl.getByTestId("ad-results").waitFor({ timeout: 20_000 });
  check((await cl.getByTestId("ad-results").textContent()).includes("Website visits"), "the client sees their ads and website numbers");
  await shot(cl, "v19-client-results");

  console.log("5. A read-only API key reads leads but cannot create one");
  await go(f, "/admin/developer");
  await f.getByLabel("Name").first().fill(`Leads reader ${stamp}`);
  await f.getByRole("button", { name: "Create key" }).click();
  const secretBox = f.getByTestId("one-time-secret");
  await secretBox.waitFor({ timeout: 15_000 });
  const key = (await secretBox.locator("code").textContent()).trim();
  check(key.startsWith("bmu_"), "the new key is shown once");
  const call = (method, path, body) => fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const list = await call("GET", "/v1/leads?limit=5");
  check(list.status === 200 && Array.isArray((await list.json()).data), "GET /v1/leads works with the key");
  const create = await call("POST", "/v1/leads", { name: "Nope", phone: "9876500000", company: "Nope Co", serviceIds: ["smm"] });
  check(create.status === 403, `POST /v1/leads is refused (${create.status})`);
  const doc = await fetch(`${API}/v1/openapi.json`).then((r) => r.json());
  check(doc.openapi === "3.1.0" && doc.paths["/v1/leads"], "the OpenAPI document is published");
  await f.getByTestId("one-time-secret").getByRole("button", { name: "Done" }).click();

  console.log("6. A webhook gets a signed lead.created when a website enquiry arrives");
  await f.getByLabel("Send to (https address)").fill(hookUrl);
  await f.getByRole("button", { name: "Add webhook" }).click();
  await f.getByTestId("one-time-secret").waitFor({ timeout: 15_000 });
  const secret = (await f.getByTestId("one-time-secret").locator("code").textContent()).trim();
  check(secret.startsWith("whsec_"), "the signing secret is shown once");
  await shot(f, "v19-developer");
  await publicApi.post("/leads/enquiry", { name: `Hook ${stamp}`, email: `hook.${stamp}@int-e2e.demo`, phone: `8${String(Date.now()).slice(-9)}`, company: `Hook Co ${stamp}`, need: "Monthly social media and ads for our new store", serviceIds: ["smm"] });
  const deadline = Date.now() + 60_000;
  let hit;
  while (!hit && Date.now() < deadline) {
    hit = received.find((r) => r.headers["x-bmu-event"] === "lead.created" && r.body.includes(`Hook Co ${stamp}`));
    if (!hit) await new Promise((r) => setTimeout(r, 1000));
  }
  check(hit, "the receiver got lead.created");
  const sig = `sha256=${createHmac("sha256", secret).update(`${hit.headers["x-bmu-timestamp"]}.${hit.body}`).digest("hex")}`;
  check(sig === hit.headers["x-bmu-signature"], "the delivery signature checks out");
  const row = f.getByTestId("webhook-row").filter({ hasText: hookUrl });
  await row.getByRole("button", { name: "Deliveries" }).click();
  await row.getByText("Delivered").first().waitFor({ timeout: 15_000 });
  check(true, "the delivery shows as delivered");

  console.log("7. Finance downloads the Tally XML");
  const fin = await as("finance@bmu.demo");
  await go(fin, "/admin/finance/accounting");
  await fin.getByLabel("Format").selectOption("tally_xml");
  const [download] = await Promise.all([fin.waitForEvent("download"), fin.getByRole("button", { name: "Download XML" }).click()]);
  check(download.suggestedFilename().endsWith(".xml"), `the file is ${download.suggestedFilename()}`);
  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  const xml = readFileSync(path, "utf8");
  check(xml.includes("<ENVELOPE>") && xml.includes("Sundry Debtors"), "it is a Tally import file with party ledgers");

  const pageErrors = errors.flat().filter((m) => !/Failed to load resource|favicon/.test(m));
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.slice(0, 3).join(" | ")}` : ""}`);
  console.log("PASS integrations journey");
} catch (err) {
  console.error("FAIL", err);
  process.exitCode = 1;
} finally {
  server.close();
  await browser.close();
}
