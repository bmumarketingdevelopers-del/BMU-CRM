// v20 load test against the SLOs in docs/spec/architecture-v2.json:
//   API p95 ≤ 300 ms · search p95 ≤ 200 ms · page first load ≤ 1.5 s.
// Needs the API (and, for pages, the website) running with the demo data. No extra packages.
//
//   pnpm loadtest                                   # 30 API requests/s and 10 searches/s for 30 s
//   LOAD_RPS=60 SEARCH_RPS=20 pnpm loadtest         # heavier
//
// Requests arrive at a steady rate whether or not earlier ones have finished (like real people), which is what
// the SLO is about. It also reports the most requests per second one API process handled flat out.
//   WEB_URL=http://localhost:3000 pnpm loadtest     # also time page loads (use `pnpm build` + `next start` for real numbers)
//
// Writes the results to docs/loadtest-results.md and exits 1 if a target is missed.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const API = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const WEB = process.env.WEB_URL?.replace(/\/$/, "");
const RPS = Number(process.env.LOAD_RPS ?? 30);
const SEARCH_RPS = Number(process.env.SEARCH_RPS ?? 10);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 30);
const USERS = Number(process.env.LOAD_USERS ?? 20);
// Several people at once (each has their own permissions, so their own answers), plus someone changing things.
const WHO = (process.env.LOAD_AS ?? "founder@bmu.demo,admin@bmu.demo,am.lead@bmu.demo,am@bmu.demo,sales.manager@bmu.demo,sales@bmu.demo,producer@bmu.demo,video@bmu.demo,design@bmu.demo,finance@bmu.demo").split(",");
const WRITES_PER_SEC = Number(process.env.WRITES_PER_SEC ?? 1);

async function signIn(identifier) {
  const req = await fetch(`${API}/auth/otp/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier }) }).then((r) => r.json());
  if (!req.devCode) throw new Error("Sign-in needs the development code (run the API without production OTP sending).");
  const v = await fetch(`${API}/auth/otp/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier, code: req.devCode }) }).then((r) => r.json());
  if (!v.token) throw new Error(`Sign-in failed for ${identifier}: ${JSON.stringify(v)}`);
  return v.token;
}

const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** Starts `rps` requests a second over `paths` for `seconds` (open loop) and times each answer. */
async function rate(name, paths, tokens, rps, seconds = SECONDS) {
  const times = [];
  let errors = 0;
  const total = Math.round(rps * seconds);
  const start = performance.now();
  const inflight = [];
  for (let i = 0; i < total; i++) {
    const due = start + (i * 1000) / rps;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const token = tokens[i % tokens.length];
    const own = allowed.get(token)?.filter((p) => paths.includes(p)) ?? paths;
    const path = own[Math.floor(i / tokens.length) % own.length];
    inflight.push(
      (async () => {
        const t0 = performance.now();
        try {
          const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
          await r.arrayBuffer();
          if (!r.ok) errors++;
        } catch {
          errors++;
        }
        times.push(performance.now() - t0);
      })(),
    );
  }
  await Promise.all(inflight);
  return { name, requests: times.length, rps, p50: pct(times, 50), p95: pct(times, 95), p99: pct(times, 99), errors };
}

/** `users` virtual users loop over `paths` for `seconds`, each waiting for its answer before the next call. */
async function run(name, paths, tokens, { users = USERS, seconds = SECONDS } = {}) {
  const times = [];
  let errors = 0;
  const end = performance.now() + seconds * 1000;
  let i = 0;
  await Promise.all(
    Array.from({ length: users }, async () => {
      while (performance.now() < end) {
        const token = tokens[i % tokens.length];
        const own = allowed.get(token)?.filter((p) => paths.includes(p)) ?? paths;
        const path = own[Math.floor(i++ / tokens.length) % own.length];
        const t0 = performance.now();
        try {
          const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
          await r.arrayBuffer();
          if (!r.ok) errors++;
        } catch {
          errors++;
        }
        times.push(performance.now() - t0);
      }
    }),
  );
  return { name, requests: times.length, rps: Math.round(times.length / seconds), p50: pct(times, 50), p95: pct(times, 95), p99: pct(times, 99), errors };
}

async function pages(token) {
  let chromium;
  for (const name of ["playwright", "playwright-core", "@playwright/test"]) {
    try {
      const m = await import(name);
      chromium = m.chromium ?? m.default?.chromium;
      if (chromium) break;
    } catch {
      // try the next one
    }
  }
  if (!chromium && process.env.PW_PATH) chromium = createRequire(process.env.PW_PATH)("playwright-core").chromium;
  if (!chromium) return { skipped: "Playwright is not installed here, so page loads were not timed (npm i -g playwright, then set PW_PATH to its node_modules folder)." };
  const exe = process.env.CHROME_PATH ?? process.env.PLAYWRIGHT_EXECUTABLE;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "bmu_session", value: token, url: WEB }]);
  const page = await ctx.newPage();
  const list = ["/", "/services", "/admin", "/team", "/team/tasks", "/admin/pipeline", "/admin/intelligence", "/team/leads"];
  const out = [];
  for (const path of list) {
    // First visit warms the server (and compiles in dev); the next three are timed.
    await page.goto(`${WEB}${path}`, { waitUntil: "load" }).catch(() => {});
    const runs = [];
    for (let k = 0; k < 3; k++) {
      await page.goto(`${WEB}${path}`, { waitUntil: "load" });
      runs.push(await page.evaluate(() => performance.getEntriesByType("navigation")[0].loadEventEnd));
    }
    out.push({ path, ms: pct(runs, 50) });
  }
  await browser.close();
  return { pages: out };
}

const tokens = [];
const allowed = new Map();
for (const who of WHO) tokens.push(await signIn(who));
const token = tokens[0];
const API_PATHS = ["/auth/me", "/tasks?scope=mine", "/leads", "/notifications", "/insights/weekly", "/clients", "/tasks/query?scope=team", "/intelligence/overview", "/my-day"];
const SEARCH_PATHS = ["/team-flows/search?q=sun", "/team-flows/search?q=reel", "/team-flows/search?q=cafe&surface=admin", "/team-flows/search?q=invoice", "/team-flows/search?q=priya"];
console.log(`Load test against ${API}: ${WHO.length} people, ${RPS} API requests/s and ${SEARCH_RPS} searches/s together for ${SECONDS}s, with ${WRITES_PER_SEC} change(s)/s`);
// Each person only calls what their role can open (others would get a quick "no access", which isn't a fair test).
// This also warms up the server and builds the search index.
for (const t of tokens) {
  const ok = [];
  for (const p of [...API_PATHS, ...SEARCH_PATHS]) if ((await fetch(`${API}${p}`, { headers: { authorization: `Bearer ${t}` } }).then(async (r) => (await r.arrayBuffer(), r.status))) === 200) ok.push(p);
  allowed.set(t, ok);
}

// Someone keeps editing a task while the test runs: every change clears cached screens, as in real use.
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const team = await fetch(`${API}/tasks/query?scope=team`, { headers: auth }).then((r) => r.json());
const target0 = (Array.isArray(team) ? team : []).find((t) => t.status !== "done" && t.status !== "cancelled");
let writes = 0;
let writing = !!target0 && WRITES_PER_SEC > 0;
const writer = (async () => {
  while (writing) {
    await fetch(`${API}/tasks/${target0.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ title: `${target0.title.replace(/ · load \d+$/, "")} · load ${writes % 2}` }) }).then((r) => r.arrayBuffer(), () => undefined);
    writes++;
    await new Promise((r) => setTimeout(r, 1000 / WRITES_PER_SEC));
  }
})();
const [api, search] = await Promise.all([rate("API (lists, records, dashboards)", API_PATHS, tokens, RPS), rate("Search", SEARCH_PATHS, tokens, SEARCH_RPS)]);
console.log(`Flat-out capacity: ${USERS} users with no pause for 10s…`);
const flat = await run("Flat out", [...API_PATHS, ...SEARCH_PATHS], tokens, { users: USERS, seconds: 10 });
writing = false;
await writer;
if (target0) await fetch(`${API}/tasks/${target0.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ title: target0.title.replace(/ · load \d+$/, "") }) });
const web = WEB ? await pages(token) : { skipped: "Set WEB_URL to time page loads." };

const target = { api: 300, search: 200, page: 1500 };
const rows = [
  [api.name, api, target.api],
  [search.name, search, target.search],
];
const ok = (r, t) => r.p95 <= t && r.errors === 0;
const lines = [
  `# Load test results`,
  ``,
  `Run ${new Date().toISOString()} · ${WHO.length} people · ${RPS} API requests/s and ${SEARCH_RPS} searches/s at the same time for ${SECONDS}s · ${writes} task edits during the run (each clears cached screens) · API ${API}${WEB ? ` · website ${WEB}` : ""}.`,
  ``,
  `| Test | Requests | Per second | p50 | p95 | p99 | Errors | Target p95 | Result |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ...rows.map(([n, r, t]) => `| ${n} | ${r.requests} | ${r.rps} | ${r.p50.toFixed(0)} ms | ${r.p95.toFixed(0)} ms | ${r.p99.toFixed(0)} ms | ${r.errors} | ${t} ms | ${ok(r, t) ? "met" : "MISSED"} |`),
  ``,
  `Flat out (${USERS} users, no pause, mixed calls): one API process answered ${flat.rps} requests a second, p50 ${flat.p50.toFixed(0)} ms, p95 ${flat.p95.toFixed(0)} ms, ${flat.errors} errors. Past this rate requests queue; run more API processes behind a load balancer to go higher.`,
  ``,
];
if (web.pages) {
  lines.push(`| Page | First load (median of 3, warm) | Target | Result |`, `| --- | --- | --- | --- |`);
  for (const p of web.pages) lines.push(`| ${p.path} | ${p.ms.toFixed(0)} ms | ${target.page} ms | ${p.ms <= target.page ? "met" : "MISSED"} |`);
} else lines.push(web.skipped);
const report = lines.join("\n") + "\n";
console.log("\n" + report);
writeFileSync(new URL("../docs/loadtest-results.md", import.meta.url), report);
const failed = rows.some(([, r, t]) => !ok(r, t)) || (web.pages ?? []).some((p) => p.ms > target.page);
process.exit(failed ? 1 : 0);
