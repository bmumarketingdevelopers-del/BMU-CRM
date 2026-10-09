-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_clientOrgId_fkey";

-- AlterTable
ALTER TABLE "client_orgs" ADD COLUMN     "leadId" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'standard',
ADD COLUMN     "proposalId" TEXT,
ALTER COLUMN "clientOrgId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "proposals" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "bundleDiscountPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountApprovedById" TEXT,
ADD COLUMN     "discountNeedsApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "extraDiscountPct" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priceBookId" TEXT NOT NULL,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "viewedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "client_orgs_leadId_key" ON "client_orgs"("leadId");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_clientOrgId_fkey" FOREIGN KEY ("clientOrgId") REFERENCES "client_orgs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

