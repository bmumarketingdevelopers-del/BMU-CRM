-- AlterTable
ALTER TABLE "users" ADD COLUMN     "weeklyHours" INTEGER NOT NULL DEFAULT 45;

-- CreateTable
CREATE TABLE "invoice_schedules" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clientOrgId" TEXT NOT NULL,
    "engagementId" TEXT,
    "label" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "dueOn" DATE NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'milestone',
    "status" TEXT NOT NULL DEFAULT 'planned',
    "invoiceId" TEXT,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_links" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'test',
    "externalId" TEXT,
    "shortUrl" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "paidAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unmatched_payments" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "payerName" TEXT,
    "payerEmail" TEXT,
    "payerPhone" TEXT,
    "note" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceId" TEXT,
    "matchedById" TEXT,
    "matchedAt" TIMESTAMP(3),
    "ignoredAt" TIMESTAMP(3),

    CONSTRAINT "unmatched_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'expense',
    "category" TEXT NOT NULL,
    "vendorName" TEXT,
    "billNumber" TEXT,
    "description" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "dueDate" DATE,
    "amountPaise" INTEGER NOT NULL,
    "gstPaise" INTEGER NOT NULL DEFAULT 0,
    "tdsPaise" INTEGER NOT NULL DEFAULT 0,
    "clientOrgId" TEXT,
    "engagementId" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT false,
    "invoiceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "receiptFileId" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidRef" TEXT,
    "createdById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_timers" (
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "taskId" TEXT,
    "engagementId" TEXT,
    "note" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_timers_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "resource_bookings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "userId" TEXT,
    "specialty" TEXT,
    "weekStart" DATE NOT NULL,
    "hours" INTEGER NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'booked',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_schedules_orgId_status_dueOn_idx" ON "invoice_schedules"("orgId", "status", "dueOn");

-- CreateIndex
CREATE INDEX "invoice_schedules_clientOrgId_idx" ON "invoice_schedules"("clientOrgId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_links_token_key" ON "payment_links"("token");

-- CreateIndex
CREATE UNIQUE INDEX "payment_links_externalId_key" ON "payment_links"("externalId");

-- CreateIndex
CREATE INDEX "payment_links_invoiceId_idx" ON "payment_links"("invoiceId");

-- CreateIndex
CREATE INDEX "unmatched_payments_orgId_matchedAt_idx" ON "unmatched_payments"("orgId", "matchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "unmatched_payments_orgId_provider_ref_key" ON "unmatched_payments"("orgId", "provider", "ref");

-- CreateIndex
CREATE INDEX "expenses_orgId_kind_status_idx" ON "expenses"("orgId", "kind", "status");

-- CreateIndex
CREATE INDEX "expenses_clientOrgId_idx" ON "expenses"("clientOrgId");

-- CreateIndex
CREATE INDEX "expenses_engagementId_idx" ON "expenses"("engagementId");

-- CreateIndex
CREATE INDEX "resource_bookings_orgId_weekStart_idx" ON "resource_bookings"("orgId", "weekStart");

-- CreateIndex
CREATE INDEX "resource_bookings_userId_weekStart_idx" ON "resource_bookings"("userId", "weekStart");

-- CreateIndex
CREATE INDEX "resource_bookings_engagementId_idx" ON "resource_bookings"("engagementId");

