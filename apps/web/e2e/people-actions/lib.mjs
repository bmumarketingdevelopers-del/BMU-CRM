// Shared helpers for the v11 people & hierarchy journey scripts. Plain Node + playwright-core.
// Run any script with: BASE_URL=http://localhost:3000 node apps/web/e2e/people-actions/<file>.mjs
import { quietNetworkIdle } from "../team/lib.mjs";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

let pw;
try {
  pw = await import("playwright-core");
} catch {
  pw = createRequire(process.env.PW_PATH ?? "/opt/node-tools/node_modules/")("playwright-core");
}
export const chromium = pw.chromium ?? pw.default.chromium;

export const BASE = process.env.BASE_URL ?? "http://localhost:3000";
export const SHOTS = process.env.SHOTS_DIR ?? "/tmp/claude-0/people-shots";
mkdirSync(SHOTS, { recursive: true });
export const stamp = Date.now() % 1_000_000;

export async function launch() {
  return chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium", headless: true });
}

/** A fresh browser context with page-error and failed-API collectors attached. */
export async function newPage(browser, { mobile = false } = {}) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 } } : { viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  quietNetworkIdle(page);
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|404|401|403|400|Download the React DevTools/.test(m.text())) page.errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/api/") && r.status() >= 500) page.errors.push(`api ${r.status()} ${r.request().method()} ${u.replace(BASE, "")}`);
  });
  return page;
}

/** Signs in through the real form (dev mode fills the code). */
export async function signIn(page, identifier) {
  await page.goto(`${BASE}/sign-in`);
  await page.getByPlaceholder("Email or mobile number").fill(identifier);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  return new URL(page.url()).pathname;
}

export async function as(browser, who, opts) {
  const page = await newPage(browser, opts);
  await signIn(page, who);
  return page;
}

/** Calls the API through the web rewrite with the page's session cookie. */
export async function apiCall(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: r.status, body: json };
    },
    { method, path, body },
  );
}

/** yyyy-mm-dd in IST, n days ahead, moved off Sunday. */
export function dayAhead(n) {
  const d = new Date(Date.now() + 5.5 * 3600_000 + n * 86_400_000);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export const go = async (page, path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
};
export const toast = (page) => page.getByTestId("action-toast").last();
export const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

let failures = 0;
export function check(cond, label) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
}
export function noErrors(page, label) {
  check(page.errors.length === 0, `${label}: no page errors${page.errors.length ? ` (${page.errors.slice(0, 3).join(" | ")})` : ""}`);
  page.errors.length = 0;
}
export function done() {
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}
export const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

/** People the journeys create use this email prefix, so cleanUp() can soft-delete them afterwards. */
export const JOURNEY_PREFIX = "journey.people";
export const journeyEmail = (tag) => `${JOURNEY_PREFIX}.${tag}.${stamp}@bmu.demo`;
/** A unique 10-digit Indian mobile number for this run. */
export const journeyPhone = (n) => `9${String(stamp).padStart(6, "0")}${String(n).padStart(3, "0")}`;

/**
 * Soft-deletes the staff users this run created (by email prefix), straight in the dev database, so the demo data
 * stays clean. Uses DATABASE_URL, or apps/api/.env when it isn't set. Skipped quietly when psql is not available.
 */
export async function cleanUp() {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  let url = process.env.DATABASE_URL;
  if (!url) {
    try {
      url = /DATABASE_URL="?([^"\n]+)"?/.exec(readFileSync(new URL("../../../api/.env", import.meta.url), "utf8"))?.[1];
    } catch {
      /* no env file */
    }
  }
  if (!url) return console.log("  (clean-up skipped: no DATABASE_URL)");
  try {
    const out = execFileSync("psql", [url.replace(/\?schema=\w+$/, ""), "-Atc", `update users set "deletedAt" = now(), status = 'suspended' where email like '${JOURNEY_PREFIX}.%${stamp}@bmu.demo' and "deletedAt" is null returning id`], { encoding: "utf8" });
    console.log(`  (cleaned up ${out.trim().split("\n").filter((l) => l && !l.startsWith("UPDATE")).length} journey user(s))`);
  } catch (e) {
    console.log(`  (clean-up skipped: ${e.message.split("\n")[0]})`);
  }
}

/** Selects the first option whose label starts with `prefix` (role names carry long descriptions). */
export async function pick(locator, prefix) {
  const value = await locator.evaluate((el, p) => [...el.options].find((o) => o.textContent.trim().startsWith(p) && !o.disabled)?.value ?? null, prefix);
  if (value === null) throw new Error(`No option starting with "${prefix}"`);
  await locator.selectOption(value);
}
