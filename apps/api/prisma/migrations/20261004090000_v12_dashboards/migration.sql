-- CreateTable
CREATE TABLE "dashboards" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "builtin" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "surface" TEXT NOT NULL DEFAULT 'team',
    "placement" TEXT NOT NULL DEFAULT 'menu',
    "audience" JSONB NOT NULL DEFAULT '{}',
    "layout" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "updatedById" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_versions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "placement" TEXT NOT NULL,
    "audience" JSONB NOT NULL,
    "layout" JSONB NOT NULL,
    "note" TEXT,
    "savedById" TEXT,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dashboards_orgId_archivedAt_idx" ON "dashboards"("orgId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "dashboards_orgId_key_key" ON "dashboards"("orgId", "key");

-- CreateIndex
CREATE INDEX "dashboard_versions_dashboardId_savedAt_idx" ON "dashboard_versions"("dashboardId", "savedAt");

-- AddForeignKey
ALTER TABLE "dashboard_versions" ADD CONSTRAINT "dashboard_versions_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
