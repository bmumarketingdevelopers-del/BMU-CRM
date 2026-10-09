-- AlterTable
ALTER TABLE "creators" ADD COLUMN     "city" TEXT,
ADD COLUMN     "handle" TEXT,
ADD COLUMN     "ratingCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedReason" TEXT,
ADD COLUMN     "engagementId" TEXT,
ADD COLUMN     "folder" TEXT NOT NULL DEFAULT 'general',
ADD COLUMN     "uploadedById" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "dueDateChanges" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "firstReplyAlertedAt" TIMESTAMP(3),
ADD COLUMN     "firstReplyAt" TIMESTAMP(3),
ADD COLUMN     "firstReplyDueAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "proofFileId" TEXT,
ADD COLUMN     "recordedById" TEXT;

-- AlterTable
ALTER TABLE "requests" ADD COLUMN     "sourceMessageId" TEXT;

-- AlterTable
ALTER TABLE "threads" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "participantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "ops_creator_ratings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "byId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_creator_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_share_links" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "passwordHash" TEXT,
    "createdById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "views" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_announcements" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "segment" TEXT,
    "channels" TEXT[],
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_integrations" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "clientOrgId" TEXT,
    "platform" TEXT,
    "accountName" TEXT,
    "connected" BOOLEAN NOT NULL DEFAULT true,
    "consentBy" TEXT,
    "consentAt" TIMESTAMP(3),
    "connectedById" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "disconnectedById" TEXT,

    CONSTRAINT "ops_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_creator_ratings_briefId_key" ON "ops_creator_ratings"("briefId");

-- CreateIndex
CREATE INDEX "ops_creator_ratings_creatorId_idx" ON "ops_creator_ratings"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "ops_share_links_token_key" ON "ops_share_links"("token");

-- CreateIndex
CREATE INDEX "ops_share_links_fileId_idx" ON "ops_share_links"("fileId");

-- CreateIndex
CREATE INDEX "ops_announcements_orgId_createdAt_idx" ON "ops_announcements"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "ops_integrations_orgId_key_idx" ON "ops_integrations"("orgId", "key");

-- CreateIndex
CREATE INDEX "ops_integrations_clientOrgId_idx" ON "ops_integrations"("clientOrgId");
