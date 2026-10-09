// v16 journey: the creative studio end to end.
// API: a fresh Social Media client with a reel and two posts in its plan; the maker uploads the reel (15 s video).
// Browser: the client pins a comment at 0:12 with a drawing → the Account Manager sees it appear live and on that frame →
// the client asks for changes → v2 arrives with the open comment carried over → the client approves v2 from the
// one-tap email link (no sign-in) → the certificate verifies. Calendar: unapproved work cannot be scheduled or published;
// the approved post is scheduled, published and its results typed in; the client sees the results. The approved reel is
// in both asset libraries and a new file uploads in pieces. Finally the client allows BMU sign-off and the AM approves a
// post on BMU's side.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/creative/creative.mjs
import { api, check, freshClient, launch, publicApi, rejects, shot, signIn, BASE } from "../deliver/lib.mjs";

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

async function makeVersion(id, file, mime, note) {
  const d = await am.get(`/deliverables/${id}`);
  const maker = emailOf(d.tasks.filter((t) => t.kind === "work").at(-1)?.owner?.id) ?? "am@bmu.demo";
  const after = await api(maker).upload(`/deliverables/${id}/versions`, file, mime, { note });
  return after.versions.at(-1);
}
async function passQc(versionId) {
  const d = await qc.post(`/deliverables/versions/${versionId}/qc`, { items: [{ label: "Brand", ok: true }] });
  return d;
}

try {
  console.log("1. Fresh client with a reel and two posts (API)");
  const c = await freshClient({ services: [{ serviceKey: "smm", tier: "growth" }], tag: `cr${stamp}` });
  const e = c.engagements[0];
  const amUser = users.find((u) => u.email === "am@bmu.demo");
  await founder.post(`/admin-org/clients/${c.clientOrgId}/am`, { amUserId: amUser.id }).catch(() => {});
  let det = await am.get(`/engagements/${e.id}`);
  for (const r of det.cycle.requirements) await am.patch(`/engagements/requirements/${r.id}`, { status: "received" });
  await am.post(`/engagements/${e.id}/rcd`);
  const strategist = api("strategist@bmu.demo");
  await strategist.put(`/engagements/${e.id}/plan`, {
    objectives: "Launch buzz",
    audience: "Young families",
    pillars: ["Launch"],
    creativeDirection: "Bright and warm",
    deliverables: [
      { type: "reel", title: `Launch reel ${stamp}` },
      { type: "post", title: `Launch post ${stamp}` },
      { type: "post", title: `Weekend post ${stamp}` },
    ],
  });
  await strategist.post(`/engagements/${e.id}/plan/submit`);
  await am.post(`/engagements/${e.id}/plan/send`);
  const plan = (await c.owner.get("/client/plans")).find((p) => p.engagementId === e.id).plan;
  await c.owner.post(`/client/plans/${plan.id}/approve`);
  det = await am.get(`/engagements/${e.id}`);
  const reel = det.deliverables.find((d) => d.type === "reel");
  const [post, weekend] = det.deliverables.filter((d) => d.type === "post").sort((a, b) => a.title.localeCompare(b.title)).reverse();
  check(reel && post && weekend, "plan approved with a reel and two posts");
  const v1 = await makeVersion(reel.id, "reel-15s.webm", "video/webm", "First cut");
  await passQc(v1.id);
  await am.post(`/deliverables/versions/${v1.id}/send`);
  check(true, "reel v1 uploaded, QC passed and sent to the client");

  console.log("2. The client pins a comment at 0:12 with a drawing; the AM sees it live on that frame");
  const team = await as("am@bmu.demo");
  await go(team, `/team/deliverables/${reel.id}`);
  await team.getByRole("heading", { name: "Review Studio" }).waitFor();
  const client = await as(c.email);
  await go(client, `/client/reviews/${reel.id}`);
  const video = client.locator("video").first();
  await video.waitFor();
  await client.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 1, null, { timeout: 30_000 });
  await video.evaluate((v) => new Promise((r) => ((v.onseeked = () => r(null)), (v.currentTime = 12))));
  await client.getByRole("button", { name: "Comment at current time" }).click();
  check(await client.getByText("At 0:12").count(), "the comment is set to 0:12");
  const overlay = client.getByTestId("review-overlay").last();
  const box = await overlay.boundingBox();
  await client.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.45);
  check(await client.getByText(/Pinned at 50%, 45%/).count(), "a spot is pinned on the frame");
  await client.getByRole("button", { name: "✎ Draw" }).click();
  await client.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.35);
  await client.mouse.down();
  for (let i = 1; i <= 10; i++) await client.mouse.move(box.x + box.width * (0.4 + i * 0.02), box.y + box.height * (0.35 + i * 0.01));
  await client.mouse.up();
  check(await client.getByText("1 stroke").count(), "a circle is drawn on the frame");
  await client.getByPlaceholder("What should change here?").fill("Logo too small here");
  await client.getByRole("button", { name: "Add comment" }).click();
  await client.locator("[data-comment]").filter({ hasText: "Logo too small here" }).waitFor();
  await shot(client, "v16-client-pin");

  const row = team.locator("[data-comment]").filter({ hasText: "Logo too small here" });
  await row.waitFor({ timeout: 30_000 });
  check(true, "the comment appears on the AM's open page without a reload");
  await row.getByRole("button", { name: "0:12" }).click();
  await team.locator("[data-pin]").first().waitFor({ timeout: 15_000 });
  const t = await team.locator("video").first().evaluate((v) => v.currentTime);
  check(Math.abs(t - 12) < 0.6, `the video jumps to 0:12 (${t.toFixed(1)} s) with the pin on that frame`);
  check((await team.locator('[data-testid="review-overlay"] polyline').count()) >= 1, "the client's drawing shows on the frame");
  check((await team.getByLabel("Comment markers").locator("button").count()) >= 1, "the timeline has a marker at the comment");
  await shot(team, "v16-team-sees-pin");

  console.log("3. Changes requested → v2 carries the open comment over");
  await client.getByRole("button", { name: "Request changes" }).click();
  await client.locator("textarea").first().fill("Please fix the logo size.");
  await client.getByRole("button", { name: "Send to BMU" }).click();
  await client.getByText("Updating with your feedback").first().waitFor({ timeout: 15_000 });
  const v2 = await makeVersion(reel.id, "reel-15s.webm", "video/webm", "Bigger logo");
  await team.getByRole("button", { name: /^v2/ }).waitFor({ timeout: 30_000 });
  await team.getByText("Carried over from v1").first().waitFor({ timeout: 15_000 });
  check(true, "v2 shows the open comment, marked carried over from v1");
  const det2 = await am.get(`/deliverables/${reel.id}`);
  check(det2.rounds?.[0]?.client?.decision === "changes_requested" && det2.rounds?.[1]?.carriedOver >= 1, "approval rounds show round 1 (changes) and the carried-over count");

  console.log("4. One-tap approval from the email link, then the certificate");
  await passQc(v2.id);
  await am.post(`/deliverables/versions/${v2.id}/send`);
  const outbox = await founder.get(`/service/outbox?q=${encodeURIComponent(c.email)}`);
  const mail = outbox.rows.find((r) => r.subject.includes(`Launch reel ${stamp}`) && r.subject.includes("v2"));
  check(mail, "the review email is in the outbox");
  const text = (await founder.get(`/service/outbox/${mail.id}`)).text;
  const token = /\/proof\/([\w-]+)/.exec(text)?.[1];
  check(token, "the email carries a one-tap review link");
  const anon = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await anon.goto(`${BASE}/proof/${token}`);
  await anon.getByTestId("proof-review").waitFor();
  await anon.getByRole("button", { name: "Approve version 2" }).click();
  await anon.getByTestId("proof-message").waitFor();
  check(/approved/i.test(await anon.getByTestId("proof-message").textContent()), "approved from a phone without signing in");
  await shot(anon, "v16-proof-link");
  await rejects(publicApi.post(`/public/proof/${token}/decide`, { decision: "approve" }), 400);
  check(true, "the same link cannot approve twice");
  const cert = team.getByRole("link", { name: /Approval certificate/ });
  await cert.waitFor({ timeout: 30_000 });
  await cert.click();
  await team.getByTestId("certificate").waitFor();
  check(/Verified/.test(await team.getByTestId("certificate-valid").textContent()), "the certificate verifies against the file");
  check(/Email link/.test(await team.getByTestId("certificate").textContent()), "the certificate says it was approved from the email link");
  await shot(team, "v16-certificate");

  console.log("5. Calendar: approval first, then schedule, publish and results");
  const pv = await makeVersion(post.id, "post.png", "image/png", "Draft");
  await passQc(pv.id);
  await rejects(am.patch(`/deliver/deliverables/${post.id}/schedule`, { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), channel: "instagram" }), 400);
  check(true, "a post that QC passed but the client has not approved cannot be scheduled");
  await am.post(`/deliverables/versions/${pv.id}/send`);
  await c.owner.post(`/client/reviews/${post.id}/approve`, { versionId: pv.id });
  await go(team, "/team/content-calendar");
  const ready = team.locator(`[data-unscheduled="${post.id}"]`);
  await ready.waitFor({ timeout: 20_000 });
  await ready.click();
  const editor = team.getByTestId("calendar-editor");
  await editor.getByLabel("Caption").fill(`Our doors open this weekend! #launch ${stamp}`);
  await editor.getByRole("button", { name: "Save caption" }).click();
  await team.waitForTimeout(800);
  await team.getByTestId("calendar-editor").getByRole("button", { name: "Schedule" }).click();
  await team.locator(`[data-item="${post.id}"]`).waitFor({ timeout: 15_000 });
  check(true, "the approved post is scheduled from the calendar with its caption");
  await team.locator(`[data-item="${post.id}"]`).click();
  await team.getByTestId("calendar-editor").getByPlaceholder("Live post link (https://…)").fill(`https://www.instagram.com/p/${stamp}`);
  await team.getByTestId("calendar-editor").getByRole("button", { name: "Mark published" }).click();
  await team.getByTestId("calendar-editor").getByText("Results", { exact: true }).waitFor({ timeout: 15_000 });
  await team.getByTestId("calendar-editor").getByLabel("Reach").fill("4200");
  await team.getByTestId("calendar-editor").getByLabel("Likes, comments, shares").fill("310");
  await team.getByTestId("calendar-editor").getByLabel("Link clicks").fill("57");
  await team.getByTestId("calendar-editor").getByRole("button", { name: "Save results" }).click();
  await team.getByTestId("post-metrics").waitFor({ timeout: 15_000 });
  check(true, "published with the live link and results typed in");
  await shot(team, "v16-calendar");
  const item = (await am.get(`/deliverables/${post.id}`)).caption;
  check(item?.includes(stamp), "the caption is saved on the post");
  await go(client, "/client/calendar");
  await client.getByTestId("results-summary").waitFor({ timeout: 20_000 });
  check(/4,200/.test(await client.getByTestId("results-summary").textContent()), "the client sees the reach in their results");

  console.log("6. Asset library");
  await go(team, "/team/assets");
  await team.getByText(`Launch reel ${stamp}`).first().waitFor({ timeout: 20_000 });
  check(true, "the approved reel is in the asset library");
  await team.getByRole("button", { name: "Upload" }).click();
  await team.getByTestId("asset-file").setInputFiles(new URL("../deliver/fixtures/brand.pdf", import.meta.url).pathname);
  await team.getByText("Done").first().waitFor({ timeout: 30_000 });
  await team.locator("li").filter({ hasText: "brand" }).first().waitFor();
  check(true, "a file uploads in pieces and appears in the library");
  await go(client, "/client/assets");
  await client.getByText(`Launch reel ${stamp}`).first().waitFor({ timeout: 20_000 });
  check(true, "the client sees the approved reel in their asset library");

  console.log("7. The client lets BMU approve posts; the AM approves one");
  await go(team, "/team/content-calendar");
  const rule = team.locator(`[data-rule="${c.clientOrgId}"]`);
  await rule.waitFor({ timeout: 20_000 });
  await rule.click();
  await team.locator("li").filter({ has: rule }).getByText("BMU can approve posts").waitFor({ timeout: 15_000 });
  check(true, "the publishing rule is switched to BMU sign-off for this client");
  const wv = await makeVersion(weekend.id, "post-v2.png", "image/png", "Draft");
  await passQc(wv.id);
  await rejects(am.post(`/deliver/deliverables/${weekend.id}/publish`, { liveUrl: "https://www.instagram.com/p/nope" }), 400);
  check(true, "a post without an approval cannot be marked published");
  await go(team, `/team/deliverables/${weekend.id}`);
  await team.getByRole("button", { name: `Approve v${wv.number} for publishing` }).click();
  await team.getByText(/Approved/).first().waitFor({ timeout: 15_000 });
  const wd = await am.get(`/deliverables/${weekend.id}`);
  check(wd.status === "approved" && wd.certificate, "approved on BMU's side with a certificate");

  const errs = errors.flat();
  check(errs.length === 0, `no page errors${errs.length ? `: ${errs.join(" | ")}` : ""}`);
  console.log("\nCreative journey passed.");
} catch (e) {
  console.error(e);
  for (const s of Object.values(sessions)) await shot(s.page, `v16-fail-${Object.keys(sessions).indexOf(s)}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
