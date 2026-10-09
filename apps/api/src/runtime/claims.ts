// v22 serverless: "first caller wins" markers in Postgres. A daily job used to remember in memory that it had run
// today; a serverless function forgets that on every start, so the marker lives in the cron_claims table instead.
// Raw SQL so a claim never publishes a change event.
import type { PrismaService } from '../prisma/prisma.service.js';

/** True for exactly one caller per key, across every process and restart. */
export async function claimOnce(prisma: PrismaService, key: string): Promise<boolean> {
  const n = await prisma.$executeRaw`INSERT INTO "cron_claims" ("key") VALUES (${key}) ON CONFLICT ("key") DO NOTHING`;
  return n === 1;
}

/** Drops markers older than `days` (they are only needed for a short while). */
export async function pruneClaims(prisma: PrismaService, days = 7) {
  await prisma.$executeRaw`DELETE FROM "cron_claims" WHERE "claimedAt" < NOW() - make_interval(days => ${days}::int)`;
}
