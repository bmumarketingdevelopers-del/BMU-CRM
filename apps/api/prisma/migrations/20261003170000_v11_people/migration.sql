-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "workDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "workEnd" TEXT,
ADD COLUMN     "workStart" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "employmentType" TEXT,
ADD COLUMN     "joiningDate" DATE,
ADD COLUMN     "leftAt" TIMESTAMP(3),
ADD COLUMN     "photoUrl" TEXT;

-- CreateTable
CREATE TABLE "people_scheduled_changes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "byId" TEXT NOT NULL,
    "approvalRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "people_scheduled_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_pods" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amUserId" TEXT NOT NULL,
    "strategistUserId" TEXT,
    "producerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clientIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "client_pods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "people_scheduled_changes_orgId_status_effectiveDate_idx" ON "people_scheduled_changes"("orgId", "status", "effectiveDate");

-- CreateIndex
CREATE INDEX "people_scheduled_changes_userId_idx" ON "people_scheduled_changes"("userId");

-- CreateIndex
CREATE INDEX "client_pods_orgId_idx" ON "client_pods"("orgId");
