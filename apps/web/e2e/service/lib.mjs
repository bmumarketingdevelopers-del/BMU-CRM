// Shared helpers for the service journey scripts (plain Node + playwright-core).
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/service/<script>.mjs
// playwright-core is resolved from node_modules, or PLAYWRIGHT_CORE (path to its index.mjs), or /opt/node-tools.
import { quietNetworkIdle } from "../team/lib.mjs";
import { mkdirSync } from "node:fs";

async function loadPlaywright() {
  const tries = ["playwright-core", process.env.PLAYWRIGHT_CORE, "/opt/node-tools/node_modules/playwright-core/index.mjs"].filter(Boolean);
  for (const t of tries) {
    try {
      return await import(t);
    } catch {
      /* try the next one */
    }
  }
  throw new Error("playwright-core not found. Install it (npm i -D playwright-core) or set PLAYWRIGHT_CORE to its index.mjs");
}

export const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const SHOTS = process.env.SHOTS_DIR ?? "/tmp/claude-0/service-shots";
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
export function check(ok, what) {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.log(`  ✗ ${what}`);
  }
}
export function done() {
  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}

export async function browser() {
  const { chromium } = await loadPlaywright();
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", headless: true });
}

/** New signed-in page for a demo user. Collects page errors and failed API calls. */
export async function signIn(b, email, { width = 1360, height = 900 } = {}) {
  const ctx = await b.newContext({ viewport: { width, height } });
  ctx.setDefaultTimeout(60_000);
  const page = await ctx.newPage();
  quietNetworkIdle(page);
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(`${email}: ${e.message}`));
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 500) page.errors.push(`${email}: ${r.status()} ${r.url()}`);
  });
  await page.goto(`${BASE}/sign-in`);
  await page.getByPlaceholder("Email or mobile number").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 20_000 });
  return page;
}

/** Calls the API from inside the signed-in page (same cookie). */
export async function apiCall(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(`/api${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: r.status, json };
    },
    { method, path, body },
  );
}

export async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
