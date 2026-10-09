-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "actsForUserId" TEXT,
    "monthlyBudgetPaise" INTEGER NOT NULL DEFAULT 100000,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "lastRunAt" TIMESTAMP(3),
    "scannedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "subjectLabel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "mode" TEXT NOT NULL DEFAULT 'basic',
    "summary" TEXT,
    "answer" TEXT,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "notice" TEXT,
    "costPaise" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "aiLogId" TEXT,
    "actingUserId" TEXT,
    "startedById" TEXT,
    "error" TEXT,
    "feedback" INTEGER,
    "feedbackById" TEXT,
    "feedbackNote" TEXT,
    "isEval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_steps" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "tool" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "policy" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "link" TEXT,
    "undo" JSONB,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,
    "proposalId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_proposals" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "fields" JSONB NOT NULL DEFAULT '[]',
    "targetType" TEXT,
    "targetId" TEXT,
    "link" TEXT,
    "actingUserId" TEXT NOT NULL,
    "deciderIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "result" JSONB,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clientOrgId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "part" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "link" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_orgId_key_key" ON "agents"("orgId", "key");

-- CreateIndex
CREATE INDEX "agent_runs_orgId_createdAt_idx" ON "agent_runs"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_runs_agentId_createdAt_idx" ON "agent_runs"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_runs_subjectType_subjectId_idx" ON "agent_runs"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "agent_steps_runId_seq_idx" ON "agent_steps"("runId", "seq");

-- CreateIndex
CREATE INDEX "agent_proposals_orgId_status_idx" ON "agent_proposals"("orgId", "status");

-- CreateIndex
CREATE INDEX "agent_proposals_targetType_targetId_idx" ON "agent_proposals"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "knowledge_chunks_orgId_sourceType_idx" ON "knowledge_chunks"("orgId", "sourceType");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunks_sourceType_sourceId_part_key" ON "knowledge_chunks"("sourceType", "sourceId", "part");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
