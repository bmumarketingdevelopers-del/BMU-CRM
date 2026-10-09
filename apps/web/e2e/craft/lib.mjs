// Shared helpers for the craft journey scripts (plain Node + playwright-core).
// BASE_URL is the web app (default http://localhost:3000); API calls go through its /api rewrite.
import { quietNetworkIdle } from "../team/lib.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const API = `${BASE}/api`;
export const SHOTS = process.env.SHOTS_DIR ?? "/tmp/claude-0/craft-shots";
mkdirSync(SHOTS, { recursive: true });

const tokens = new Map();
async function raw(method, path, body, tok) {
  const res = await fetch(`${API}${path}`, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${typeof data?.message === "string" ? data.message : text}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
export async function token(email) {
  if (!tokens.has(email)) {
    const otp = await raw("POST", "/auth/otp/request", { identifier: email });
    tokens.set(email, (await raw("POST", "/auth/otp/verify", { identifier: email, code: otp.devCode })).token);
  }
  return tokens.get(email);
}
/** api(email) → { get, post, put, patch } signed in as that user. */
export function api(email) {
  return {
    get: async (p) => raw("GET", p, undefined, await token(email)),
    post: async (p, b) => raw("POST", p, b, await token(email)),
    put: async (p, b) => raw("PUT", p, b, await token(email)),
    patch: async (p, b) => raw("PATCH", p, b, await token(email)),
  };
}

export function check(cond, what) {
  if (!cond) throw new Error(`Check failed: ${what}`);
  console.log(`  ✓ ${what}`);
}

export async function launch() {
  let pw;
  for (const p of [process.env.PLAYWRIGHT_CORE, "playwright-core", "/opt/node-tools/node_modules/playwright-core/index.mjs"].filter(Boolean)) {
    try {
      pw = await import(p);
      break;
    } catch {
      /* next */
    }
  }
  if (!pw) throw new Error("playwright-core not found. Install it (npm i -g playwright-core) or set PLAYWRIGHT_CORE.");
  const chromium = pw.chromium ?? pw.default.chromium;
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
}

/** Browser session signed in as a user (desktop, or phone width with { mobile: true }). */
export async function signIn(browser, email, { mobile = false } = {}) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true } : { viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  quietNetworkIdle(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${email}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|favicon|ERR_ABORTED|404/.test(m.text())) errors.push(`${email} console: ${m.text()}`);
  });
  await page.goto(`${BASE}/sign-in`);
  await page.getByPlaceholder("Email or mobile number").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30_000 });
  return { ctx, page, errors };
}

export async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}
