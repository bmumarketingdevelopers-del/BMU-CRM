-- v54: a QC reviewer picked when a task is assigned; the task counts as done only once QC passes.
ALTER TABLE "tasks" ADD COLUMN "qcReviewerId" TEXT;
ALTER TABLE "tasks" ADD COLUMN "qcState" TEXT;
ALTER TABLE "tasks" ADD COLUMN "qcNote" TEXT;
ALTER TABLE "tasks" ADD COLUMN "qcAt" TIMESTAMP(3);
CREATE INDEX "tasks_orgId_qcReviewerId_status_idx" ON "tasks"("orgId", "qcReviewerId", "status");

CREATE TABLE "task_qc_reviews" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "result" "QcOutcome" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_qc_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "task_qc_reviews_taskId_createdAt_idx" ON "task_qc_reviews"("taskId", "createdAt");
