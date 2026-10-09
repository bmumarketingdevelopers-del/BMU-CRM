-- AlterEnum
ALTER TYPE "ProposalStatus" ADD VALUE 'superseded';

-- AlterTable
ALTER TABLE "engagements" ADD COLUMN     "renewalCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "renewedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "duplicateOfId" TEXT,
ADD COLUMN     "followUpNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "nextFollowUpAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "proposals" ADD COLUMN     "changeNote" TEXT,
ADD COLUMN     "discountStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'new',
ADD COLUMN     "lastViewedAt" TIMESTAMP(3),
ADD COLUMN     "renewalClientOrgId" TEXT,
ADD COLUMN     "renewalEngagementIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "rootId" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededById" TEXT,
ADD COLUMN     "viewCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "lead_activities" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "outcome" TEXT,
    "body" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextFollowUpAt" TIMESTAMP(3),
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_change_requests" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "byName" TEXT NOT NULL,
    "byEmail" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "revisionId" TEXT,

    CONSTRAINT "proposal_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_approval_steps" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "deciderId" TEXT,
    "note" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_activities_leadId_at_idx" ON "lead_activities"("leadId", "at");

-- CreateIndex
CREATE INDEX "proposal_change_requests_proposalId_idx" ON "proposal_change_requests"("proposalId");

-- CreateIndex
CREATE INDEX "discount_approval_steps_orgId_status_idx" ON "discount_approval_steps"("orgId", "status");

-- CreateIndex
CREATE INDEX "discount_approval_steps_proposalId_idx" ON "discount_approval_steps"("proposalId");

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_change_requests" ADD CONSTRAINT "proposal_change_requests_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_approval_steps" ADD CONSTRAINT "discount_approval_steps_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
