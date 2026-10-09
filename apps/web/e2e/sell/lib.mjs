// Shared helpers for the sell journey scripts. Plain Node + playwright-core.
// Run any script with: BASE_URL=http://localhost:3000 node apps/web/e2e/sell/<file>.mjs
import { quietNetworkIdle } from "../team/lib.mjs";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of ["playwright-core", "/opt/node-tools/node_modules/playwright-core", "/tmp/claude-0/pw/node_modules/playwright-core"]) {
    try {
      return require(p);
    } catch {
      /* try next */
    }
  }
  throw new Error("playwright-core not found. Install it with: npm i -g playwright-core");
}
export const { chromium } = loadPlaywright();

export const BASE = process.env.BASE_URL ?? "http://localhost:3000";
export const SHOTS = process.env.SHOTS_DIR ?? "/tmp/claude-0/sell-shots";
mkdirSync(SHOTS, { recursive: true });

export async function launch() {
  const executablePath = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
  return chromium.launch({ executablePath, headless: true });
}

const problems = [];
/** New browser context with page-error and failed-API logging. */
export async function newPage(browser, label, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  quietNetworkIdle(page);
  page.on("pageerror", (e) => problems.push(`[${label}] page error: ${e.message}`));
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 500) problems.push(`[${label}] ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  page.setDefaultTimeout(15000);
  return page;
}

export async function signIn(page, identifier) {
  await page.goto(`${BASE}/sign-in`);
  await page.getByPlaceholder("Email or mobile number").fill(identifier);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 20000 });
}

export async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

let failures = 0;
export function check(ok, message) {
  if (ok) console.log(`  ok   ${message}`);
  else {
    failures++;
    console.log(`  FAIL ${message}`);
  }
}

/** Call the API through the web app's /api rewrite with this page's session cookie. */
export async function apiAs(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
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

export function finish() {
  if (problems.length) {
    console.log("\nProblems seen in the browser:");
    for (const p of problems) console.log("  - " + p);
  }
  const bad = failures + problems.length;
  console.log(bad ? `\n${failures} failed checks, ${problems.length} browser problems` : "\nAll checks passed");
  process.exitCode = bad ? 1 : 0;
}
