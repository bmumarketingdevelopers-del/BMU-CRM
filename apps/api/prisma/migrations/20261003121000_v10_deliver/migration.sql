-- AlterTable
ALTER TABLE "client_orgs" ADD COLUMN     "approvalMode" TEXT NOT NULL DEFAULT 'any';

-- AlterTable
ALTER TABLE "cycles" ADD COLUMN     "carriedOver" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "invoiceId" TEXT,
ADD COLUMN     "startedBy" TEXT;

-- AlterTable
ALTER TABLE "deliverables" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "liveUrl" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "scheduledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "deliver_handover_items" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "deliver_handover_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliver_feedback" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "clientOrgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deliver_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deliver_handover_items_engagementId_idx" ON "deliver_handover_items"("engagementId");

-- CreateIndex
CREATE INDEX "deliver_feedback_clientOrgId_idx" ON "deliver_feedback"("clientOrgId");

-- CreateIndex
CREATE UNIQUE INDEX "deliver_feedback_engagementId_userId_key" ON "deliver_feedback"("engagementId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "cycles_engagementId_period_key" ON "cycles"("engagementId", "period");

