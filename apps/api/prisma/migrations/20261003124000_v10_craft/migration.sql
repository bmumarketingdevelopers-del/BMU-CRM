-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT;

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "specialty" TEXT;

-- CreateTable
CREATE TABLE "craft_hooks" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clientOrgId" TEXT,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "craft_hooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "craft_scripts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "deliverableId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "submittedVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "craft_scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "craft_checklists" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "deliverableId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "craft_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "craft_brand_kits" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clientOrgId" TEXT NOT NULL,
    "colours" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fonts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "craft_brand_kits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "craft_hooks_orgId_userId_idx" ON "craft_hooks"("orgId", "userId");

-- CreateIndex
CREATE INDEX "craft_scripts_orgId_authorId_idx" ON "craft_scripts"("orgId", "authorId");

-- CreateIndex
CREATE UNIQUE INDEX "craft_checklists_deliverableId_kind_key" ON "craft_checklists"("deliverableId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "craft_brand_kits_clientOrgId_key" ON "craft_brand_kits"("clientOrgId");

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'normal';

-- CreateTable
CREATE TABLE "craft_client_notes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clientOrgId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "remindAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "craft_client_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "craft_client_notes_orgId_clientOrgId_idx" ON "craft_client_notes"("orgId", "clientOrgId");

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "specialty" TEXT;
