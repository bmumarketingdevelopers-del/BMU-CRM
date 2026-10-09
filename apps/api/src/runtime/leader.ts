// v21 backend runtime: makes sure only one process runs background jobs, using a Postgres advisory lock held on a
// dedicated connection for the life of the process. If that process stops, Postgres frees the lock and a standby
// worker takes over within one check (15 seconds).
import { Logger } from '@nestjs/common';
import pg from 'pg';

const LOCK_KEY = 727_011_021; // any fixed number; "bmu jobs"
const log = new Logger('JobsLock');
let holder: pg.Client | null = null;

async function tryLock(): Promise<boolean> {
  const client = new pg.Client({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL, application_name: 'bmu-hub-jobs-lock' });
  await client.connect();
  const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
  if (rows[0]?.ok) {
    holder = client;
    // If the lock connection drops, jobs could start running twice: stop and let the process manager restart us.
    client.on('error', (e) => {
      log.error(`Lost the jobs lock connection (${e.message}); exiting so a restart takes the lock again`);
      process.exit(1);
    });
    return true;
  }
  await client.end();
  return false;
}

/** Takes the lock without waiting. False when another process already runs the jobs. */
export async function takeJobsLock(): Promise<boolean> {
  return tryLock();
}

/** Waits until this process holds the lock (a second worker stays on standby until the first one stops). */
export async function waitForJobsLock(everyMs = 15_000): Promise<void> {
  let told = false;
  for (;;) {
    try {
      if (await tryLock()) return;
      if (!told) log.log('Another worker is running the background jobs; this one is on standby');
      told = true;
    } catch (e) {
      log.warn(`Could not reach the database for the jobs lock: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export async function releaseJobsLock() {
  const c = holder;
  holder = null;
  await c?.end().catch(() => undefined);
}
