// Deliver journey 2: a fresh monthly retainer (Social Media Management, Growth) through its first month and the
// roll-over into the next one, then the content calendar.
// API: lead → pay → onboarding → RCD → small plan (2 posts, 1 reel) approved → tasks → 2 posts made, QC'd, approved.
// Browser: CM sees the cycles panel (quota, unused that rolls over) → clicks "Start November 2026" → the new month has a
// prefilled plan with carried-over items and its own retainer invoice → clicking again is refused → CM drags an approved
// post onto a calendar day, sets the channel, marks it published with a live link → client sees it on their calendar
// (month and week views) with the live link → notifications.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/deliver/retainer-calendar.mjs
import { api, check, freshClient, launch, rejects, shot, signIn, BASE } from "./lib.mjs";

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
const am = api("am@bmu.demo");
const users = await api("founder@bmu.demo").get("/org/users");
const emailOf = (id) => users.find((u) => u.id === id)?.email;

try {
  console.log("1. Fresh retainer client, first month made and approved (API)");
  const c = await freshClient({ services: [{ serviceKey: "smm", tier: "growth" }] });
  const e = c.engagements[0];
  const amUser = users.find((u) => u.email === "am@bmu.demo");
  await api("founder@bmu.demo").post(`/admin-org/clients/${c.clientOrgId}/am`, { amUserId: amUser.id }).catch(() => {});
  let det = await am.get(`/engagements/${e.id}`);
  check(det.billingType === "retainer" || det.cycle?.period?.match(/^\d{4}-\d{2}$/), `retainer engagement created (${det.cycle?.period})`);
  for (const r of det.cycle.requirements) await am.patch(`/engagements/requirements/${r.id}`, { status: "received" });
  await am.post(`/engagements/${e.id}/rcd`);
  const strategist = api("strategist@bmu.demo");
  await strategist.put(`/engagements/${e.id}/plan`, {
    objectives: "Grow Instagram following",
    audience: "Young families in Bengaluru",
    pillars: ["Offers", "Behind the scenes"],
    creativeDirection: "Warm, bright photography",
    deliverables: [
      { type: "post", title: "Festive offer post" },
      { type: "post", title: "Meet the team post" },
      { type: "reel", title: "Store tour reel" },
    ],
  });
  await strategist.post(`/engagements/${e.id}/plan/submit`);
  await am.post(`/engagements/${e.id}/plan/send`);
  const plans = await c.owner.get("/client/plans");
  const plan = plans.find((p) => p.engagementId === e.id).plan;
  await c.owner.post(`/client/plans/${plan.id}/approve`);
  det = await am.get(`/engagements/${e.id}`);
  check(det.deliverables.length === 3 && ["G3", "G4"].includes(det.currentGate), `plan approved, 3 deliverables (gate ${det.currentGate})`);
  const posts = det.deliverables.filter((d) => d.type === "post");
  for (const p of posts) {
    const d = await am.get(`/deliverables/${p.id}`);
    const maker = emailOf(d.tasks.filter((t) => t.kind === "work").at(-1).owner.id);
    let after = await api(maker).upload(`/deliverables/${p.id}/versions`, "post.png", "image/png", { note: "First draft" });
    const v = after.versions.at(-1);
    after = await api("qc@bmu.demo").post(`/deliverables/versions/${v.id}/qc`, { items: after.qcChecklist.map((label) => ({ label, ok: true })) });
    await am.post(`/deliverables/versions/${v.id}/send`);
    await c.owner.post(`/client/reviews/${p.id}/approve`, { versionId: v.id });
  }
  check(true, "2 posts uploaded, QC passed, sent and approved by the client");

  console.log("2. CM: cycles panel → Start next month");
  let page = await as("am@bmu.demo");
  await go(page, `/team/projects/${e.id}`);
  const panel = page.getByTestId("cycles-panel");
  await panel.waitFor();
  check(await panel.getByText(/Unused this month \(rolls over\): 10 post/).isVisible(), "unused quota shown (10 posts roll over)");
  const startBtn = panel.getByRole("button", { name: /^Start / });
  const label = (await startBtn.textContent()).replace("Start ", "").trim();
  await startBtn.click();
  await panel.getByText(`${label}`).first().waitFor();
  await panel.getByText(/Carried over from/).first().waitFor();
  await shot(page, "j2-cycles-panel");
  const cycles = await am.get(`/deliver/engagements/${e.id}/cycles`);
  const next = cycles.cycles[0];
  check(next.startedBy && next.startedBy !== "auto", `${next.label} started by the CM`);
  check(next.carriedOver.some((x) => x.type === "post" && x.count === 10), "10 unused posts carried over");
  check(next.quota.find((q) => q.type === "post")?.count === 22, "post quota = 12 + 10 carried over");
  check(next.invoice && ["issued", "draft", "overdue"].includes(next.invoice.status), `retainer invoice issued for the month (${next.invoice?.number})`);
  check(next.planStatus === "draft", "new month has a draft plan to approve");
  await rejects(am.post(`/deliver/engagements/${e.id}/cycles/next`), 400);
  check(!(await panel.getByRole("button", { name: /^Start / }).isEnabled()), "start button disabled until the month begins (idempotent)");
  det = await am.get(`/engagements/${e.id}`);
  check(det.plan.content.deliverables.length >= 22, `plan prefilled from quota + carry-over (${det.plan.content.deliverables.length} items)`);
  const inv = await c.owner.get("/client/invoices");
  check(JSON.stringify(inv).includes(next.invoice.number), "client sees the new month's invoice");

  console.log("3. Content calendar: drag to schedule, edit, publish");
  await go(page, "/team/content-calendar");
  const cal = page.getByTestId("content-calendar");
  await cal.waitFor();
  const item = page.locator(`[data-unscheduled="${posts[0].id}"]`);
  await item.waitFor();
  const today = new Date(Date.now() + 5.5 * 3600_000);
  const day = new Date(today.getTime() + 2 * 86400_000).toISOString().slice(0, 10);
  // If two days ahead falls in next month, step forward to that month.
  if (day.slice(0, 7) !== today.toISOString().slice(0, 7)) await page.getByRole("button", { name: "Next" }).click();
  await item.dragTo(page.locator(`[data-day="${day}"]`));
  const placed = page.locator(`[data-day="${day}"] [data-item="${posts[0].id}"]`);
  await placed.waitFor();
  check(true, `post dragged onto ${day}`);
  const editor = page.getByTestId("calendar-editor");
  await editor.getByLabel("Time").fill("18:30");
  await editor.getByLabel("Channel").selectOption("facebook");
  await editor.getByRole("button", { name: "Save time" }).click();
  await page.locator(`[data-day="${day}"] [data-item="${posts[0].id}"]`, { hasText: "18:30" }).waitFor();
  check(await placed.getByText("Facebook").isVisible(), "time and channel saved");
  // Drag the second one too, then reschedule it by dragging to another day.
  const day2 = new Date(today.getTime() + 3 * 86400_000).toISOString().slice(0, 10);
  const second = page.locator(`[data-unscheduled="${posts[1].id}"]`);
  if (await page.locator(`[data-day="${day2}"]`).count()) {
    // Busy demo weeks make day cells tall: start from the top so both ends of the drag are on screen.
    await page.evaluate(() => window.scrollTo(0, 0));
    await second.dragTo(page.locator(`[data-day="${day2}"]`), { targetPosition: { x: 20, y: 12 } });
    await page.locator(`[data-day="${day2}"] [data-item="${posts[1].id}"]`).waitFor();
    await page.locator(`[data-day="${day2}"] [data-item="${posts[1].id}"]`).dragTo(page.locator(`[data-day="${day}"]`));
    await page.locator(`[data-day="${day}"] [data-item="${posts[1].id}"]`).waitFor();
    check(true, "dragging a scheduled post to another day reschedules it");
  }
  await placed.click();
  await editor.getByPlaceholder("Live post link (https://…)").fill("not a link");
  await editor.getByRole("button", { name: "Mark published" }).click();
  check(await editor.getByText("Scheduled", { exact: true }).isVisible(), "invalid live link is refused by the browser form");
  await editor.getByPlaceholder("Live post link (https://…)").fill("https://www.instagram.com/p/festive-offer");
  await editor.getByRole("button", { name: "Mark published" }).click();
  await placed.getByText("· Live").waitFor();
  check(true, "post marked published with a live link");
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await shot(page, "j2-team-calendar-week");

  console.log("4. Client: calendar and notifications");
  const client = await as(c.email);
  await go(client, "/client/calendar");
  if (day.slice(0, 7) !== today.toISOString().slice(0, 7)) await client.getByRole("button", { name: "Next" }).click();
  const clientItem = client.locator(`[data-day="${day}"] [data-item="${posts[0].id}"]`);
  await clientItem.waitFor();
  check((await clientItem.getAttribute("draggable")) !== "true", "client cannot drag posts");
  await clientItem.click();
  check(await client.getByRole("link", { name: "See it live" }).isVisible(), "client sees the live link");
  await shot(client, "j2-client-calendar");
  const notes = await c.owner.get("/notifications");
  check(notes.items.some((n) => n.kind === "post_published"), "client notified that the post is live");

  console.log("5. Phone width");
  const phone = await as(c.email, { mobile: true });
  await go(phone, "/client/calendar");
  await phone.getByTestId("content-calendar").waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `client calendar fits a phone screen (overflow ${overflow}px)`);
  await shot(phone, "j2-client-calendar-phone");

  const errs = errors.flat();
  if (errs.length) console.log("Page errors:\n" + errs.join("\n"));
  check(errs.length === 0, "no page errors");
  console.log(`\nJOURNEY 2 PASSED for ${c.company} (${c.email})`);
} catch (err) {
  console.error("\nJOURNEY 2 FAILED:", err.message);
  for (const [email, s] of Object.entries(sessions)) await shot(s.page, `j2-fail-${email.split("@")[0]}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
