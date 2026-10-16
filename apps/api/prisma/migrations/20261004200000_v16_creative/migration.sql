-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "ip" TEXT,
ADD COLUMN     "via" TEXT;

-- AlterTable
ALTER TABLE "client_orgs" ADD COLUMN     "publishNeedsApproval" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "carriedFromId" TEXT;

-- AlterTable
ALTER TABLE "craft_brand_kits" ADD COLUMN     "competitors" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "donts" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "dos" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "tone" TEXT;

-- AlterTable
ALTER TABLE "deliverables" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "publishDueNotifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "asset_collections" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clientOrgId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clientOrgId" TEXT,
    "collectionId" TEXT,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aiTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'upload',
    "deliverableId" TEXT,
    "clientVisible" BOOLEAN NOT NULL DEFAULT false,
    "currentVersionId" TEXT,
    "rightsNote" TEXT,
    "rightsExpireAt" TIMESTAMP(3),
    "creatorId" TEXT,
    "rightsWarnedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_versions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "fileId" TEXT NOT NULL,
    "note" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "received" BIGINT NOT NULL DEFAULT 0,
    "tmpPath" TEXT NOT NULL,
    "target" JSONB NOT NULL DEFAULT '{}',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_certificates" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "deliverableId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proof_links" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proof_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_channels" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clientOrgId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "url" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_metrics" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "deliverableId" TEXT NOT NULL,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "engagement" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spendPaise" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_collections_orgId_clientOrgId_idx" ON "asset_collections"("orgId", "clientOrgId");

-- CreateIndex
CREATE INDEX "assets_orgId_clientOrgId_idx" ON "assets"("orgId", "clientOrgId");

-- CreateIndex
CREATE INDEX "assets_orgId_updatedAt_idx" ON "assets"("orgId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "assets_deliverableId_key" ON "assets"("deliverableId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_versions_assetId_number_key" ON "asset_versions"("assetId", "number");

-- CreateIndex
CREATE INDEX "upload_sessions_userId_createdAt_idx" ON "upload_sessions"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "approval_certificates_code_key" ON "approval_certificates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "approval_certificates_versionId_key" ON "approval_certificates"("versionId");

-- CreateIndex
CREATE INDEX "approval_certificates_deliverableId_idx" ON "approval_certificates"("deliverableId");

-- CreateIndex
CREATE UNIQUE INDEX "proof_links_tokenHash_key" ON "proof_links"("tokenHash");

-- CreateIndex
CREATE INDEX "proof_links_versionId_idx" ON "proof_links"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "content_channels_clientOrgId_platform_handle_key" ON "content_channels"("clientOrgId", "platform", "handle");

-- CreateIndex
CREATE INDEX "post_metrics_deliverableId_createdAt_idx" ON "post_metrics"("deliverableId", "createdAt");

-- CreateIndex
CREATE INDEX "post_metrics_orgId_createdAt_idx" ON "post_metrics"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "asset_collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;