-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "CreatorBriefStatus" AS ENUM ('offered', 'accepted', 'declined', 'submitted', 'revision', 'approved', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('pending', 'paid', 'on_hold');

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "from" DATE NOT NULL,
    "to" DATE NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'casual',
    "reason" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'pending',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "gstPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_briefs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "clientOrgId" TEXT,
    "engagementId" TEXT,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "deliverables" TEXT[],
    "dueAt" TIMESTAMP(3),
    "feePaise" INTEGER NOT NULL,
    "status" "CreatorBriefStatus" NOT NULL DEFAULT 'offered',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_submissions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "fileId" TEXT,
    "url" TEXT,
    "note" TEXT,
    "feedback" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "approved" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_payouts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "briefId" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "tdsPaise" INTEGER NOT NULL DEFAULT 0,
    "netPaise" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "ref" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leave_requests_orgId_status_idx" ON "leave_requests"("orgId", "status");

-- CreateIndex
CREATE INDEX "leave_requests_userId_idx" ON "leave_requests"("userId");

-- CreateIndex
CREATE INDEX "credit_notes_invoiceId_idx" ON "credit_notes"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_orgId_number_key" ON "credit_notes"("orgId", "number");

-- CreateIndex
CREATE INDEX "creator_briefs_orgId_status_idx" ON "creator_briefs"("orgId", "status");

-- CreateIndex
CREATE INDEX "creator_briefs_creatorId_idx" ON "creator_briefs"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "creator_submissions_briefId_number_key" ON "creator_submissions"("briefId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "creator_payouts_briefId_key" ON "creator_payouts"("briefId");

-- CreateIndex
CREATE INDEX "creator_payouts_orgId_status_idx" ON "creator_payouts"("orgId", "status");

-- AddForeignKey
ALTER TABLE "creator_submissions" ADD CONSTRAINT "creator_submissions_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "creator_briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

