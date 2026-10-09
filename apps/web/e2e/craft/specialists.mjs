// Specialist journeys: sign in as each of the six specialists, click through their panels and do the main actions
// (check in, resolve a client comment, tick a checklist, upload a version, save a hook, nudge a client, add a
// staging link, compare versions), with a screenshot of each workspace.
//   BASE_URL=http://localhost:3205 node apps/web/e2e/craft/specialists.mjs [video,script,social,dev,uxui,design]
import { BASE, check, launch, shot, signIn } from "./lib.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082", "hex");
const stamp = Date.now().toString(36);
const only = (process.argv[2] ?? "video,script,social,dev,uxui,design").split(",");

async function common(page, who) {
  await page.goto(`${BASE}/team`);
  await page.waitForSelector("[data-craft]", { timeout: 60_000 });
  check((await page.getAttribute("[data-craft]", "data-craft")) !== "none", `${who}: the specialist workspace is the /team home`);
  const checkIn = page.getByRole("button", { name: "Check in" });
  if (await checkIn.count()) {
    await checkIn.click();
    await page.getByText(/In since/).waitFor({ timeout: 15_000 });
    check(true, `${who}: checked in from the strip`);
  }
  for (const tab of ["Tasks", "By day", "Hours"]) await page.getByRole("button", { name: tab, exact: true }).last().click();
  check(true, `${who}: workload tabs switch`);
}

async function resolveAndUndo(page, who) {
  const open = page.locator("[data-comment]").filter({ has: page.getByRole("button", { name: "Resolve" }) }).first();
  if (!(await open.count())) return console.log(`  - ${who}: no open comment to resolve`);
  const c = page.locator(`[data-comment="${await open.getAttribute("data-comment")}"]`); // pin it: the filter stops matching once resolved
  await c.getByRole("button", { name: "Resolve" }).click();
  await c.getByRole("button", { name: "Undo" }).waitFor({ timeout: 15_000 });
  await c.getByRole("button", { name: "Undo" }).click();
  await c.getByRole("button", { name: "Resolve" }).waitFor({ timeout: 15_000 });
  check(true, `${who}: resolved a client comment (and undid it)`);
}

async function toggleChecklist(page, who) {
  const box = page.locator("[data-checklist] input[type=checkbox]").first();
  if (!(await box.count())) return console.log(`  - ${who}: no checklist on screen`);
  const before = await box.isChecked();
  await box.click();
  await page.waitForFunction(([b]) => document.querySelector("[data-checklist] input[type=checkbox]")?.checked !== b, [before], { timeout: 15_000 });
  await box.click();
  check(true, `${who}: ticked a checklist item (saved, then restored)`);
}

async function upload(page, who, selector = "input[data-upload]") {
  const input = page.locator(selector).first();
  if (!(await input.count())) return console.log(`  - ${who}: nothing uploadable right now`);
  await input.setInputFiles({ name: `${who}-${stamp}.png`, mimeType: "image/png", buffer: PNG });
  await page.getByText(/uploaded — waiting for QC/).first().waitFor({ timeout: 30_000 });
  check(true, `${who}: uploaded a new version (sent to QC)`);
}

const journeys = {
  async video(page) {
    await resolveAndUndo(page, "video");
    await toggleChecklist(page, "video");
    await upload(page, "video");
  },
  async script(page) {
    const form = page.locator("[data-hook-form]");
    await form.getByLabel("New hook").fill(`Three things nobody tells you about winter skin ${stamp}`);
    await form.getByLabel("Hook tags").fill("skincare, curiosity");
    await form.getByRole("button", { name: "Save hook" }).click();
    await page.locator("[data-hooks]").getByText(stamp).waitFor({ timeout: 15_000 });
    check(true, "script: saved a hook to the library");
    const editor = page.locator("[data-script-editor] textarea").first();
    if (await editor.count()) {
      await editor.fill("## Hook\nNobody tells you this.\n\n## Body\nThree quick tips in twenty seconds, then the call to action.");
      check(/words/.test(await page.locator("[data-script-stats]").innerText()), "script: live word count and runtime update");
    }
    await resolveAndUndo(page, "script");
  },
  async social(page) {
    await page.getByRole("button", { name: "2+ days" }).click();
    await page.getByRole("button", { name: "All", exact: true }).first().click();
    const nudge = page.locator("[data-approval]").getByRole("button", { name: "Nudge client" }).first();
    if (await nudge.count()) {
      await nudge.click();
      await page.getByText("✓ Nudged").first().waitFor({ timeout: 15_000 });
      check(true, "social: nudged a client about a waiting approval");
    } else console.log("  - social: every approval was nudged in the last 24 hours");
    check((await page.locator("[data-day]").count()) === 7, "social: the 7-day posting schedule renders");
  },
  async dev(page) {
    const add = page.locator("[data-links]").getByRole("button", { name: "+ New staging link" }).first();
    if (await add.count()) {
      await add.click();
      await page.getByLabel("Staging URL").fill(`https://staging.example.com/build-${stamp}`);
      await page.getByRole("button", { name: "Send to QC" }).click();
      await page.getByLabel("Staging URL").waitFor({ state: "detached", timeout: 20_000 });
      check(true, "dev: added a staging link (new build sent to QC)");
    } else console.log("  - dev: no page ready for a new staging link");
  },
  async uxui(page) {
    await toggleChecklist(page, "uxui");
    await resolveAndUndo(page, "uxui");
    const compare = page.getByRole("link", { name: /Compare v\d+ ↔ v\d+/ }).first();
    if (await compare.count()) {
      await compare.click();
      await page.waitForSelector("[data-compare]", { timeout: 30_000 });
      check(true, "uxui: opened the side-by-side version compare");
      await shot(page, "journey-uxui-compare");
      await page.goBack();
      await page.waitForSelector("[data-craft]", { timeout: 60_000 });
    }
  },
  async design(page) {
    await upload(page, "design", "[data-quick-upload] input[data-upload]");
    await resolveAndUndo(page, "design");
  },
};

const browser = await launch();
const errors = [];
try {
  for (const who of only) {
    const s = await signIn(browser, `${who}@bmu.demo`);
    await common(s.page, who);
    await journeys[who](s.page);
    await s.page.waitForTimeout(500);
    await shot(s.page, `journey-${who}`);
    errors.push(...s.errors);
    await s.ctx.close();
  }
} finally {
  await browser.close();
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("specialist journeys passed");
