-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "migrated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "client_orgs" ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "healthOverriddenAt" TIMESTAMP(3),
ADD COLUMN     "healthOverriddenBy" TEXT,
ADD COLUMN     "healthReason" TEXT,
ADD COLUMN     "offboarding" JSONB,
ADD COLUMN     "paymentStatus" TEXT NOT NULL DEFAULT 'confirmed',
ADD COLUMN     "primaryContact" JSONB,
ADD COLUMN     "readOnlyUntil" TIMESTAMP(3),
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'proposal',
ADD COLUMN     "startMode" TEXT NOT NULL DEFAULT 'onboarding';

-- AlterTable
ALTER TABLE "engagements" ADD COLUMN     "migrated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "migrationReason" TEXT,
ADD COLUMN     "pauseReason" TEXT,
ADD COLUMN     "pauseState" JSONB,
ADD COLUMN     "pausedUntil" TIMESTAMP(3),
ADD COLUMN     "paymentPending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "startMonth" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "migrated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "requests" ADD COLUMN     "assigneeId" TEXT,
ADD COLUMN     "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "neededBy" TIMESTAMP(3),
ADD COLUMN     "raisedOnBehalf" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "client_service_quotes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clientOrgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "engagementId" TEXT,
    "serviceId" TEXT NOT NULL,
    "tier" "Tier" NOT NULL,
    "fromTier" "Tier",
    "startMonth" TEXT,
    "effective" TEXT NOT NULL DEFAULT 'next_cycle',
    "amountPaise" INTEGER NOT NULL DEFAULT 0,
    "monthlyDiffPaise" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "note" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedByClient" BOOLEAN NOT NULL DEFAULT false,
    "sentById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "invoiceId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "resultEngagementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_service_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_service_quotes_orgId_clientOrgId_idx" ON "client_service_quotes"("orgId", "clientOrgId");

-- CreateIndex
CREATE INDEX "client_service_quotes_invoiceId_idx" ON "client_service_quotes"("invoiceId");
