-- v40 project flow: finish dates from Department Heads (shared with the client) and finished parts the client approves
-- or asks changes for. Additive only.
CREATE TABLE IF NOT EXISTS "project_estimates" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "headId" TEXT,
    "requestedById" TEXT,
    "requestNote" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishBy" DATE,
    "headNote" TEXT,
    "estimatedAt" TIMESTAMP(3),
    "estimatedById" TEXT,
    "sharedAt" TIMESTAMP(3),
    "sharedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_estimates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_estimates_engagementId_departmentId_key" ON "project_estimates"("engagementId", "departmentId");
CREATE INDEX IF NOT EXISTS "project_estimates_orgId_headId_idx" ON "project_estimates"("orgId", "headId");

CREATE TABLE IF NOT EXISTS "project_milestones" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "clientOrgId" TEXT NOT NULL,
    "departmentId" TEXT,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "fileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'shared',
    "sharedById" TEXT,
    "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "clientComment" TEXT,
    "changeTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_milestones_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "project_milestones_engagementId_idx" ON "project_milestones"("engagementId");
CREATE INDEX IF NOT EXISTS "project_milestones_clientOrgId_status_idx" ON "project_milestones"("clientOrgId", "status");
