// Deliver journey 1: a brand-new paying client through a one-time project, driven in the browser by every role.
// lead → proposal → e-sign + pay (API) → client onboarding uploads → AM blocks/receives → RCD (G1) → strategist plan →
// AM sends → client asks for changes → resubmit → approver + owner approve under "all approvers" (G2) → tasks (G3) →
// task board (start / blocked / log time / done) → versions (png, mp4, pdf, link) → QC fail/pass (uploader can't QC) →
// send → client Review Studio (pin, video time comment, compare, request changes, approve version) → G4 → balance
// invoice → sign-off + test payment → G5 → final delivery page: zip download + feedback → Client Health.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/deliver/project-journey.mjs
import { join } from "node:path";
import { api, check, freshClient, FIXTURES, launch, shot, signIn, BASE } from "./lib.mjs";

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
const users = await api("founder@bmu.demo").get("/org/users");
const emailOf = (id) => users.find((u) => u.id === id)?.email;

try {
  console.log("1. Fresh client: enquiry → proposal → accept → pay");
  const c = await freshClient({ services: [{ serviceKey: "logo_brand_kit", tier: "starter" }] });
  const e = c.engagements[0];
  check(e.currentGate === "G1" && e.status === "onboarding", "client account and engagement created at G1");
  // Make sure the demo AM owns it (load balancing may pick another AM).
  const am = users.find((u) => u.email === "am@bmu.demo");
  await api("founder@bmu.demo").post(`/admin-org/clients/${c.clientOrgId}/am`, { amUserId: am.id }).catch(() => {});
  // Second decider on the client account, so the approval rule can be tested.
  const approverEmail = c.email.replace("owner.", "approver.");
  await c.owner.post("/workspace/client/team", { name: "Ravi Approver", email: approverEmail, role: "client_approver" }).catch(async () => {
    await c.owner.post("/client/team", { name: "Ravi Approver", email: approverEmail, role: "client_approver" });
  });

  console.log("2. Client onboarding: upload a file and send a note");
  let page = await as(c.email);
  await go(page, "/client/onboarding");
  const items = page.locator("li", { has: page.getByRole("button", { name: "Send" }) });
  check((await items.count()) >= 2, "onboarding checklist shows the items to send");
  await items.nth(0).locator('input[type="file"]').setInputFiles(join(FIXTURES, "brand.pdf"));
  await items.nth(0).getByRole("button", { name: "Send" }).click();
  await page.getByText("Sent, BMU is checking").first().waitFor();
  await items.nth(0).getByRole("textbox").fill("https://drive.google.com/drive/folders/brand-assets");
  await items.nth(0).getByRole("button", { name: "Send" }).click();
  await page.waitForFunction(() => document.querySelectorAll('li input[type="file"]').length === 0);
  check((await page.getByText("Sent, BMU is checking").count()) >= 2, "both items show as sent");
  await shot(page, "j1-client-onboarding");

  console.log("3. AM: open project, check the file, block then receive, mark RCD (G1)");
  page = await as("am@bmu.demo");
  await go(page, "/team");
  await page.getByRole("button", { name: /notifications/i }).first().click().catch(() => {});
  await go(page, `/team/projects/${e.id}`);
  check(await page.getByRole("link", { name: "open file" }).isVisible(), "AM sees the uploaded file as a link");
  const fileHref = await page.getByRole("link", { name: "open file" }).getAttribute("href");
  const fileRes = await page.request.get(`${BASE}${fileHref}`);
  check(fileRes.ok(), "uploaded file opens for the AM");
  await page.getByRole("button", { name: "Mark blocked" }).first().click();
  await page.getByPlaceholder("Why is it blocked? (required)").fill("Fonts missing from the pack");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Fonts missing from the pack").waitFor();
  check(await page.getByText("Blocked").first().isVisible(), "item marked blocked with a reason");
  while ((await page.getByRole("button", { name: "Mark received" }).count()) > 0) {
    await page.getByRole("button", { name: "Mark received" }).first().click();
    await page.waitForTimeout(400);
  }
  await page.getByRole("button", { name: "Mark RCD and start planning" }).click();
  await page.getByText("Gate 1 passed").waitFor();
  check(true, "RCD set, Gate 1 passed");

  console.log("4. Strategist writes the plan and submits it");
  page = await as("strategist@bmu.demo");
  await go(page, `/team/projects/${e.id}`);
  await page.getByPlaceholder("What this month must achieve").fill("Launch a confident new identity");
  await page.getByPlaceholder("Who we are talking to").fill("Young families in Bengaluru");
  await page.getByPlaceholder(/Comma separated/).fill("Trust, Warmth");
  for (const [type, title] of [
    ["post", "Logo concepts"],
    ["reel", "Logo reveal reel"],
    ["other", "Brand guide PDF"],
  ]) {
    await page.getByRole("button", { name: "Add deliverable" }).click();
    await page.getByLabel("Type").last().selectOption(type);
    await page.getByLabel("Title").last().fill(title);
  }
  await page.getByRole("button", { name: "Submit for internal review" }).click();
  await page.getByText("Internal review").first().waitFor();
  check(true, "plan submitted for internal review");

  console.log("5. AM approves internally and sends to the client");
  page = await as("am@bmu.demo");
  await go(page, `/team/projects/${e.id}`);
  await page.getByRole("button", { name: "Approve and send to client" }).click();
  await page.getByText("With client").first().waitFor();

  console.log("6. Client asks for changes; strategist updates; AM resends");
  page = await as(c.email);
  await go(page, "/client/approvals");
  await page.getByRole("button", { name: "Request changes" }).click();
  await page.getByPlaceholder("What should change?").fill("Please add a business card design");
  await page.getByRole("button", { name: "Send to BMU" }).click();
  await page.getByText("Changes requested, BMU is updating it").waitFor();
  page = await as("strategist@bmu.demo");
  await go(page, `/team/projects/${e.id}`);
  check(await page.getByText("Please add a business card design").isVisible(), "strategist sees the client's comment");
  await page.getByRole("button", { name: "Add deliverable" }).click();
  await page.getByLabel("Title").last().fill("Business card");
  await page.getByRole("button", { name: "Submit for internal review" }).click();
  await page.getByText("Internal review").first().waitFor();
  page = await as("am@bmu.demo");
  await go(page, `/team/projects/${e.id}`);
  await page.getByRole("button", { name: "Approve and send to client" }).click();
  await page.getByText("With client").first().waitFor();

  console.log("7. Approval rule = every approver: approver approves, owner pending, AM reminds, owner approves (G2 → G3)");
  page = await as(c.email);
  await go(page, "/client/team");
  await page.getByText("Every approver").click();
  await page.getByText("Saved.").waitFor();
  const approver = await as(approverEmail);
  await go(approver, "/client/approvals");
  await approver.getByRole("button", { name: "Approve plan" }).click();
  await approver.getByText("You approved, waiting for others").waitFor();
  check(await approver.getByTestId("approval-status").isVisible(), "approver sees who approved and who is pending");
  page = await as("am@bmu.demo");
  await go(page, `/team/projects/${e.id}`);
  await page.getByRole("button", { name: "Remind pending approvers" }).click();
  await page.getByText(/Reminder sent to/).waitFor();
  page = await as(c.email);
  await go(page, "/client/approvals");
  await page.getByRole("button", { name: "Approve plan" }).click();
  await page.getByText(/^Approved/).first().waitFor();
  let det = await api("am@bmu.demo").get(`/engagements/${e.id}`);
  for (let i = 0; i < 20 && det.currentGate !== "G4"; i++) {
    await page.waitForTimeout(500);
    det = await api("am@bmu.demo").get(`/engagements/${e.id}`);
  }
  check(det.plan.status === "approved" && det.currentGate === "G4", `plan approved, tasks assigned, Gate 3 passed (gate ${det.currentGate})`);
  check(det.deliverables.length === 4, "4 deliverables created from the plan");
  const ownerNotes = await c.owner.get("/notifications");
  check(ownerNotes.items.some((n) => n.kind === "approval_reminder"), "owner got the approval reminder");

  console.log("8. Task board: start, blocked, log time, done");
  const byTitle = Object.fromEntries(det.deliverables.map((d) => [d.title, d.id]));
  const logoTasks = (await api("am@bmu.demo").get(`/deliverables/${byTitle["Logo concepts"]}`)).tasks;
  const brief = logoTasks[0];
  page = await as(emailOf(brief.owner.id));
  await go(page, "/team/tasks");
  const card = page.locator("div.border-l-2", { hasText: brief.title }).filter({ hasText: c.company }).first();
  await card.getByRole("button", { name: "Start" }).click();
  await card.getByRole("button", { name: "Mark done" }).waitFor();
  await card.getByRole("button", { name: "Blocked" }).click();
  await card.getByPlaceholder("Why? (required)").fill("Waiting for references");
  await card.getByRole("button", { name: "Save" }).click();
  await card.getByText("Blocked: Waiting for references").waitFor();
  await card.getByRole("button", { name: "Resume" }).click();
  // Let the board finish refreshing after Resume before opening the log-time form.
  await card.getByRole("button", { name: "Mark done" }).waitFor();
  await page.waitForLoadState("networkidle");
  await card.getByRole("button", { name: "Log time" }).click();
  // Only one log-time form is open at a time; target it directly (the board's card wrappers can nest).
  const hoursForm = page.locator("form", { has: page.getByLabel("Hours spent") });
  await hoursForm.getByLabel("Hours spent").fill("1.5");
  await hoursForm.getByRole("button", { name: "Log", exact: true }).click();
  await card.getByText("1.5h logged").waitFor();
  await card.getByRole("button", { name: "Mark done" }).click();
  await card.getByText("Done").first().waitFor();
  check(true, "task started, blocked with reason, resumed, 1.5h logged, done");
  await shot(page, "j1-task-board");

  console.log("9. Makers upload versions; QC; AM sends after a pass");
  const uploads = [
    ["Logo concepts", "post.png"],
    ["Logo reveal reel", "reel.mp4"],
    ["Brand guide PDF", "brand.pdf"],
    ["Business card", null],
  ];
  for (const [title, file] of uploads) {
    const id = byTitle[title];
    const d = await api("am@bmu.demo").get(`/deliverables/${id}`);
    const work = d.tasks.filter((t) => t.kind === "work");
    const maker = emailOf(work.at(-1).owner.id);
    const qcer = emailOf(d.tasks.find((t) => t.kind === "qc").owner.id);
    page = await as(maker);
    await go(page, `/team/deliverables/${id}`);
    if (file) {
      await page.locator('input[type="file"]').setInputFiles(join(FIXTURES, file));
    } else {
      await page.getByText("Link (live URL, Drive, Figma)").click();
      await page.getByPlaceholder("https://").fill("https://www.figma.com/file/business-card");
    }
    await page.getByPlaceholder("What changed? (optional)").fill("First draft");
    await page.getByRole("button", { name: "Upload and send to QC" }).click();
    await page.getByText("QC review").first().waitFor({ timeout: 20_000 }).catch(() => page.getByText(/In QC|Waiting for QC/i).first().waitFor());
    if (maker !== qcer) check(!(await page.getByText("QC checklist 🔒").isVisible()), `${title}: uploader has no QC checklist`);
    await shot(page, `j1-uploaded-${title.replace(/\s+/g, "-")}`);

    page = await as(qcer);
    await go(page, "/team/qc");
    check(await page.getByText(title).first().isVisible(), `${title} is in the QC queue`);
    await go(page, `/team/deliverables/${id}`);
    const boxes = page.locator('input[type="checkbox"]');
    for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
    await page.getByRole("button", { name: "Pass QC" }).click();
    await page.getByText("Pass", { exact: true }).first().waitFor();

    page = await as("am@bmu.demo");
    await go(page, `/team/deliverables/${id}`);
    await page.getByRole("button", { name: /Send v1 to client/ }).click();
    await page.getByText(/With client|Ready for client|Sent to client/i).first().waitFor();
  }
  check(true, "4 versions uploaded (png, mp4, pdf, link), QC passed, sent");

  console.log("10. Client Review Studio: pin, video time comment, request changes, compare, approve versions");
  page = await as(c.email);
  await go(page, "/client/reviews");
  check((await page.getByText("Logo concepts").count()) > 0, "review list shows the drafts");
  await go(page, `/client/reviews/${byTitle["Logo concepts"]}`);
  const img = page.locator("img").first();
  await img.waitFor();
  const box = await img.boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.3);
  await page.getByPlaceholder("What should change here?").fill("Make the logo bigger");
  await page.getByRole("button", { name: "Add comment" }).click();
  await page.getByText("Make the logo bigger").waitFor();
  await page.getByRole("button", { name: "Request changes" }).click();
  await page.getByRole("button", { name: "Send to BMU" }).click();
  await page.getByText(/Updating with your feedback|Changes requested/).first().waitFor();
  await shot(page, "j1-client-pin-changes");

  await go(page, `/client/reviews/${byTitle["Logo reveal reel"]}`);
  await page.locator("video").waitFor();
  await page.evaluate(async () => {
    const v = document.querySelector("video");
    // Headless Chromium has no H.264, so the fixture is VP9; give up after 10s rather than hang.
    if (v.readyState < 1) await new Promise((r) => { v.addEventListener("loadedmetadata", r, { once: true }); setTimeout(r, 10_000); });
    v.currentTime = 1.5;
    await new Promise((r) => setTimeout(r, 300));
  });
  await page.getByRole("button", { name: "Comment at current time" }).click();
  await page.getByPlaceholder("What should change here?").fill("Logo appears too early");
  await page.getByRole("button", { name: "Add comment" }).click();
  await page.getByText("Logo appears too early").waitFor();
  const stamp = await page.locator("li button.font-mono").first().textContent();
  check(stamp?.trim() === "0:01", `video comment is time-coded (${stamp})`);

  // Rule "every approver": owner approves first → pending approver; approver completes.
  for (const t of ["Logo reveal reel", "Brand guide PDF", "Business card"]) {
    await go(page, `/client/reviews/${byTitle[t]}`);
    await page.getByRole("button", { name: /Approve version 1/ }).click();
    await page.getByText(/Waiting for Ravi Approver/).waitFor();
  }
  check(await page.getByText(/Waiting for Ravi Approver/).isVisible(), "owner approval recorded, approver still pending");
  for (const t of ["Logo reveal reel", "Brand guide PDF", "Business card"]) {
    await go(approver, `/client/reviews/${byTitle[t]}`);
    await approver.getByRole("button", { name: /Approve version 1/ }).click();
    await approver.getByText("Approved", { exact: true }).first().waitFor();
  }

  // Changes on the logo: maker uploads v2, QC fails it, maker fixes v3, QC passes, AM sends, client compares and approves v3.
  {
    const id = byTitle["Logo concepts"];
    const d = await api("am@bmu.demo").get(`/deliverables/${id}`);
    check(d.status === "changes_requested" && d.revisionRounds.used === 1, "revision round 1 used");
    const maker = emailOf(d.tasks.filter((t) => t.kind === "work").at(-1).owner.id);
    const qcer = emailOf(d.tasks.find((t) => t.kind === "qc").owner.id);
    const mp = await as(maker);
    await go(mp, `/team/deliverables/${id}`);
    await mp.locator('input[type="file"]').setInputFiles(join(FIXTURES, "post-v2.png"));
    await mp.getByRole("button", { name: "Upload and send to QC" }).click();
    await mp.waitForTimeout(1000);
    const qp = await as(qcer);
    await go(qp, `/team/deliverables/${id}`);
    await qp.locator('input[type="checkbox"]').nth(1).check();
    await qp.getByPlaceholder("Overall note for the maker").fill("Brand colour is off");
    await qp.getByRole("button", { name: "Fail QC and return to maker" }).click();
    await qp.getByText("Fail", { exact: true }).first().waitFor();
    await go(mp, `/team/deliverables/${id}`);
    check(await mp.getByText("Brand colour is off").first().isVisible(), "maker sees the QC failure note");
    await mp.locator('input[type="file"]').setInputFiles(join(FIXTURES, "post-v2.png"));
    await mp.getByPlaceholder("What changed? (optional)").fill("Colour fixed");
    await mp.getByRole("button", { name: "Upload and send to QC" }).click();
    await mp.waitForTimeout(1000);
    await go(qp, `/team/deliverables/${id}`);
    const boxes = qp.locator('input[type="checkbox"]');
    for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
    await qp.getByRole("button", { name: "Pass QC" }).click();
    await qp.waitForTimeout(800);
    const ap = await as("am@bmu.demo");
    await go(ap, `/team/deliverables/${id}`);
    await ap.getByRole("button", { name: /Send v3 to client/ }).click();
    await ap.waitForTimeout(800);
    await go(page, `/client/reviews/${id}`);
    await page.getByLabel("Compare with").selectOption({ label: "v1" });
    check((await page.locator("img").count()) >= 2, "client compares v3 with v1 side by side");
    await shot(page, "j1-client-compare");
    await page.getByRole("button", { name: /Approve version 3/ }).click();
    await page.getByTestId("approval-status").waitFor();
    await go(approver, `/client/reviews/${id}`);
    await approver.getByRole("button", { name: /Approve version 3/ }).click();
    await approver.getByText("Approved", { exact: true }).first().waitFor();
  }
  let det2 = await api("am@bmu.demo").get(`/engagements/${e.id}`);
  check(det2.currentGate === "G5" && det2.status === "awaiting_final_payment", "all approved → Gate 4 passed, balance due");

  console.log("11. Client signs off, pays the balance, downloads the handover zip and gives feedback (G5)");
  await go(page, "/client/files");
  await page.getByRole("button", { name: "Sign off" }).click();
  await page.getByText("One step left").waitFor();
  await page.getByRole("button", { name: /^Pay ₹/ }).click();
  await page.getByText("Delivered").first().waitFor({ timeout: 20_000 });
  await page.getByRole("link", { name: "Open final delivery and download all" }).click();
  await page.getByTestId("zip-download").waitFor();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("zip-download").click()]);
  const zipPath = await download.path();
  const { readFileSync } = await import("node:fs");
  const zip = readFileSync(zipPath);
  check(zip.readUInt32LE(0) === 0x04034b50 && zip.includes(Buffer.from("Brand guide PDF v1.pdf")), `zip downloaded (${zip.length} bytes) with the final files`);
  await page.getByRole("radio", { name: "8" }).click();
  await page.getByPlaceholder(/What went well/).fill("Lovely work, quick turnaround");
  await page.getByRole("button", { name: "Send feedback" }).click();
  await page.getByText("Thank you, your feedback was sent.").waitFor();
  await shot(page, "j1-client-handover");
  const files = await c.owner.get("/client/files");
  check(files.every((f) => f.released && f.downloadUrl), "every final file released and downloadable");
  det2 = await api("am@bmu.demo").get(`/engagements/${e.id}`);
  check(det2.status === "delivered", "engagement delivered (G5)");

  console.log("12. It shows up everywhere: bell, My Day, Projects, Client 360 journey, client journey, analytics");
  page = await as("am@bmu.demo");
  await go(page, "/team");
  const amNotes = await api("am@bmu.demo").get("/notifications");
  for (const kind of ["requirement_sent", "plan_review", "plan_changes", "plan_approved", "approval_partial", "client_feedback"]) check(amNotes.items.some((n) => n.kind === kind), `AM notified: ${kind}`);
  await go(page, `/team/projects/${e.id}`);
  check(await page.getByText("Final delivery and handover pack").isVisible(), "project shows the handover pack");
  check(await page.getByText("Lovely work, quick turnaround").isVisible(), "project shows the client's feedback");
  await go(page, "/team/projects");
  await page.getByRole("button", { name: "List" }).click().catch(() => {});
  await go(page, `/team/clients/${c.clientOrgId}`);
  await page.getByText("Final files released").first().waitFor({ timeout: 15_000 }).catch(() => {});
  check(await page.getByText(/Final files released|Final delivery/).first().isVisible(), "Client 360 journey shows final delivery");
  await shot(page, "j1-client360");
  page = await as(c.email);
  await go(page, "/client/journey");
  check(await page.getByText(/Final files released|Final delivery/).first().isVisible(), "client journey shows final delivery");
  const founder = await as("founder@bmu.demo");
  await go(founder, "/admin/analytics/delivery");
  await shot(founder, "j1-analytics-delivery");
  await go(founder, "/admin/client-health");
  const health = (await api("founder@bmu.demo").get("/insights/client-health")).find((r) => r.id === c.clientOrgId);
  check(health?.reasons.includes("Client rated us 8/10"), `Client Health uses the rating (score ${health?.score}: ${health?.reasons.join("; ")})`);

  const errs = errors.flat();
  if (errs.length) console.log("Page errors:\n" + errs.join("\n"));
  check(errs.length === 0, "no page errors");
  console.log(`\nJOURNEY 1 PASSED for ${c.company} (${c.email})`);
} catch (err) {
  console.error("\nJOURNEY 1 FAILED:", err.message);
  for (const [email, s] of Object.entries(sessions)) await shot(s.page, `j1-fail-${email.split("@")[0]}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
