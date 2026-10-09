// Analytics journeys: every analytics page through every period preset, every CSV export parsed and checked,
// report builder save / pin / share / delete, and a shared report seen by a colleague.
// BASE_URL=http://localhost:3000 node apps/web/e2e/team/analytics.mjs
import { readFileSync } from "node:fs";
import { BASE, launch, newPage, signIn, apiCall, check, done } from "./lib.mjs";

const PAGES = ["/admin/analytics", "/admin/analytics/funnel", "/admin/analytics/forecast", "/admin/analytics/retention", "/admin/analytics/profitability", "/admin/analytics/team", "/admin/analytics/delivery", "/admin/analytics/sla", "/admin/analytics/explore"];
const PRESETS = ["30 days", "90 days", "6 months", "12 months", "This FY"];

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else if (c !== "\r") cell += c;
  }
  if (q) throw new Error("unterminated quote");
  row.push(cell);
  rows.push(row);
  return rows;
}

const browser = await launch();
const page = await newPage(browser);
await signIn(page, "founder@bmu.demo");
const ctxDownloads = [];

for (const url of PAGES) {
  console.log(url);
  page.errors = [];
  await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
  for (const label of PRESETS) {
    const btn = page.getByRole("button", { name: label, exact: true }).first();
    if (!(await btn.count())) continue;
    await btn.click();
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  const body = await page.locator("body").innerText();
  check(!page.errors.length && !/Application error|Request failed \(5/.test(body), `periods switch cleanly ${page.errors.slice(0, 2).join(" | ")}`);
  // back to a wide window so every table has rows to export
  const wide = page.getByRole("button", { name: "12 months", exact: true }).first();
  if (await wide.count()) {
    await wide.click();
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  const csvButtons = page.getByRole("button", { name: /CSV/i });
  await csvButtons.first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  const n = await csvButtons.count();
  let exported = 0;
  for (let i = 0; i < n; i++) {
    const b = csvButtons.nth(i);
    if (await b.isDisabled()) continue;
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), b.click()]);
    const path = await dl.path();
    const text = readFileSync(path, "utf8").replace(/^﻿/, "");
    let rows = [];
    let err = "";
    try {
      rows = parseCsv(text);
    } catch (e) {
      err = e.message;
    }
    const width = rows[0]?.length ?? 0;
    const ragged = rows.filter((r) => r.length !== width).length;
    const junk = rows.flat().filter((v) => /^(undefined|NaN|\[object Object\]|null)$/.test(v)).length;
    check(!err && rows.length >= 2 && width > 1 && !ragged && !junk, `${dl.suggestedFilename()}: ${rows.length - 1} rows × ${width} cols${ragged ? `, ${ragged} ragged` : ""}${junk ? `, ${junk} junk values` : ""}${err ? `, ${err}` : ""}`);
    exported++;
    ctxDownloads.push(dl.suggestedFilename());
  }
  if (n && !exported) console.log("  --   CSV buttons present but disabled (no rows in period)");
}

console.log("Report builder");
await page.goto(`${BASE}/admin/analytics/explore`, { waitUntil: "networkidle" });
const name = `Journey report ${Date.now() % 100000}`;
await page.getByPlaceholder(/ by /).fill(name);
await page.getByLabel("Share with the team").check();
await page.getByRole("button", { name: "Save report" }).click();
await page.getByText(`Saved “${name}”`).waitFor({ timeout: 10000 }).catch(() => {});
check(await page.getByText(`Saved “${name}”`).isVisible(), "report saved");
const li = page.locator("li", { hasText: name }).first();
await li.getByRole("button", { name: "Pin" }).click();
await li.getByText("Pinned").waitFor({ timeout: 10000 }).catch(() => {});
check(await li.getByText("Pinned").isVisible(), "report pinned");
const list = await apiCall(page, "GET", "/ops-analytics/reports");
const saved = (list.body?.mine ?? []).find((r) => r.name === name);
check(saved?.pinned && saved?.shared, "saved report is pinned and shared in the API");

const colleague = await newPage(browser);
await signIn(colleague, "admin@bmu.demo");
await colleague.goto(`${BASE}/admin/analytics/explore`, { waitUntil: "networkidle" });
check((await colleague.locator("body").innerText()).includes(name), "a colleague sees the shared report");

await li.getByRole("button", { name: "Stop sharing" }).click();
await page.waitForTimeout(800);
await colleague.reload({ waitUntil: "networkidle" });
check(!(await colleague.locator("body").innerText()).includes(name), "stop sharing hides it from colleagues");

page.once("dialog", (d) => d.accept());
await li.getByRole("button", { name: "Delete" }).click();
await page.waitForTimeout(1000);
const after = await apiCall(page, "GET", "/ops-analytics/reports");
check(!(after.body?.mine ?? []).some((r) => r.name === name) && !(await li.isVisible()), "report deleted");

check(ctxDownloads.length >= 8, `${ctxDownloads.length} CSV exports downloaded and valid`);
check(!page.errors.length && !colleague.errors.length, `no page errors ${[...page.errors, ...colleague.errors].slice(0, 2).join(" | ")}`);
await browser.close();
done();
