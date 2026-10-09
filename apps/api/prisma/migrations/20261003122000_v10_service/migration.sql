-- AlterTable
ALTER TABLE "client_orgs" ADD COLUMN     "billingEmail" TEXT,
ADD COLUMN     "legalName" TEXT,
ADD COLUMN     "placeOfSupply" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "period" TEXT;

-- AlterTable
ALTER TABLE "requests" ADD COLUMN     "ratedAt" TIMESTAMP(3),
ADD COLUMN     "ratedById" TEXT,
ADD COLUMN     "rating" INTEGER,
ADD COLUMN     "ratingComment" TEXT,
ADD COLUMN     "reopenCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reopenedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "thread_reads" (
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_reads_pkey" PRIMARY KEY ("threadId","userId")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId","kind")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "toEmail" TEXT NOT NULL,
    "toName" TEXT,
    "toUserId" TEXT,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'simulated',
    "error" TEXT,
    "entity" TEXT,
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_reminders" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "daysOverdue" INTEGER NOT NULL,
    "channels" TEXT[],
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_promises" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "promisedFor" DATE NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_promises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_runs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "issuedCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "totalPaise" INTEGER NOT NULL,
    "invoiceIds" TEXT[],
    "detail" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_outbox_orgId_createdAt_idx" ON "email_outbox"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "invoice_reminders_orgId_createdAt_idx" ON "invoice_reminders"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_reminders_invoiceId_step_key" ON "invoice_reminders"("invoiceId", "step");

-- CreateIndex
CREATE INDEX "payment_promises_invoiceId_idx" ON "payment_promises"("invoiceId");

-- CreateIndex
CREATE INDEX "billing_runs_orgId_createdAt_idx" ON "billing_runs"("orgId", "createdAt");
