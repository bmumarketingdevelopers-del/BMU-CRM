-- v51 (additive): Custom charts. Extra org charts built from existing team members (chart only).
CREATE TABLE "org_charts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_charts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "org_chart_members" (
    "id" TEXT NOT NULL,
    "chartId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentUserId" TEXT,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_chart_members_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "org_charts_orgId_idx" ON "org_charts"("orgId");
CREATE UNIQUE INDEX "org_chart_members_chartId_userId_key" ON "org_chart_members"("chartId", "userId");
CREATE INDEX "org_chart_members_userId_idx" ON "org_chart_members"("userId");

ALTER TABLE "org_chart_members" ADD CONSTRAINT "org_chart_members_chartId_fkey" FOREIGN KEY ("chartId") REFERENCES "org_charts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
