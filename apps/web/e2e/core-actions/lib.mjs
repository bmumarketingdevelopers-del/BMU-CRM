// Shared helpers for the v11 core journey scripts (shared actions and tasks). Plain Node + playwright-core.
// Run any script with: BASE_URL=http://localhost:3000 node apps/web/e2e/core-actions/<file>.mjs
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
export const SHOTS = process.env.SHOTS_DIR ?? "/tmp/claude-0/core-shots";
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
