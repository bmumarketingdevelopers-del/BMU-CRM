-- v50 (additive): Raise an issue with HR. One row per concern a team member brings to HR.
CREATE TABLE "hr_issues" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "response" TEXT,
    "handledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "hr_issues_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "hr_issues_orgId_status_idx" ON "hr_issues"("orgId", "status");
CREATE INDEX "hr_issues_userId_idx" ON "hr_issues"("userId");
