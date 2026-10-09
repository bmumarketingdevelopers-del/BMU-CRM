-- CreateTable
CREATE TABLE "feature_flags" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_failures" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "subscriber" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "entity" TEXT,
    "event" JSONB NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'retrying',
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_docs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "keywords" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_docs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_orgId_key_key" ON "feature_flags"("orgId", "key");

-- CreateIndex
CREATE INDEX "event_failures_status_nextAttemptAt_idx" ON "event_failures"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "search_docs_orgId_kind_idx" ON "search_docs"("orgId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "search_docs_kind_entityId_key" ON "search_docs"("kind", "entityId");
