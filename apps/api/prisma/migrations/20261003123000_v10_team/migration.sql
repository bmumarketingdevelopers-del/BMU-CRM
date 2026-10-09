-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "decisionNote" TEXT,
ADD COLUMN     "managerDecidedAt" TIMESTAMP(3),
ADD COLUMN     "managerDecidedById" TEXT,
ADD COLUMN     "stage" TEXT NOT NULL DEFAULT 'manager';

-- AlterTable
ALTER TABLE "sops" ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'published';

-- CreateTable
CREATE TABLE "time_entries" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'task',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "taskId" TEXT,
    "engagementId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheets" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totalMinutes" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timesheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "people_processes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "startedById" TEXT NOT NULL,
    "buddyId" TEXT,
    "startDate" DATE,
    "lastDay" DATE,
    "items" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "completedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "people_processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sop_acknowledgements" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sopId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sop_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "time_entries_orgId_userId_date_idx" ON "time_entries"("orgId", "userId", "date");

-- CreateIndex
CREATE INDEX "time_entries_taskId_idx" ON "time_entries"("taskId");

-- CreateIndex
CREATE INDEX "timesheets_orgId_status_idx" ON "timesheets"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "timesheets_userId_weekStart_key" ON "timesheets"("userId", "weekStart");

-- CreateIndex
CREATE INDEX "people_processes_orgId_kind_status_idx" ON "people_processes"("orgId", "kind", "status");

-- CreateIndex
CREATE INDEX "people_processes_userId_idx" ON "people_processes"("userId");

-- CreateIndex
CREATE INDEX "sop_acknowledgements_userId_idx" ON "sop_acknowledgements"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sop_acknowledgements_sopId_userId_version_key" ON "sop_acknowledgements"("sopId", "userId", "version");
