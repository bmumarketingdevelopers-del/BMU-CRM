// Shared helpers for the team-area journey scripts. Plain Node + playwright-core.
// Run any script with: BASE_URL=http://localhost:3000 node apps/web/e2e/team/<file>.mjs
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
export const SHOTS = process.env.SHOTS_DIR ?? "/tmp/claude-0/team-shots";
mkdirSync(SHOTS, { recursive: true });

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
    if (m.type() === "error" && !/Failed to load resource|404|401|Download the React DevTools/.test(m.text())) page.errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/api/") && r.status() >= 500) page.errors.push(`api ${r.status()} ${r.request().method()} ${u.replace(BASE, "")}`);
  });
  return page;
}

/**
 * v13: every signed-in page keeps one live-updates stream open, so the browser's own "networkidle" never happens.
 * This makes "networkidle" (waitForLoadState, goto, reload) mean: page loaded and no other request for 500 ms.
 */
export function quietNetworkIdle(page) {
  const inflight = new Set();
  const isStream = (r) => r.url().includes("/realtime/stream");
  page.on("request", (r) => !isStream(r) && inflight.add(r));
  page.on("requestfinished", (r) => inflight.delete(r));
  page.on("requestfailed", (r) => inflight.delete(r));
  const idle = async (timeout = 30000) => {
    const deadline = Date.now() + timeout;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (inflight.size) quietSince = Date.now();
      else if (Date.now() - quietSince >= 500) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out after ${timeout} ms waiting for the network to be idle`);
  };
  const origWait = page.waitForLoadState.bind(page);
  page.waitForLoadState = async (state, opts) => {
    if (state !== "networkidle") return origWait(state, opts);
    await origWait("load", opts);
    return idle(opts?.timeout);
  };
  for (const name of ["goto", "reload"]) {
    const orig = page[name].bind(page);
    page[name] = async (...args) => {
      const opts = name === "goto" ? args[1] : args[0];
      if (opts?.waitUntil !== "networkidle") return orig(...args);
      const res = name === "goto" ? await orig(args[0], { ...opts, waitUntil: "load" }) : await orig({ ...opts, waitUntil: "load" });
      await idle(opts.timeout);
      return res;
    };
  }
}

/** Signs in through the real form (dev mode fills the code). Returns the URL landed on. */
export async function signIn(page, identifier, { expectHome } = {}) {
  await page.goto(`${BASE}/sign-in`);
  await page.getByPlaceholder("Email or mobile number").fill(identifier);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 20000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  if (expectHome && !new URL(page.url()).pathname.startsWith(expectHome)) throw new Error(`${identifier} landed on ${page.url()}, expected ${expectHome}`);
  return new URL(page.url()).pathname;
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

let failures = 0;
export function check(cond, label) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
}
export function done() {
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}
export const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
