#!/usr/bin/env node
// Runs BMU Hub on one server without Docker, as separate processes: API, background worker and website.
//
//   pnpm build:prod     # once after every update
//   pnpm start          # applies new database migrations, then starts all three; Ctrl+C stops them
//
// Settings come from apps/api/.env (set NODE_ENV=production there for a live server, see .env.production.example).
// A process that crashes is restarted after 3 seconds. Options: --no-migrate, --no-web, --api-only, --worker-only.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const api = join(root, "apps/api");
const web = join(root, "apps/web");
const args = new Set(process.argv.slice(2));
const say = (m) => console.log(`[start] ${m}`);

// PORT / WORKER_PORT / API_URL from apps/api/.env (the API reads the rest itself).
const apiEnv = {};
try {
  for (const line of readFileSync(join(api, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?/);
    if (m) apiEnv[m[1]] = m[2].trim();
  }
} catch {
  // no apps/api/.env: environment variables only
}
const setting = (k, d) => process.env[k] || apiEnv[k] || d;
const apiPort = setting("PORT", "4000");
const workerPort = setting("WORKER_PORT", "4001");
const webPort = setting("WEB_PORT", "3000");
// The website's server side calls the API directly (the browser goes through /api on the website).
const apiUrl = setting("API_URL", `http://localhost:${apiPort}`);

const nextBin = join(web, "node_modules/next/dist/bin/next");
const prismaBin = join(api, "node_modules/prisma/build/index.js");
const missing = [
  [join(api, "dist/main.js"), "API"],
  [join(api, "dist/worker.js"), "worker"],
  ...(args.has("--no-web") || args.has("--api-only") || args.has("--worker-only") ? [] : [[join(web, ".next/BUILD_ID"), "website"]]),
].filter(([f]) => !existsSync(f));
if (missing.length) {
  say(`Not built yet (${missing.map(([, n]) => n).join(", ")}). Run: pnpm build:prod`);
  process.exit(1);
}

if (!args.has("--no-migrate") && !args.has("--web-only")) {
  say("Applying database migrations…");
  const r = spawnSync(process.execPath, [prismaBin, "migrate", "deploy"], { cwd: api, stdio: "inherit" });
  if (r.status !== 0) {
    say("Migrations failed: check DATABASE_URL in apps/api/.env and that Postgres is running.");
    process.exit(1);
  }
}

const services = [
  { name: "api", cwd: api, cmd: [join(api, "dist/main.js")], env: { PROCESS_ROLE: "api" }, on: !args.has("--worker-only") },
  { name: "worker", cwd: api, cmd: [join(api, "dist/worker.js")], env: { PROCESS_ROLE: "worker" }, on: !args.has("--api-only") },
  { name: "web", cwd: web, cmd: [nextBin, "start", "--port", webPort], env: { API_URL: apiUrl }, on: !args.has("--no-web") && !args.has("--api-only") && !args.has("--worker-only") },
].filter((s) => s.on);

let stopping = false;
const running = new Map();

function run(s) {
  const child = spawn(process.execPath, s.cmd, { cwd: s.cwd, env: { ...process.env, ...s.env }, stdio: ["ignore", "pipe", "pipe"] });
  running.set(s.name, child);
  const prefix = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) out.write(`[${s.name}] ${l}\n`);
    });
  };
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    running.delete(s.name);
    if (stopping) return;
    say(`${s.name} stopped (${signal ?? `exit ${code}`}); restarting in 3 seconds`);
    setTimeout(() => !stopping && run(s), 3000);
  });
}

for (const s of services) run(s);
say(`Started ${services.map((s) => s.name).join(", ")}. Website http://localhost:${webPort} · API http://localhost:${apiPort}/health/ready · worker http://localhost:${workerPort}/health/ready`);

function stop() {
  if (stopping) process.exit(1);
  stopping = true;
  say("Stopping (waiting for work in progress)…");
  for (const c of running.values()) c.kill("SIGTERM");
  const wait = setInterval(() => {
    if (!running.size) {
      clearInterval(wait);
      process.exit(0);
    }
  }, 200);
  setTimeout(() => process.exit(0), 35_000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
