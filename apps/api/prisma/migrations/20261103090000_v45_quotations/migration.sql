-- v45 quotations and quotation templates. Additive only.
CREATE TABLE IF NOT EXISTS "quotations" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clientOrgId" TEXT NOT NULL,
    "engagementId" TEXT,
    "templateId" TEXT,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "content" JSONB NOT NULL,
    "preparedFor" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subtotalPaise" INTEGER NOT NULL,
    "gstPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "gstRatePct" DOUBLE PRECISION NOT NULL DEFAULT 18,
    "validUntil" DATE NOT NULL,
    "createdById" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "acceptedName" TEXT,
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "advanceInvoiceId" TEXT,
    "balanceInvoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "quotations_orgId_number_key" ON "quotations"("orgId", "number");
CREATE INDEX IF NOT EXISTS "quotations_orgId_clientOrgId_idx" ON "quotations"("orgId", "clientOrgId");

CREATE TABLE IF NOT EXISTS "quote_templates" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serviceKey" TEXT,
    "content" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "quote_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "quote_templates_orgId_idx" ON "quote_templates"("orgId");
