-- v21 backend runtime: process heartbeats for System health.
CREATE TABLE "runtime_processes" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "version" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "jobs" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "runtime_processes_pkey" PRIMARY KEY ("id")
);
