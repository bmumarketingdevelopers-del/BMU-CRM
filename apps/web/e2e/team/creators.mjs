// Creator loop: CM briefs a creator -> creator accepts -> submits -> CM asks for a revision -> creator resubmits -> CM approves
// -> payout booked with 10% TDS -> Finance marks it paid -> creator sees it paid and is notified. Plus a declined brief.
// BASE_URL=http://localhost:3000 node apps/web/e2e/team/creators.mjs
import { BASE, launch, newPage, signIn, apiCall, check, done } from "./lib.mjs";

const stamp = Date.now() % 1_000_000;
const browser = await launch();
const as = async (who) => {
  const page = await newPage(browser);
  await signIn(page, who);
  return page;
};
const text = (p) => p.locator("body").innerText();

const am = await as("am.lead@bmu.demo");
const creator = await as("creator@bmu.demo");
const finance = await as("finance@bmu.demo");
const me = await apiCall(creator, "GET", "/auth/me");
const creatorName = me.body.name;

async function newBrief(title, fee) {
  await am.goto(`${BASE}/team/creators`, { waitUntil: "networkidle" });
  await am.getByRole("button", { name: "New brief" }).click();
  const sel = am.locator("form select").first();
  await sel.waitFor();
  const value = await sel.evaluate((el, n) => [...el.options].find((o) => o.text.startsWith(n))?.value, creatorName);
  await sel.selectOption(value);
  await am.getByPlaceholder("e.g. Diwali home tour reel").fill(title);
  await am.getByPlaceholder(/Hook, tone/).fill("Warm, festive, show the product in the first 3 seconds.");
  await am.getByPlaceholder(/vertical reel/).fill("1 vertical reel (30s)");
  await am.getByPlaceholder("15000").fill(String(fee));
  await am.getByRole("button", { name: "Send brief" }).click();
  await am.waitForURL(/\/team\/creators\/briefs\//, { timeout: 15000 });
  return am.url().split("/").pop();
}

async function creatorSubmit(id, url) {
  await creator.goto(`${BASE}/creator/briefs/${id}`, { waitUntil: "networkidle" });
  await creator.getByRole("button", { name: "Paste a link" }).click();
  await creator.getByLabel("Link").fill(url);
  await creator.getByRole("button", { name: "Send for review" }).click();
  await creator.waitForLoadState("networkidle").catch(() => {});
  await creator.waitForTimeout(800);
}

console.log("Brief -> accept -> submit -> revision -> approve");
const title = `Journey reel ${stamp}`;
const id = await newBrief(title, 12000);
check(!!id, "CM sends a brief");
const notes = await apiCall(creator, "GET", "/notifications");
check(notes.body.items.some((n) => (n.title + n.body).includes(title)), "creator is notified of the new brief");
await creator.goto(`${BASE}/creator/briefs/${id}`, { waitUntil: "networkidle" });
await creator.getByRole("button", { name: "Accept brief" }).click();
await creator.getByRole("button", { name: "Paste a link" }).waitFor({ timeout: 10000 });
check(true, "creator accepts");
await creatorSubmit(id, "https://drive.google.com/file/d/journey-v1");
await am.goto(`${BASE}/team/creators/briefs/${id}`, { waitUntil: "networkidle" });
check((await text(am)).includes("journey-v1"), "CM sees the submission");
await am.getByLabel("Feedback").fill("Tighten the hook and add captions.");
await am.getByRole("button", { name: "Ask for a revision" }).click();
await am.waitForLoadState("networkidle").catch(() => {});
await creator.goto(`${BASE}/creator/briefs/${id}`, { waitUntil: "networkidle" });
check((await text(creator)).includes("Tighten the hook"), "creator sees the revision feedback");
await creatorSubmit(id, "https://drive.google.com/file/d/journey-v2");
await am.goto(`${BASE}/team/creators/briefs/${id}`, { waitUntil: "networkidle" });
await am.getByRole("button", { name: "Approve and book payout" }).click();
await am.waitForLoadState("networkidle").catch(() => {});
await am.waitForTimeout(800);
const brief = await apiCall(am, "GET", `/workspace/briefs/${id}`);
check(brief.body.status === "approved", `brief approved (${brief.body.status})`);

console.log("Payout with TDS");
await finance.goto(`${BASE}/admin/finance/payouts`, { waitUntil: "networkidle" });
const row = finance.locator("tr", { hasText: title });
const rowText = await row.innerText();
check(rowText.includes("12,000") && rowText.includes("1,200") && rowText.includes("10,800"), "payout booked: ₹12,000 fee, ₹1,200 TDS, ₹10,800 to pay");
await row.getByRole("button", { name: "Mark paid" }).click();
await finance.getByPlaceholder("UTR / reference").fill(`UTR${stamp}`);
await finance.getByRole("button", { name: "Save", exact: true }).click();
await finance.locator("tr", { hasText: title }).getByText(`UTR${stamp}`).waitFor({ timeout: 10000 }).catch(() => {});
check((await finance.locator("tr", { hasText: title }).innerText()).includes("Paid"), "finance marks it paid with a reference");
const closed = await apiCall(am, "GET", `/workspace/briefs/${id}`);
check(closed.body.status === "paid", `brief closes as paid (${closed.body.status})`);
await creator.goto(`${BASE}/creator/payouts`, { waitUntil: "networkidle" });
check((await creator.locator("tr", { hasText: title }).innerText().catch(() => "")).includes("Paid") || (await text(creator)).includes("Paid"), "creator sees the payout as paid");
const paidNote = await apiCall(creator, "GET", "/notifications");
check(paidNote.body.items.some((n) => /paid|sent/i.test(n.title + n.body) && (n.title + n.body).includes("10,800")), "creator is notified with the net amount");

console.log("Decline");
const id2 = await newBrief(`Journey decline ${stamp}`, 5000);
await creator.goto(`${BASE}/creator/briefs/${id2}`, { waitUntil: "networkidle" });
await creator.getByRole("button", { name: /Decline/ }).click();
await creator.waitForLoadState("networkidle").catch(() => {});
await creator.waitForTimeout(800);
const declined = await apiCall(am, "GET", `/workspace/briefs/${id2}`);
check(declined.body.status === "declined", `declined brief is marked declined (${declined.body.status})`);

const errs = [am, creator, finance].flatMap((p) => p.errors);
check(errs.length === 0, `no page errors (${errs.slice(0, 3).join(" | ")})`);
await browser.close();
done();
