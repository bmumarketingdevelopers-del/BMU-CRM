// v17 journey: client portal 2.0 and communications.
// API: a fresh client (owner has a mobile number) with BMU's Client Manager.
// Browser: a WhatsApp from the client's number arrives (webhook) → it is in the CM's inbox, linked to the client, and on
// the client's message thread → the CM replies with a template. The CM starts the project's shared brief and shares it;
// the CM and the client type in it at the same time and both see all the text. The client books a call with the CM
// from free slots; the CM sees it and writes notes that become tasks. A visitor books from the CM's public link.
// The CM sets quiet hours and WhatsApp alerts.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/comms/comms.mjs
import { api, check, freshClient, launch, publicApi, shot, signIn, BASE } from "../deliver/lib.mjs";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const founder = api("founder@bmu.demo");
const am = api("am@bmu.demo");
const users = await founder.get("/org/users");
const amUser = users.find((u) => u.email === "am@bmu.demo");
const stamp = Date.now().toString(36);

try {
  console.log("1. Fresh client with BMU's Client Manager (API)");
  const c = await freshClient({ services: [{ serviceKey: "smm", tier: "growth" }], tag: `cm${stamp}` });
  await founder.post(`/admin-org/clients/${c.clientOrgId}/am`, { amUserId: amUser.id }).catch(() => {});
  const me = await c.owner.get("/auth/me");
  const phone = (me.phone ?? "").replace(/\D/g, "").slice(-10);
  check(phone.length === 10, "the client owner has a mobile number");

  console.log("2. A WhatsApp from the client's number lands in the CM's inbox and on the client's thread");
  const text = `Hi team, can the Diwali post go out on Friday? (${stamp})`;
  const r = await publicApi.post("/webhooks/whatsapp", { entry: [{ changes: [{ value: { contacts: [{ wa_id: `91${phone}`, profile: { name: "Owner" } }], messages: [{ from: `91${phone}`, id: `wamid.${stamp}`, type: "text", text: { body: text } }] } }] }] });
  check(r.received === 1, "the webhook stored the message");
  const amPage = await as("am@bmu.demo");
  await go(amPage, "/team/inbox");
  await amPage.getByTestId("inbox-list").getByText(c.company).first().click();
  await amPage.getByTestId("conversation-messages").getByText(text).waitFor();
  check(await amPage.getByTestId("conversation").getByRole("link", { name: c.company }).isVisible(), "the conversation is linked to the right client");
  await amPage.getByLabel("Insert a template").selectOption({ label: "Got it, on it" });
  const filled = await amPage.getByLabel("Reply").inputValue();
  check(filled.startsWith("Hi Owner") && !filled.includes("{{"), `the template filled in the client's name ("${filled.slice(0, 30)}…")`);
  await amPage.getByLabel("Reply").fill("Hi! Yes, Friday works. I have moved it.");
  await amPage.getByTestId("inbox-send").click();
  await amPage.getByTestId("conversation-messages").getByText("Friday works").waitFor();
  check(await amPage.getByText("Waiting to send (WhatsApp not connected)").first().isVisible(), "without WhatsApp keys the reply waits in the queue, and says so");
  await shot(amPage, "comms-inbox");
  const clientPage = await as(c.email);
  await go(clientPage, "/client/messages");
  await clientPage.getByText(text).first().waitFor();
  await clientPage.getByText("Friday works").first().waitFor();
  check(true, "the client's message thread shows their WhatsApp and the CM's reply");

  console.log("3. Two people edit the same brief at once");
  const e = c.engagements[0];
  await go(amPage, `/team/projects/${e.id}`);
  await amPage.getByTestId("open-shared-brief").click();
  await amPage.waitForURL(/\/team\/docs\//);
  const docId = amPage.url().split("/team/docs/")[1];
  await amPage.getByTestId("doc-share").click();
  await amPage.getByRole("button", { name: "Stop sharing with client" }).waitFor();
  await go(clientPage, "/client");
  await clientPage.getByRole("link", { name: /brief/ }).first().waitFor();
  await go(clientPage, `/client/docs/${docId}`);
  const amText = amPage.getByTestId("doc-text");
  const clText = clientPage.getByTestId("doc-text");
  await clText.waitFor();
  // Both type at the same moment: the CM at the end, the client at the very start.
  await amText.click();
  await amPage.keyboard.press("Control+End");
  await clText.click();
  await clientPage.keyboard.press("Control+Home");
  await Promise.all([amPage.keyboard.type(`CM note ${stamp}. `, { delay: 15 }), clientPage.keyboard.type(`CLIENT ${stamp}: `, { delay: 15 })]);
  await sleep(4000);
  const a = await amText.inputValue();
  const b = await clText.inputValue();
  check(a.includes(`CM note ${stamp}.`) && a.includes(`CLIENT ${stamp}:`), "the CM's editor has both people's text");
  check(b.includes(`CM note ${stamp}.`) && b.includes(`CLIENT ${stamp}:`), "the client's editor has both people's text");
  check(a === b, "both editors show exactly the same document");
  check(b.startsWith(`CLIENT ${stamp}: `), "the client's text is where they typed it");
  await amPage.getByText("All changes saved").waitFor();
  const saved = await am.get(`/docs/${docId}`);
  check(saved.text === a, "the saved document matches what both see");
  await shot(clientPage, "comms-doc");

  console.log("4. The client books a call with the CM; the CM writes notes that become tasks");
  await go(clientPage, "/client/meetings");
  await clientPage.getByTestId("book-call").click();
  await clientPage.getByTestId("slot").first().click();
  await clientPage.getByLabel("Agenda").fill("November plan");
  await clientPage.getByTestId("confirm-booking").click();
  await clientPage.getByTestId("meeting-row").first().waitFor();
  check(await clientPage.getByTestId("meeting-row").first().getByText(amUser.name).isVisible(), "the client sees the call with their CM");
  await go(amPage, "/team/meetings");
  const row = amPage.getByTestId("meeting-row").filter({ hasText: c.company }).first();
  await row.waitFor();
  check(await row.getByText("Booked by client").isVisible(), "the CM sees the call the client booked");
  await row.getByRole("button", { name: "Notes" }).click();
  await amPage.getByLabel("Meeting notes").fill("Talked about November. They want more reels.\n- [ ] Share 5 reel ideas by Friday\nAction: send the revised plan");
  await amPage.getByTestId("meeting-summarise").click();
  await amPage.getByLabel("Action item 2").waitFor();
  check((await amPage.getByLabel("Action item 1").inputValue()) === "Share 5 reel ideas by Friday", "action items were found in the notes (basic mode)");
  await amPage.getByTestId("meeting-notes").locator('input[type="checkbox"]').first().check();
  await amPage.getByTestId("meeting-tasks").click();
  await amPage.getByText("Tasks created").waitFor();
  check(await amPage.getByTestId("meeting-notes").getByRole("link", { name: "Task" }).first().isVisible(), "the action item is now a task");
  await shot(amPage, "comms-meetings");

  console.log("5. A visitor books from the CM's public booking link");
  const page = await am.get("/meetings/booking-page");
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  await visitor.goto(`${BASE}/book/${page.slug}`);
  await visitor.getByTestId("slot").nth(1).click();
  await visitor.getByLabel("Your name").fill("Priya Visitor");
  await visitor.getByLabel("Email").fill(`priya.${stamp}@example.com`);
  await visitor.getByLabel("Company").fill(`Priya Cafe ${stamp}`);
  await visitor.getByTestId("public-book").click();
  await visitor.getByTestId("booking-done").waitFor();
  const leads = await founder.get("/leads");
  check(leads.some((l) => JSON.stringify(l).includes(`priya.${stamp}@example.com`)), "the visitor became a lead");
  await ctx.close();

  console.log("6. The CM turns on WhatsApp alerts for the inbox and sets quiet hours");
  await go(amPage, "/team/profile");
  await amPage.getByLabel("WhatsApp or email in the inbox on WhatsApp").check();
  await amPage.getByLabel("Quiet from").fill("21:00");
  await amPage.getByLabel("Quiet until").fill("08:00");
  await amPage.getByTestId("notification-prefs").locator("xpath=ancestor::*[.//button[text()='Save']][1]").getByRole("button", { name: "Save" }).click();
  await amPage.getByText("Saved. We'll use these from now on.").waitFor();
  const prefs = await am.get("/service/notification-preferences");
  check(prefs.quietStart === "21:00" && prefs.quietEnd === "08:00", "quiet hours saved");
  check(prefs.prefs.find((p) => p.kind === "inbox_message")?.whatsapp === true, "WhatsApp alerts saved");
  await am.put("/service/notification-preferences", { prefs: [{ kind: "inbox_message", inApp: true, email: true, whatsapp: false }], quietStart: null, quietEnd: null });

  const errs = errors.flat();
  check(errs.length === 0, `no page errors${errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""}`);
  console.log("\nCOMMS JOURNEY PASSED");
} catch (err) {
  console.error("\nFAILED:", err.message);
  for (const [email, s] of Object.entries(sessions)) await shot(s.page, `comms-fail-${email.split("@")[0]}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
