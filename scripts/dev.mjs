// `pnpm dev`: creates env files, starts a database (no Docker needed), applies
// migrations, loads BMU data, then runs the website and API together.
// Safe to run every time; each step skips itself when there's nothing to do.
import { execSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });
const say = (msg) => console.log(`\x1b[32m[bmu]\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\n\x1b[31m[bmu] ${msg}\x1b[0m\n`);
  process.exit(1);
};
const startServers = !process.argv.includes("--prepare-only");

// 1. Env files. Fallback contents in case an example file is missing (some unzip tools drop dotfiles).
const defaults = {
  "apps/api/.env": [
    'DATABASE_URL="postgresql://bmu:bmu@localhost:5432/bmu_hub?schema=public"',
    'REDIS_URL="redis://localhost:6379"',
    "PORT=4000",
    'CORS_ORIGINS="http://localhost:3000"',
    'JWT_SECRET="dev-only-change-me"',
    "NODE_ENV=development",
    "OWNER_EMAIL=bmumarketingpaidtools@gmail.com",
  ],
  "apps/web/.env.local": ["API_URL=http://localhost:4000"],
};

for (const [from, to] of [
  ["apps/api/.env.example", "apps/api/.env"],
  ["apps/web/.env.example", "apps/web/.env.local"],
]) {
  const target = join(root, to);
  const source = join(root, from);
  if (!existsSync(target)) {
    if (existsSync(source)) copyFileSync(source, target);
    else writeFileSync(target, defaults[to].join("\n") + "\n");
    say(`Created ${to}`);
    continue;
  }
  // Add settings introduced in newer versions without touching existing values.
  const current = readFileSync(target, "utf8");
  const lines = existsSync(source) ? readFileSync(source, "utf8").split(/\r?\n/) : defaults[to];
  const missing = lines.filter((l) => /^[A-Z_]+=/.test(l) && !new RegExp(`^${l.split("=")[0]}=`, "m").test(current));
  if (missing.length) {
    appendFileSync(target, (current.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n");
    say(`Added ${missing.map((l) => l.split("=")[0]).join(", ")} to ${to}`);
  }
}

// 2. Database. Uses one already running on the port (yours or Docker); otherwise
// starts a private Postgres stored in .bmu-data/ inside this folder.
const envText = readFileSync(join(root, "apps/api/.env"), "utf8");
const dbUrl = new URL((envText.match(/^DATABASE_URL="?([^"\r\n]+)"?/m) ?? [])[1] ?? "postgresql://bmu:bmu@localhost:5432/bmu_hub");
const db = {
  user: decodeURIComponent(dbUrl.username || "bmu"),
  password: decodeURIComponent(dbUrl.password || "bmu"),
  port: Number(dbUrl.port || 5432),
  name: dbUrl.pathname.slice(1) || "bmu_hub",
};

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
    socket.setTimeout(1500, () => (socket.destroy(), resolve(false)));
  });

let embedded;
const isLocalDb = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(dbUrl.hostname);
if (!isLocalDb) {
  say(`Using the database at ${dbUrl.hostname}.`);
} else if (await portOpen(db.port)) {
  say(`Using the database already running on port ${db.port}.`);
} else if (/^EMBEDDED_DB=["']?0/m.test(envText)) {
  // Set once the data lives in an installed PostgreSQL: starting the old private copy would show stale data.
  fail(
    `No database is running on port ${db.port}.\n` +
      `      Start your PostgreSQL service (as Administrator: Start-Service postgresql-x64-17), then run pnpm dev again.\n` +
      `      (EMBEDDED_DB=0 in apps/api/.env stops pnpm dev from using the old private database in .bmu-data.)`,
  );
} else {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dataDir = join(root, ".bmu-data", "postgres");
  const fresh = !existsSync(join(dataDir, "PG_VERSION"));
  mkdirSync(join(root, ".bmu-data"), { recursive: true });
  // The library can report spawn failures as uncaught errors; show them as a normal failure.
  const onCrash = (e) => fail(`Could not start the database: ${e?.message ?? e}\n      Copy this message and send it to Claude.`);
  process.once("uncaughtException", onCrash);
  embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: db.user,
    password: db.password,
    port: db.port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--no-locale"],
    onLog: () => {},
    onError: (e) => process.env.BMU_DEBUG && console.error(String(e)),
  });
  try {
    if (fresh) {
      say("Setting up the database for the first time (about a minute)...");
      await embedded.initialise();
    }
    say("Starting the database...");
    await embedded.start();
    if (fresh) await embedded.createDatabase(db.name);
    process.removeListener("uncaughtException", onCrash);
  } catch (e) {
    fail(
      `Could not start the database: ${e?.message ?? e}\n` +
        `      Try again with: pnpm dev\n` +
        `      If it keeps failing, delete the .bmu-data folder in this project and run pnpm dev again.`,
    );
  }
}

let stopping = false;
async function stopDb() {
  if (stopping || !embedded) return;
  stopping = true;
  say("Stopping the database...");
  await embedded.stop().catch(() => {});
}

// 3. Tables and data.
try {
  say("Updating database tables...");
  run("pnpm --filter @bmu/api exec prisma migrate deploy");
  say("Loading BMU data...");
  run("pnpm --filter @bmu/shared build");
  run("pnpm --filter @bmu/api exec prisma db seed");
} catch {
  await stopDb();
  fail("Setup failed. Copy the red lines above and send them to Claude.");
}

if (!startServers) {
  await stopDb();
  process.exit(0);
}

// 4. Website + API. Ctrl+C stops everything, including the database.
say("Starting the website and API. Website: http://localhost:3000  ·  API: http://localhost:4000/health");
const child = spawn("pnpm", ["exec", "turbo", "run", "dev", "--filter=@bmu/web", "--filter=@bmu/api", "--filter=@bmu/shared"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
const shutdown = async (code) => {
  await stopDb();
  process.exit(code ?? 0);
};
child.on("exit", (code) => shutdown(code));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    if (child.exitCode !== null) return shutdown(0);
    child.kill(sig);
    setTimeout(() => shutdown(0), 5000).unref();
  });
}
