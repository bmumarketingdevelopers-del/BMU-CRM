// Shared helpers for the deliver journey scripts (plain Node + playwright-core).
// BASE_URL is the web app (default http://localhost:3000); API calls go through its /api rewrite.
import { quietNetworkIdle } from "../team/lib.mjs";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const API = `${BASE}/api`;
export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");
export const SHOTS = process.env.SHOTS_DIR ?? "/tmp/claude-0/deliver-shots";
mkdirSync(SHOTS, { recursive: true });

const tokens = new Map();

export async function token(email) {
  if (tokens.has(email)) return tokens.get(email);
  const otp = await raw("POST", "/auth/otp/request", { identifier: email });
  const res = await raw("POST", "/auth/otp/verify", { identifier: email, code: otp.devCode });
  tokens.set(email, res.token);
  return res.token;
}

async function raw(method, path, body, tok, form) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(form ? {} : { "Content-Type": "application/json" }), ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data?.message === "string" ? data.message : JSON.stringify(data?.message ?? data);
    const err = new Error(`${method} ${path} → ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** api(email) → { get, post, patch, put, upload } signed in as that user. */
export function api(email) {
  const t = () => token(email);
  return {
    get: async (p) => raw("GET", p, undefined, await t()),
    post: async (p, b) => raw("POST", p, b, await t()),
    patch: async (p, b) => raw("PATCH", p, b, await t()),
    put: async (p, b) => raw("PUT", p, b, await t()),
    upload: async (p, file, mime, fields = {}) => {
      const form = new FormData();
      form.append("file", new Blob([readFileSync(join(FIXTURES, file))], { type: mime }), file);
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      return raw("POST", p, undefined, await t(), form);
    },
    raw: async (p) => fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${await t()}` } }),
  };
}

export const publicApi = { get: (p) => raw("GET", p), post: (p, b) => raw("POST", p, b) };

/** expect a call to fail with a status (and optional message fragment). */
export async function rejects(promise, status, fragment) {
  try {
    await promise;
  } catch (e) {
    if (e.status !== status) throw new Error(`Expected ${status}, got ${e.message}`);
    if (fragment && !e.message.includes(fragment)) throw new Error(`Expected message with "${fragment}", got ${e.message}`);
    return e.message;
  }
  throw new Error(`Expected a ${status} rejection`);
}

export function check(cond, what) {
  if (!cond) throw new Error(`Check failed: ${what}`);
  console.log(`  ✓ ${what}`);
}

/**
 * A brand-new paying client: website enquiry → proposal (sales) → accept + e-sign → test payment.
 * Returns the owner's email, client id and engagement ids. Requires payments test mode (dev default).
 */
export async function freshClient({ services = [{ serviceKey: "logo_brand_kit", tier: "starter" }], tag = Date.now().toString(36) } = {}) {
  const email = `owner.${tag}@deliver-e2e.demo`;
  const phone = `9${String(Date.now()).slice(-9)}`;
  const company = `Deliver Journey ${tag}`;
  await publicApi.post("/leads/enquiry", { name: `Owner ${tag}`, email, phone, company, need: "Branding and social media for our launch", serviceIds: services.map((s) => s.serviceKey) });
  const sales = api("founder@bmu.demo");
  const leads = await sales.get("/leads");
  const lead = leads.find((l) => l.contact?.email === email || l.email === email || JSON.stringify(l).includes(email));
  if (!lead) throw new Error("Lead not found after enquiry");
  const proposal = await sales.post("/proposals", { leadId: lead.id, lines: services });
  await sales.post(`/proposals/${proposal.id}/send`);
  await publicApi.post(`/public/proposals/${proposal.publicToken}/accept`, { signerName: `Owner ${tag}`, signerEmail: email, agree: true });
  await publicApi.post(`/public/proposals/${proposal.publicToken}/pay-test`);
  const owner = api(email);
  const overview = await owner.get("/client/overview");
  return { email, company, clientOrgId: overview.clientOrg.id, engagements: overview.engagements, owner, proposal };
}

/** Browser session signed in as a user. */
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

export async function launch() {
  let pw;
  for (const p of [process.env.PLAYWRIGHT_CORE, "playwright-core", "/opt/node-tools/node_modules/playwright-core/index.mjs"].filter(Boolean)) {
    try {
      pw = await import(p);
      break;
    } catch {
      /* try the next location */
    }
  }
  if (!pw) throw new Error("playwright-core not found. Install it (npm i -g playwright-core) or set PLAYWRIGHT_CORE.");
  const chromium = pw.chromium ?? pw.default.chromium;
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
}
