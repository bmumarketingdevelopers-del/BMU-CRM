-- v22 serverless: once-only markers for cron calls and daily jobs (see src/runtime/claims.ts).
CREATE TABLE "cron_claims" (
    "key" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cron_claims_pkey" PRIMARY KEY ("key")
);
